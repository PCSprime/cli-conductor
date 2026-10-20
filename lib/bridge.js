'use strict';
// Bridge core: on-disk message format shared with tools/cli_conductor_send.ps1
// (outbox/*.json CliConductorMessage/v1, inbox/<ROLE>, events.jsonl, state.json,
// heartbeat.json, PAUSE). Delivery goes into each role's PTY instead of a window.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');

const sha256File = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const now = () => new Date().toISOString();
const ROLE_RE = /^[A-Z][A-Z0-9_]{0,31}$/;
const TAG = 'CLIConductor'; // header tag of bridged messages

class Bridge extends EventEmitter {
  // roles: { NAME: { delivery: immediate|after_turn|archive_only, send_policy, session|null, briefing?: string, briefSkip?: 'resume'|'off' } }
  // A non-empty briefing is written once, when the session is first idle, before any bridged message.
  // briefSkip (set by the server) records why a role gets none: it resumes an earlier conversation, or it is off.
  constructor({ workspace, stateDir, roles, sendScript, configPath, serverUrl = '', waitTurnEnd = false, maxPaste = 4096, pollMs = 1000 }) {
    super();
    this.workspace = path.resolve(workspace);
    this.stateDir = path.resolve(this.workspace, stateDir || '.tmp/cli_conductor');
    Object.assign(this, { roles, sendScript, configPath, serverUrl, waitTurnEnd, maxPaste, pollMs });
    this.p = {
      outbox: path.join(this.stateDir, 'outbox'), inbox: path.join(this.stateDir, 'inbox'),
      events: path.join(this.stateDir, 'events.jsonl'), state: path.join(this.stateDir, 'state.json'),
      heartbeat: path.join(this.stateDir, 'heartbeat.json'), pause: path.join(this.stateDir, 'PAUSE'),
    };
    this.busyDelivering = new Set();
    this.recent = [];
  }

  get roleNames() { return Object.keys(this.roles); }
  needsBriefing(n) { const r = this.roles[n]; return !!(r && r.session && r.delivery !== 'archive_only' && String(r.briefing || '').trim()); }
  briefingPending(n) { return this.briefed && !this.briefed.has(n); }
  rebrief(n) { if (this.briefed && this.needsBriefing(n)) this.briefed.delete(n); }
  // Manual 重发说明: send this text once more (even to a resumed role), with the usual idle rules.
  forceBrief(n, text) {
    const r = this.roles[n];
    if (!r || !r.session || r.delivery === 'archive_only') throw new Error(`ROLE_UNKNOWN:${n}`);
    if (!String(text || '').trim()) throw new Error(`BRIEFING_EMPTY:${n}`);
    r.briefing = String(text); delete r.briefSkip;
    if (!this.briefed) this.briefed = new Set();
    this.briefed.delete(n); this.manualBrief = this.manualBrief || new Set(); this.manualBrief.add(n);
    this.event('BRIEFING_QUEUED', '', '', n, { manual: true, chars: r.briefing.length });
  }
  // sent | pending | resume | off
  briefingState(n) {
    const r = this.roles[n]; if (!r || !r.session) return 'off';
    if (this.briefingPending(n) && this.needsBriefing(n)) return 'pending';
    if (r.briefSkip) return r.briefSkip;
    return this.needsBriefing(n) ? 'sent' : 'off';
  }

  async deliverBriefings(deliveredThisPoll) {
    for (const n of this.roleNames) {
      if (!this.briefingPending(n)) continue;
      const s = this.roles[n].session;
      if (s.state !== 'idle' || this.busyDelivering.has(n)) continue;
      this.busyDelivering.add(n); deliveredThisPoll.add(n);
      let res;
      try { res = await s.write(String(this.roles[n].briefing)); this.briefed.add(n); }
      catch (e) { this.event('BRIEFING_FAILED', '', '', n, { reason: e.message }); continue; }
      finally { this.busyDelivering.delete(n); }
      if (res && res.confirmed === false) { this.event('SUBMIT_UNCONFIRMED', '', '', n, { what: 'briefing', attempts: res.attempts }); continue; }
      const manual = !!(this.manualBrief && this.manualBrief.delete(n));
      this.event('BRIEFED', '', '', n, { chars: String(this.roles[n].briefing).length, transport: 'pty', attempts: res && res.attempts, ...(manual ? { manual } : {}) });
    }
  }

  start() {
    fs.mkdirSync(this.p.outbox, { recursive: true });
    for (const r of this.roleNames) fs.mkdirSync(path.join(this.p.inbox, r), { recursive: true });
    const ignored = fs.readdirSync(this.p.outbox).filter(f => f.endsWith('.json'));
    this.state = { schema: 'CliConductorState/v1', delivered: {}, uncertain: {}, rejected: {}, archived: {}, held: {}, submit_unconfirmed: {}, turn_seen: {}, ignored_at_startup: ignored };
    this.ignored = new Set(ignored);
    this.briefed = new Set(this.roleNames.filter(n => !this.needsBriefing(n)));
    this.saveState();
    this.writeConfig();
    this.event('FRESH_START', '', '', '', { ignored, backend: 'conpty-app' });
    for (const n of this.roleNames) if (this.roles[n].briefSkip) this.event('BRIEFING_SKIPPED', '', '', n, { reason: this.roles[n].briefSkip });
    this.timer = setInterval(() => this.poll().catch(e => this.emit('error', e)), this.pollMs);
    return this;
  }

  stop() { clearInterval(this.timer); }

  // Hot-add a role while the bridge is running (inbox + config + briefing bookkeeping).
  addRole(name, entry) {
    const n = String(name || '').trim().toUpperCase();
    if (!ROLE_RE.test(n)) throw new Error(`ROLE_NAME_INVALID:${n} (use UPPER_SNAKE_CASE)`);
    if (this.roles[n]) throw new Error(`ROLE_DUPLICATE:${n}`);
    this.roles[n] = entry;
    fs.mkdirSync(path.join(this.p.inbox, n), { recursive: true });
    if (!this.briefed) this.briefed = new Set();
    if (this.needsBriefing(n)) this.briefed.delete(n);
    else this.briefed.add(n);
    this.writeConfig();
    if (entry.briefSkip) this.event('BRIEFING_SKIPPED', '', '', n, { reason: entry.briefSkip, hotAdd: true });
    return n;
  }

  // Config compatible with lib/BridgeConfig.ps1 so agents can reply with cli_conductor_send.ps1.
  writeConfig() {
    if (!this.configPath) return;
    const roles = {};
    for (const [n, r] of Object.entries(this.roles)) {
      roles[n] = r.delivery === 'archive_only'
        ? { delivery: 'archive_only', send_policy: r.send_policy || 'immediate' }
        : { window: { title: `app-${n.toLowerCase()}`, match: 'exact' }, delivery: r.delivery === 'after_turn' ? 'immediate' : r.delivery, send_policy: 'immediate' };
    }
    const cfg = { schema: 'CliConductorConfig/v1', workspace: this.workspace.replace(/\\/g, '/'), state_dir: path.relative(this.workspace, this.stateDir).replace(/\\/g, '/') || '.tmp/cli_conductor', roles, delivery: { backend: 'conpty-app' } };
    // The send script POSTs here first (fast, validated); the outbox file queue is only its fallback.
    if (this.serverUrl) cfg.server = { url: this.serverUrl, header: 'x-cli-conductor' };
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, JSON.stringify(cfg, null, 2));
  }

  saveState() {
    const tmp = `${this.p.state}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.p.state);
  }

  event(kind, id, from, to, detail = {}) {
    const rec = { ts: now(), kind, message_id: id, from, to, detail };
    try { fs.appendFileSync(this.p.events, JSON.stringify(rec) + '\n'); } catch (e) { /* log must not block delivery */ }
    this.recent.push(rec); if (this.recent.length > 200) this.recent.shift();
    this.emit('event', rec);
    return rec;
  }

  heartbeat() {
    const hb = { pid: process.pid, round_at: now(), backend: 'conpty-app', delivered: Object.keys(this.state.delivered).length, uncertain: Object.keys(this.state.uncertain).length, rejected: Object.keys(this.state.rejected).length, held: Object.keys(this.state.held).length };
    try { fs.writeFileSync(this.p.heartbeat, JSON.stringify(hb, null, 2)); } catch { }
    return hb;
  }

  insideWorkspace(p) {
    const r = path.resolve(p);
    const rel = path.relative(this.workspace, r);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  validate(msg) {
    for (const k of ['schema', 'message_id', 'from', 'to', 'message', 'reply_required', 'refs']) if (!(k in msg)) throw new Error(`MESSAGE_FIELD_MISSING:${k}`);
    if (msg.schema !== 'CliConductorMessage/v1') throw new Error('MESSAGE_SCHEMA_INVALID');
    if (!this.roles[msg.from] || !this.roles[msg.to] || msg.from === msg.to) throw new Error('MESSAGE_ROUTE_INVALID');
    if (typeof msg.message !== 'string' || !msg.message.trim()) throw new Error('MESSAGE_TEXT_EMPTY');
    if (typeof msg.reply_required !== 'boolean') throw new Error('MESSAGE_REPLY_REQUIRED_INVALID');
    for (const ref of [].concat(msg.refs || [])) {
      if (!ref) continue;
      const r = path.resolve(String(ref.path));
      if (!this.insideWorkspace(r)) throw new Error(`REF_ESCAPE:${r}`);
      if (!fs.existsSync(r) || !fs.statSync(r).isFile()) throw new Error(`REF_MISSING:${r}`);
      if (sha256File(r) !== String(ref.sha256).toLowerCase()) throw new Error(`REF_HASH_MISMATCH:${r}`);
    }
    return msg;
  }

  // Same file format as cli_conductor_send.ps1.
  enqueue({ from, to, message, refs = [], reply_required = true, client_key = '' }) {
    from = String(from).toUpperCase(); to = String(to).toUpperCase();
    if (!this.roles[from] || !this.roles[to] || from === to) throw new Error(`MESSAGE_ROUTE_INVALID: roles are ${this.roleNames.join(', ')}`);
    const refObjs = refs.filter(Boolean).map(p => {
      const r = path.resolve(this.workspace, p);
      if (!this.insideWorkspace(r)) throw new Error(`REF_ESCAPE:${r} (refs must be inside ${this.workspace})`);
      if (!fs.existsSync(r)) throw new Error(`REF_MISSING:${r}`);
      return { path: r, sha256: sha256File(r) };
    });
    if (client_key) {
      for (const f of fs.readdirSync(this.p.outbox).filter(f => f.endsWith('.json'))) {
        try { const m = JSON.parse(fs.readFileSync(path.join(this.p.outbox, f), 'utf8')); if (m.from === from && m.client_key === client_key) return { status: 'DUPLICATE', message_id: m.message_id, path: path.join(this.p.outbox, f) }; } catch { }
      }
    }
    const d = new Date(); const pad = (n, w = 2) => String(n).padStart(w, '0');
    const off = -d.getTimezoneOffset(); const offs = (off >= 0 ? '+' : '-') + pad(Math.floor(Math.abs(off) / 60)) + pad(Math.abs(off) % 60);
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${pad(d.getMilliseconds(), 3)}${offs}`;
    const id = `${stamp}-${from}-TO-${to}-${crypto.randomBytes(4).toString('hex')}`;
    const rec = { schema: 'CliConductorMessage/v1', message_id: id, from, to, message, reply_required: !!reply_required, refs: refObjs };
    if (client_key) rec.client_key = client_key;
    const final = path.join(this.p.outbox, id + '.json');
    const tmp = path.join(this.p.outbox, '.tmp-' + crypto.randomBytes(8).toString('hex'));
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2)); fs.renameSync(tmp, final);
    this.event('QUEUED', id, from, to, { path: final, sha256: sha256File(final) });
    return { status: 'QUEUED', message_id: id, path: final };
  }

  payload(msg, file) {
    const header = `[${TAG} ${msg.message_id} ${msg.from}->${msg.to}]`;
    const send = `pwsh -File "${this.sendScript}" -ConfigPath "${this.configPath}"`;
    const reply = msg.reply_required
      ? `When done, reply with: ${send} -From ${msg.to} -To ${msg.from} -Message "<text>" (or -MessagePath <UTF-8 file> for long text; optional -RefPath <file inside the workspace>; add -NoReply for a pure completion notice). It prints one line: QUEUED <id> or ERROR. Never hand-write or edit outbox JSON.`
      : 'No reply is required for this message. Do not create a return message.';
    const refs = (msg.refs || []).filter(Boolean).map(r => `- ${r.path} SHA256=${r.sha256}`).join('\n');
    let text = `${header}\n${msg.message}\n${refs ? 'Referenced files:\n' + refs + '\n' : ''}${reply}`;
    if (text.length > this.maxPaste) text = `${header}\nThis message is too long to paste. Full content: ${file} (SHA256=${sha256File(file)}). Read that UTF-8 JSON file, verify it, then follow its message and refs.\n${reply}`;
    return text;
  }

  hold(id, file, from, to, reason) {
    const h = this.state.held[id];
    if (h && h.reason === reason) return;
    this.state.held[id] = { path: file, held_at: now(), to, reason };
    this.saveState();
    this.event('HELD', id, from, to, { path: file, reason });
  }

  reject(name, file, id, reason) {
    this.state.rejected[name] = { path: file, rejected_at: now(), reason };
    this.saveState();
    this.event('REJECTED', id, '', '', { path: file, reason });
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      this.heartbeat();
      const paused = fs.existsSync(this.p.pause);
      if (paused !== !!this.paused) { this.paused = paused; this.event(paused ? 'PAUSED' : 'RESUMED', '', '', '', { path: this.p.pause }); }
      if (paused) return;
      const files = fs.readdirSync(this.p.outbox).filter(f => f.endsWith('.json')).sort();
      const deliveredThisPoll = new Set();
      await this.deliverBriefings(deliveredThisPoll);
      for (const name of files) {
        if (this.ignored.has(name) || this.state.rejected[name]) continue;
        const file = path.join(this.p.outbox, name);
        let msg, id = '';
        try { msg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); id = String(msg.message_id || ''); if (!id) throw new Error('MESSAGE_FIELD_MISSING:message_id'); }
        catch (e) { this.reject(name, file, id, e.message); continue; }
        const st = this.state;
        if (st.delivered[id] || st.uncertain[id] || st.archived[id] || st.submit_unconfirmed[id]) continue;
        try { this.validate(msg); } catch (e) { this.reject(name, file, id, e.message); continue; }
        const to = this.roles[msg.to], from = this.roles[msg.from];
        if (to.delivery === 'archive_only' || !to.session) {
          const dest = path.join(this.p.inbox, msg.to, name);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          if (!fs.existsSync(dest)) fs.copyFileSync(file, dest);
          fs.unlinkSync(file);
          delete st.held[id];
          st.archived[id] = { path: dest, archived_at: now(), to: msg.to, delivery_confirmed: false };
          this.saveState();
          this.event('ARCHIVED', id, msg.from, msg.to, { path: dest, delivery_confirmed: false });
          continue;
        }
        const s = to.session;
        if (s.state === 'restarting' || s.restarting) { this.hold(id, file, msg.from, msg.to, 'restarting'); continue; }
        if (s.state === 'offline') { this.hold(id, file, msg.from, msg.to, s.userStopped ? 'role_stopped' : 'target_offline'); continue; }
        if (s.state === 'attention') { this.hold(id, file, msg.from, msg.to, 'target_needs_attention'); continue; }
        if (s.state === 'starting') { this.hold(id, file, msg.from, msg.to, 'target_starting'); continue; }
        if (this.briefingPending(msg.to)) { this.hold(id, file, msg.from, msg.to, 'waiting_for_briefing'); continue; }
        const waitTurn = this.waitTurnEnd || to.delivery === 'after_turn' || (from && from.send_policy === 'after_turn');
        if (deliveredThisPoll.has(msg.to) || this.busyDelivering.has(msg.to)) { this.hold(id, file, msg.from, msg.to, 'one_delivery_per_poll'); continue; }
        if (waitTurn && s.state !== 'idle') { this.hold(id, file, msg.from, msg.to, 'waiting_for_turn_end'); continue; }
        // Deliver.
        st.uncertain[id] = { path: file, marked_at: now() };
        this.saveState();
        this.event('UNCERTAIN', id, msg.from, msg.to, { path: file, delivery_confirmed: false });
        this.busyDelivering.add(msg.to); deliveredThisPoll.add(msg.to);
        let res;
        try { res = await s.write(this.payload(msg, file)); }
        finally { this.busyDelivering.delete(msg.to); }
        delete st.uncertain[id]; delete st.held[id];
        if (res && res.confirmed === false) {
          // Typed into the PTY but the CLI never started: needs a human to press Enter. Never resent.
          st.submit_unconfirmed[id] = { path: file, at: now(), to: msg.to, attempts: res.attempts };
          this.saveState();
          this.event('SUBMIT_UNCONFIRMED', id, msg.from, msg.to, { path: file, attempts: res.attempts });
          continue;
        }
        st.delivered[id] = { path: file, delivered_at: now(), to: msg.to, delivery_confirmed: false };
        this.saveState();
        this.event('DELIVERED', id, msg.from, msg.to, { path: file, delivery_confirmed: false, submit_confirmed: !!(res && res.confirmed), attempts: res && res.attempts, transport: 'pty' });
      }
    } finally { this.polling = false; }
  }

  setPaused(on) {
    if (on) fs.writeFileSync(this.p.pause, 'paused from web UI'); else if (fs.existsSync(this.p.pause)) fs.unlinkSync(this.p.pause);
  }

  status() {
    const st = this.state || {};
    let pending = 0; try { pending = fs.readdirSync(this.p.outbox).filter(f => f.endsWith('.json') && !this.ignored.has(f) && !st.rejected[f]).filter(f => { const id = f.slice(0, -5); return !(st.delivered || {})[id] && !(st.uncertain || {})[id] && !(st.submit_unconfirmed || {})[id]; }).length; } catch { }
    return {
      workspace: this.workspace, stateDir: this.stateDir, configPath: this.configPath, paused: fs.existsSync(this.p.pause), waitTurnEnd: this.waitTurnEnd,
      counts: { delivered: Object.keys(st.delivered || {}).length, held: Object.keys(st.held || {}).length, rejected: Object.keys(st.rejected || {}).length, archived: Object.keys(st.archived || {}).length, uncertain: Object.keys(st.uncertain || {}).length, unconfirmed: Object.keys(st.submit_unconfirmed || {}).length, outbox: pending },
      held: Object.entries(st.held || {}).map(([id, h]) => ({ id, ...h })),
    };
  }
}

module.exports = { Bridge, ROLE_RE, TAG, sha256File };