'use strict';
// One role = one CLI in its own ConPTY, mirrored into a headless xterm for screen checks.
const EventEmitter = require('events');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const { resolveSpawn } = require('./scanner');
const { detectFirstRun } = require('./adapters');

const RING_MAX = 256 * 1024;

class RoleSession extends EventEmitter {
  constructor({ name, adapter, file, args = [], cwd, cols = 120, rows = 32, idleMs = 3000, readyIdleMs = 2500, submitDelayMs, submitVerifyMs = [4000, 5000, 6000], turnMaxWaitMs = 20000, minSubmitOutput = 64, env = {} }) {
    super();
    if (submitDelayMs == null) submitDelayMs = (adapter && adapter.submitDelayMs) || 300;
    Object.assign(this, { name, adapter, file, args, cwd, cols, rows, idleMs, readyIdleMs, submitDelayMs, submitVerifyMs, turnMaxWaitMs, minSubmitOutput, extraEnv: env });
    this.delivering = false;   // between paste and submit confirmation: no state transitions
    this.pendingTurn = false;  // a delivery was submitted and its turn has not ended yet
    this.turnStarted = false;  // busy (or, without a busy regex, output) seen since submit
    this.stickyAttention = null; // e.g. SUBMIT_UNCONFIRMED: held until a human types in the terminal
    this.outSinceSubmit = 0;
    this.state = 'offline';      // offline | starting | idle | busy | attention
    this.attention = null;
    this.ring = '';
    this.lastOut = 0;
    this.sawBusy = false;
    this.turns = 0;
    this.alive = false;
    this.restarting = false;  // stop + respawn in progress: state 'restarting', deliveries held
    this.userStopped = false; // stopped from the UI (停止此角色)
  }

  start() {
    const sp = resolveSpawn(this.file, this.args);
    const env = { ...process.env, ...this.extraEnv, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    this.head = new Terminal({ cols: this.cols, rows: this.rows, scrollback: 2000, allowProposedApi: true });
    this.pty = pty.spawn(sp.file, sp.args, { name: 'xterm-256color', cols: this.cols, rows: this.rows, cwd: this.cwd, env, useConpty: true });
    this.pid = this.pty.pid;
    this.alive = true;
    this.startedAt = Date.now();
    this.lastOut = Date.now();
    this.setState('starting');
    this.pty.onData(d => this.onData(d));
    this.pty.onExit(e => {
      this.exit = e;
      this.alive = false;
      clearInterval(this.timer);
      if (!this.restarting) { this.setState('offline'); this.emit('exit', e); }
      // Release the ConPTY (conhost) handles, otherwise they keep the process alive.
      const p = this.pty; setTimeout(() => { try { p.kill(); } catch { } }, 100);
    });
    this.timer = setInterval(() => this.tick(), 400);
    return this;
  }

  onData(d) {
    this.ring += d;
    if (this.ring.length > RING_MAX) this.ring = this.ring.slice(-RING_MAX);
    this.lastOut = Date.now();
    this.outSinceSubmit += d.length;
    if (this.head) this.head.write(d);
    this.emit('output', d);
  }

  setState(s, extra) {
    if (this.state === s) return;
    const prev = this.state;
    this.state = s;
    this.emit('state', { role: this.name, state: s, prev, ...extra });
  }

  screenLines() {
    if (!this.head) return [];
    const buf = this.head.buffer.active;
    const out = [];
    for (let i = 0; i < this.head.rows; i++) {
      const line = buf.getLine(buf.viewportY + i);
      out.push(line ? line.translateToString(true) : '');
    }
    return out;
  }

  screen() { return this.screenLines().join('\n'); }

  bottom(n = 12) {
    return this.screenLines().filter(l => l.trim()).slice(-n).join('\n');
  }

  isBusyScreen(text) { return (this.adapter.busyRe || []).some(re => re.test(text)); }

  tick() {
    if (this.state === 'offline' || this.restarting || this.delivering) return;
    if (this.stickyAttention) { this.attention = this.stickyAttention; this.setState('attention', { prompt: this.stickyAttention }); return; }
    const bottom = this.bottom();
    let prompt = detectFirstRun(bottom);
    // A human answered this exact prompt and the CLI has printed since: don't re-flag the stale text.
    if (prompt && this.ack && String(prompt) === this.ack.prompt && this.lastOut > this.ack.at) prompt = null;
    if (prompt) {
      this.attention = prompt;
      this.setState('attention', { prompt });
      return;
    }
    if (this.state === 'attention') this.attention = null;
    const quiet = Date.now() - this.lastOut;
    if (this.isBusyScreen(bottom)) { this.sawBusy = true; this.turnStarted = true; this.setState('busy'); return; }
    if (this.pendingTurn && !this.hasBusyRe() && this.outSinceSubmit >= this.minSubmitOutput) this.turnStarted = true;
    // Turn end = working line gone + output idle for idleMs.
    if (this.state === 'starting' && quiet >= this.readyIdleMs) { this.setState('idle'); return; }
    if ((this.state === 'busy' || this.state === 'attention') && quiet >= this.idleMs) {
      // After a delivery, a turn only ends once it was seen to start (or the max wait passed with output).
      if (this.state === 'busy' && this.pendingTurn && !this.turnStarted && !(Date.now() - this.submitAt >= this.turnMaxWaitMs && this.outSinceSubmit > 0)) return;
      const wasTurn = this.state === 'busy';
      this.setState('idle');
      if (wasTurn) { this.turns++; this.emit('turn_end', { role: this.name, turns: this.turns, sawBusy: this.sawBusy }); }
      this.sawBusy = false; this.pendingTurn = false; this.turnStarted = false;
    }
  }

  hasBusyRe() { return (this.adapter.busyRe || []).length > 0; }
  // Did the CLI start processing since the last submit? Busy line on screen, or (without a
  // busy regex) a meaningful amount of output after the submit.
  submitSeen() {
    if (this.isBusyScreen(this.bottom())) return true;
    return !this.hasBusyRe() && this.outSinceSubmit >= this.minSubmitOutput;
  }

  // Delivery: bracketed paste keeps multi-line text as one prompt, then \r submits.
  // The submit is verified: if the CLI does not start within submitVerifyMs[i], \r is resent
  // (up to submitVerifyMs.length - 1 retries). Resolves { confirmed, attempts }.
  async write(text) {
    if (this.restarting) throw new Error(`ROLE_RESTARTING:${this.name}`);
    if (!this.pty || this.state === 'offline') throw new Error(`ROLE_OFFLINE:${this.name}`);
    const body = String(text).replace(/\r\n?/g, '\n');
    const wait = ms => new Promise(r => setTimeout(r, ms));
    this.delivering = true;
    try {
      this.pty.write(`\x1b[200~${body}\x1b[201~`);
      this.lastOut = Date.now();
      await wait(this.submitDelayMs);
      this.pendingTurn = true; this.turnStarted = false; this.sawBusy = false;
      for (let i = 0; i < this.submitVerifyMs.length; i++) {
        if (!this.pty || this.state === 'offline') throw new Error(`ROLE_OFFLINE:${this.name}`);
        this.outSinceSubmit = 0; this.submitAt = Date.now();
        this.pty.write('\r');
        this.lastOut = Date.now();
        const t0 = Date.now();
        while (Date.now() - t0 < this.submitVerifyMs[i]) {
          await wait(100);
          if (this.submitSeen()) {
            this.turnStarted = true; if (this.isBusyScreen(this.bottom())) this.sawBusy = true;
            this.setState('busy');
            return { confirmed: true, attempts: i + 1 };
          }
        }
        this.emit('submit_retry', { role: this.name, attempt: i + 1 });
      }
      this.pendingTurn = false;
      this.stickyAttention = 'SUBMIT_UNCONFIRMED';
      this.attention = this.stickyAttention;
      this.setState('attention', { prompt: this.stickyAttention });
      return { confirmed: false, attempts: this.submitVerifyMs.length };
    } finally { this.delivering = false; }
  }

  input(data) {
    if (!this.pty || this.state === 'offline' || this.restarting) return;
    if (this.stickyAttention) { this.stickyAttention = null; this.ack = null; this.lastOut = Date.now(); if (/\r/.test(data)) { this.pendingTurn = true; this.turnStarted = false; this.outSinceSubmit = 0; this.submitAt = Date.now(); } }
    if (this.state === 'attention' && this.attention) this.ack = { prompt: String(this.attention), at: Date.now() };
    this.pty.write(data);
  }

  resize(cols, rows) {
    cols = Math.max(20, Math.min(400, cols | 0)); rows = Math.max(5, Math.min(200, rows | 0));
    if (!this.pty || this.state === 'offline' || (cols === this.cols && rows === this.rows)) return;
    this.cols = cols; this.rows = rows;
    try { this.pty.resize(cols, rows); this.head.resize(cols, rows); } catch { /* exited */ }
  }

  // Graceful: type the adapter's exit command, force-kill after graceMs, then wait for the exit.
  async stop(graceMs = 5000) {
    if (!this.pty || !this.alive) { clearInterval(this.timer); return; }
    try { if (this.adapter.exit) this.pty.write(this.adapter.exit + '\r'); } catch { }
    const t0 = Date.now();
    while (this.alive && Date.now() - t0 < graceMs) await new Promise(r => setTimeout(r, 100));
    if (this.alive) {
      try { this.pty.kill(); } catch { }
      const t1 = Date.now();
      while (this.alive && Date.now() - t1 < 3000) await new Promise(r => setTimeout(r, 100));
      this.alive = false;
    }
    clearInterval(this.timer);
  }

  resetRuntime() {
    Object.assign(this, { delivering: false, pendingTurn: false, turnStarted: false, stickyAttention: null, attention: null, ack: null, sawBusy: false, outSinceSubmit: 0 });
  }

  // Single-CLI restart: same file/args/cwd/env. Deliveries are held (state 'restarting') until
  // the new process is idle again; the bridge then delivers as usual.
  async restart(graceMs = 5000) {
    if (this.restarting) throw new Error(`ROLE_RESTARTING:${this.name}`);
    this.restarting = true;
    this.setState('restarting');
    try { await this.stop(graceMs); }
    finally {
      this.resetRuntime(); this.userStopped = false; this.ring = ''; this.exit = null;
      this.emit('reset');
      this.restarting = false;
      this.state = 'offline';
      this.start();
    }
    return this;
  }

  info() {
    return { name: this.name, adapter: this.adapter.id, label: this.adapter.label, state: this.state, stopped: this.userStopped, attention: this.attention, pid: this.pid, turns: this.turns, file: this.file, args: this.args, cwd: this.cwd };
  }
}

module.exports = { RoleSession };