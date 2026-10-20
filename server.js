#!/usr/bin/env node
'use strict';
// CLI Conductor: local-only HTTP + WebSocket server.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const { BUILTIN, compile } = require('./lib/adapters');
const { scan, splitArgs } = require('./lib/scanner');
const { RoleSession } = require('./lib/session');
const { Bridge, ROLE_RE, TAG } = require('./lib/bridge');
const briefing = require('./lib/briefing');
const uistate = require('./lib/uistate');
const folderpicker = require('./lib/folderpicker');
const cliflags = require('./lib/cliflags');
const accounts = require('./lib/accounts');

const ROOT = __dirname;
const REPO = ROOT;
const STATE_SUBDIR = path.join('.tmp', 'cli_conductor'), SEND_SCRIPT = path.join(REPO, 'tools', 'cli_conductor_send.ps1');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const VENDOR = {
  '/vendor/xterm.js': '@xterm/xterm/lib/xterm.js', '/vendor/xterm.css': '@xterm/xterm/css/xterm.css', '/vendor/addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js',
  '/briefing.js': './lib/briefing.js', // shared with the UI (preview of the opening briefing)
};

// Opens a folder in the OS file manager (Explorer on Windows). Fire and forget.
function defaultOpenFolder(dir) {
  const { spawn } = require('child_process');
  const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  try { const c = spawn(cmd, [dir], { detached: true, stdio: 'ignore', windowsHide: false }); c.on('error', () => { }); c.unref(); } catch { }
}

// User data (ui.json, adapters.json, presets.json, accounts/) lives in %USERPROFILE%\.cli-conductor;
// CC_DATA_DIR overrides it.
function defaultDataDir() { return process.env.CC_DATA_DIR || path.join(require('os').homedir(), '.cli-conductor'); }
function createApp({ port = 7430, host = '127.0.0.1', dataDir = defaultDataDir(), log = console.log, pickFolder = folderpicker.pickFolder, accountsDir = accounts.defaultRoot(), openFolder = defaultOpenFolder } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  let listenPort = port;
  const files = { adapters: path.join(dataDir, 'adapters.json'), presets: path.join(dataDir, 'presets.json'), ui: path.join(dataDir, 'ui.json') };
  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2));

  let picking = false;
  let run = null; // { bridge, sessions: {NAME: RoleSession}, roles, startedAt }
  const sockets = new Set();
  const broadcast = msg => { const s = JSON.stringify(msg); for (const ws of sockets) if (ws.readyState === 1) ws.send(s); };

  const logins = {}; // LOGIN id -> RoleSession (account login terminals, independent of the bridge)
  const allAdapters = () => [...BUILTIN, ...readJson(files.adapters, []).map(a => ({ ...a, custom: true }))];

  function statusPayload() {
    if (!run) return { running: false };
    return { running: true, startedAt: run.startedAt, roles: run.roles.map(r => ({ ...r, ...(run.sessions[r.name] ? run.sessions[r.name].info() : { state: 'archive' }), briefingState: run.bridge.briefingState(r.name) })), bridge: run.bridge.status(), events: run.bridge.recent.slice(-60) };
  }

  // ---------- opening briefing (global dispatch briefing + duty + extra notes) ----------
  // rn: { workspace, roles: [{name,type}], brief: { global, lang, send, file, cfg: { NAME: { duty, briefOn, extra } } } }
  const briefRoleCfg = r => ({ duty: String(r.duty || '').trim(), briefOn: r.briefOn !== false, extra: String(r.briefing || '') });
  function briefUpdate(rn, b) {
    if (typeof b.globalBriefing === 'string') rn.brief.global = b.globalBriefing;
    if (b.lang === 'zh' || b.lang === 'en') rn.brief.lang = b.lang;
  }
  const briefCtx = rn => ({ global: rn.brief.global, lang: rn.brief.lang, workspace: rn.workspace, send: rn.brief.send, briefingFile: rn.brief.file, roles: rn.roles.map(r => ({ name: r.name, type: r.type, duty: (rn.brief.cfg[r.name] || {}).duty || '' })) });
  // { text } = send on first idle; { skip: 'resume'|'off' } = none; {} = nothing configured.
  function briefingPlan(rn, name, resumes) {
    const c = rn.brief.cfg[name] || briefRoleCfg({});
    if (!c.briefOn) return { skip: 'off' };
    const text = briefing.composeBriefing(briefCtx(rn), { name, duty: c.duty, extra: c.extra });
    if (!text) return {};
    return resumes ? { skip: 'resume' } : { text };
  }
  function writeBriefingFile(rn, bridge) {
    if (!String(rn.brief.global || '').trim()) return;
    try { fs.mkdirSync(path.dirname(rn.brief.file), { recursive: true }); fs.writeFileSync(rn.brief.file, briefing.briefingFileText(briefCtx(rn), new Date().toISOString())); }
    catch (e) { bridge.event('BRIEFING_FILE_FAILED', '', '', '', { path: rn.brief.file, reason: e.message }); }
  }

  async function start(body) {
    if (run) throw new Error('ALREADY_RUNNING');
    const workspace = path.resolve(String(body.workspace || ''));
    if (!body.workspace || !fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) throw new Error(`WORKSPACE_MISSING:${workspace}`);
    const adapters = Object.fromEntries(scan(allAdapters()).map(a => [a.id, a]));
    const roles = (body.roles || []).filter(r => r.enabled !== false).map(r => ({ ...r, name: String(r.name || '').trim().toUpperCase() }));
    if (roles.length < 2) throw new Error('ROLES_INVALID: at least two enabled roles are required');
    const dups = accounts.duplicates(roles);
    if (dups.length && !body.allowDuplicateAccounts) throw new Error(`ACCOUNT_DUPLICATE:${dups.map(d => `${d.adapter}/${d.account}: ${d.roles.join(', ')}`).join('; ')}`);
    const seen = new Set();
    for (const r of roles) {
      if (!ROLE_RE.test(r.name)) throw new Error(`ROLE_NAME_INVALID:${r.name} (use UPPER_SNAKE_CASE)`);
      if (seen.has(r.name)) throw new Error(`ROLE_DUPLICATE:${r.name}`); seen.add(r.name);
      if (r.type !== 'observer') {
        const a = adapters[r.adapter]; if (!a) throw new Error(`ADAPTER_UNKNOWN:${r.adapter}`);
        if (!a.path) throw new Error(`ADAPTER_NOT_FOUND:${r.adapter} (not on PATH; add it manually with a full path)`);
        const cwd = path.resolve(workspace, r.cwd || '.');
        if (!fs.existsSync(cwd)) throw new Error(`CWD_MISSING:${r.name}=${cwd}`);
      }
    }
    const sessions = {}; const bridgeRoles = {};
    for (const r of roles) {
      if (r.type === 'observer') { bridgeRoles[r.name] = { delivery: 'archive_only', send_policy: 'after_turn', session: null }; continue; }
      const a = compile(adapters[r.adapter]);
      const env = a.custom ? {} : accounts.supported(a.id) ? accounts.envFor(accountsDir, a.id, r.account) : {};
      const args = [...(a.custom || !accounts.supported(a.id) ? [] : accounts.argOverrides(a.id, r.account)), ...cliflags.buildArgs(a.custom ? '' : a.id, r.options, r.args, a.args || [])];
      const s = new RoleSession({ name: r.name, adapter: a, file: a.path, args, cwd: path.resolve(workspace, r.cwd || '.'), idleMs: body.idleMs || 3000, cols: 110, rows: 30, env });
      s.resumes = cliflags.isResume(a.custom ? '' : a.id, args);
      sessions[r.name] = s;
      bridgeRoles[r.name] = { delivery: r.delivery === 'after_turn' ? 'after_turn' : 'immediate', send_policy: 'immediate', session: s };
    }
    const stateDir = path.join(workspace, STATE_SUBDIR);
    try { uistate.apply(files.ui, { addRecent: workspace }); } catch { }
    const configPath = path.join(stateDir, 'app.config.json'), sendScript = SEND_SCRIPT;
    // Briefing only for roles that start a NEW conversation; resumed ones already have it.
    const rn = { workspace, roles, brief: { global: '', lang: 'en', send: `pwsh -File "${sendScript}" -ConfigPath "${configPath}"`, file: path.join(stateDir, 'BRIEFING.md'), cfg: Object.fromEntries(roles.map(r => [r.name, briefRoleCfg(r)])) } };
    briefUpdate(rn, body);
    for (const r of roles) if (bridgeRoles[r.name].session) {
      const plan = briefingPlan(rn, r.name, sessions[r.name].resumes);
      if (plan.text) bridgeRoles[r.name].briefing = plan.text;
      if (plan.skip) bridgeRoles[r.name].briefSkip = plan.skip;
    }
    const bridge = new Bridge({ workspace, stateDir, roles: bridgeRoles, sendScript, configPath, serverUrl: `http://127.0.0.1:${listenPort}`, waitTurnEnd: !!body.waitTurnEnd, pollMs: body.pollMs || 1000 });
    bridge.on('event', e => broadcast({ type: 'event', event: e }));
    bridge.on('error', e => log('bridge error', e.message));
    bridge.start();
    writeBriefingFile(rn, bridge);
    for (const [name, s] of Object.entries(sessions)) {
      s.on('output', d => broadcast({ type: 'output', role: name, data: d }));
      s.on('state', st => { broadcast({ type: 'role', role: s.info() }); if (st.state === 'attention') bridge.event('ATTENTION', '', '', name, { prompt: st.prompt }); });
      s.on('turn_end', t => bridge.event('TURN_END', '', name, '', t));
      s.on('submit_retry', t => bridge.event('SUBMIT_RETRY', '', '', name, t));
      s.on('exit', e => bridge.event(s.userStopped ? 'ROLE_STOPPED' : 'ROLE_EXITED', '', name, '', e));
      s.on('reset', () => broadcast({ type: 'reset', role: name }));
      s.start();
      bridge.event('ROLE_STARTED', '', name, '', { pid: s.pid, file: s.file, args: s.args, cwd: s.cwd });
    }
    run = { bridge, sessions, roles: roles.map(r => ({ name: r.name, type: r.type || 'agent', adapter: r.adapter || null, account: r.account || '', delivery: bridgeRoles[r.name].delivery, briefing: !!bridgeRoles[r.name].briefing, duty: rn.brief.cfg[r.name].duty })), startedAt: new Date().toISOString(), idleMs: body.idleMs || 3000, workspace, brief: rn.brief };
    broadcast({ type: 'status', status: statusPayload() });
    return statusPayload();
  }

  async function stop() {
    if (!run) return { running: false };
    const r = run; run = null;
    r.bridge.stop();
    // One at a time: concurrent ConPTY exits can crash node-pty 1.1.0 (0xC0000005, microsoft/node-pty#922).
    for (const s of Object.values(r.sessions)) await s.stop();
    r.bridge.event('STOPPED', '', '', '', {});
    broadcast({ type: 'status', status: { running: false } });
    return { running: false };
  }

  const roleSession = name => { const s = run && run.sessions[String(name || '').toUpperCase()]; if (!s) throw new Error('ROLE_UNKNOWN'); return s; };
  // Single-CLI restart: wait for an in-flight delivery, graceful exit, force kill, respawn with the
  // same args/options/env. Messages to the role are held ('restarting') and delivered once it is ready.
  async function restartRole(name, { graceMs = 5000 } = {}) {
    const s = roleSession(name), r = run;
    if (s.restarting) throw new Error(`ROLE_RESTARTING:${s.name}`);
    r.bridge.event('ROLE_RESTARTING', '', s.name, '', { pid: s.pid });
    const t0 = Date.now();
    while (r.bridge.busyDelivering.has(s.name) && Date.now() - t0 < 20000) await new Promise(x => setTimeout(x, 100));
    await s.restart(graceMs);
    if (!s.resumes) { const plan = briefingPlan(r, s.name, false); if (plan.text) r.bridge.roles[s.name].briefing = plan.text; r.bridge.rebrief(s.name); }
    r.bridge.event('ROLE_RESTARTED', '', s.name, '', { pid: s.pid, file: s.file, args: s.args, cwd: s.cwd, rebrief: !s.resumes });
    return s.info();
  }
  async function stopRole(name) {
    const s = roleSession(name);
    s.userStopped = true;
    await s.stop();
    broadcast({ type: 'role', role: s.info() });
    return s.info();
  }

// Hot-add: spawn one more CLI into a running bridge (no full restart).
  function addRole(body = {}) {
    if (!run) throw new Error('NOT_RUNNING');
    const name = String(body.name || '').trim().toUpperCase();
    if (!ROLE_RE.test(name)) throw new Error(`ROLE_NAME_INVALID:${name} (use UPPER_SNAKE_CASE)`);
    if (run.sessions[name] || run.roles.some(r => r.name === name) || run.bridge.roles[name]) throw new Error(`ROLE_DUPLICATE:${name}`);
    const type = body.type === 'observer' ? 'observer' : 'agent';
    const workspace = run.workspace || run.bridge.workspace;
    const adapters = Object.fromEntries(scan(allAdapters()).map(a => [a.id, a]));
    let session = null, delivery = 'archive_only', briefingOn = false, accountWarning = '';
    briefUpdate(run, body);
    run.brief.cfg[name] = briefRoleCfg(body);
    if (type === 'observer') {
      run.bridge.addRole(name, { delivery: 'archive_only', send_policy: 'after_turn', session: null });
    } else {
      const adapterId = String(body.adapter || '');
      const a0 = adapters[adapterId]; if (!a0) throw new Error(`ADAPTER_UNKNOWN:${adapterId}`);
      if (!a0.path) throw new Error(`ADAPTER_NOT_FOUND:${adapterId} (not on PATH; add it manually with a full path)`);
      const cwd = path.resolve(workspace, body.cwd || '.');
      if (!fs.existsSync(cwd)) throw new Error(`CWD_MISSING:${name}=${cwd}`);
      // Same CLI+account is common (e.g. several Codex roles on default). Hot-add never blocks;
      // return accountWarning so the UI can show a quiet tip. Cold start still confirms in the UI.
      const probe = [...run.roles.map(r => ({ name: r.name, adapter: r.adapter, account: r.account || '', type: r.type, enabled: true })),
        { name, adapter: adapterId, account: body.account || '', type: 'agent', enabled: true }];
      const dups = accounts.duplicates(probe);
      accountWarning = dups.length
        ? dups.map(d => `${d.adapter}/${d.account}: ${d.roles.join(', ')}`).join('; ')
        : '';
      const a = compile(a0);
      const env = a.custom ? {} : accounts.supported(a.id) ? accounts.envFor(accountsDir, a.id, body.account) : {};
      const idleMs = run.idleMs || 3000;
      const args = [...(a.custom || !accounts.supported(a.id) ? [] : accounts.argOverrides(a.id, body.account)), ...cliflags.buildArgs(a.custom ? '' : a.id, body.options, body.args, a.args || [])];
      session = new RoleSession({
        name, adapter: a, file: a0.path,
        args, cwd, idleMs, cols: 110, rows: 30, env,
      });
      session.resumes = cliflags.isResume(a.custom ? '' : a.id, args);
      delivery = body.delivery === 'after_turn' ? 'after_turn' : 'immediate';
      const entry = { delivery, send_policy: 'immediate', session };
      const plan = briefingPlan(run, name, session.resumes);
      if (plan.text) { entry.briefing = plan.text; briefingOn = true; }
      if (plan.skip) entry.briefSkip = plan.skip;
      run.bridge.addRole(name, entry);
      // Session events can fire after stop() cleared run (exit during shutdown): keep this run's bridge.
      const hotBridge = run.bridge;
      session.on('output', d => broadcast({ type: 'output', role: name, data: d }));
      session.on('state', st => { broadcast({ type: 'role', role: session.info() }); if (st.state === 'attention') hotBridge.event('ATTENTION', '', '', name, { prompt: st.prompt }); });
      session.on('turn_end', t => hotBridge.event('TURN_END', '', name, '', t));
      session.on('submit_retry', t => hotBridge.event('SUBMIT_RETRY', '', '', name, t));
      session.on('exit', e => hotBridge.event(session.userStopped ? 'ROLE_STOPPED' : 'ROLE_EXITED', '', name, '', e));
      session.on('reset', () => broadcast({ type: 'reset', role: name }));
      run.sessions[name] = session;
      session.start();
      run.bridge.event('ROLE_STARTED', '', name, '', { pid: session.pid, file: session.file, args: session.args, cwd: session.cwd, hotAdd: true });
    }
    const meta = {
      name, type, adapter: type === 'observer' ? null : String(body.adapter || ''),
      account: body.account || '', delivery, briefing: briefingOn, duty: run.brief.cfg[name].duty,
    };
    run.roles.push(meta);
    if (String(run.brief.global || '').trim()) writeBriefingFile(run, run.bridge); // file only; running roles are not messaged
    const snap = statusPayload();
    if (typeof accountWarning === 'string' && accountWarning) snap.accountWarning = accountWarning;
    broadcast({ type: 'status', status: snap });
    // Also send a fresh PTY snapshot to any already-connected UI.
    if (session) broadcast({ type: 'snapshot', role: name, data: session.ring || '' });
    return snap;
  }
  // 重发说明: send the current briefing once more to one running role (ignores the switch; user asked).
  function rebriefRole(b = {}) {
    if (!run) throw new Error('NOT_RUNNING');
    const name = String(b.role || '').trim().toUpperCase();
    const s = run.sessions[name]; if (!s) throw new Error(`ROLE_UNKNOWN:${name}`);
    if (s.userStopped || s.state === 'offline') throw new Error(`ROLE_NOT_RUNNING:${name}`);
    briefUpdate(run, b);
    if (['duty', 'briefing', 'briefOn'].some(k => k in b)) run.brief.cfg[name] = briefRoleCfg({ ...run.brief.cfg[name], ...b, briefing: 'briefing' in b ? b.briefing : (run.brief.cfg[name] || {}).extra });
    const c = run.brief.cfg[name] || briefRoleCfg({});
    const text = briefing.composeBriefing(briefCtx(run), { name, duty: c.duty, extra: c.extra });
    if (!text) throw new Error(`BRIEFING_EMPTY:${name}`);
    const meta = run.roles.find(r => r.name === name); if (meta) meta.duty = c.duty;
    writeBriefingFile(run, run.bridge);
    run.bridge.forceBrief(name, text);
    broadcast({ type: 'status', status: statusPayload() });
    return { ok: true, role: name, chars: text.length };
  }
  function accountsPayload() { return { root: accountsDir, supported: accounts.capabilities(), accounts: accounts.list(accountsDir), logins: Object.values(logins).map(l => ({ id: l.name, cli: l.cli, account: l.account, state: l.state })) }; }
  // Login terminal: the CLI (or its documented login subcommand) with the account's env.
  async function startLogin({ cli, name }) {
    const st = accounts.status(accountsDir, cli, name);
    if (!st.exists) throw new Error(`ACCOUNT_MISSING:${cli}-${name}`);
    const a = scan(allAdapters()).find(x => x.id === cli && !x.custom);
    if (!a || !a.path) throw new Error(`ADAPTER_NOT_FOUND:${cli}`);
    const id = `LOGIN_${cli}_${name}`.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    if (logins[id] && logins[id].alive) return { id };
    const s = new RoleSession({ name: id, adapter: compile(a), file: a.path, args: [...accounts.argOverrides(cli, name), ...accounts.loginArgs(cli)], cwd: os.homedir(), cols: 100, rows: 28, env: accounts.envFor(accountsDir, cli, name) });
    s.cli = cli; s.account = name;
    s.on('output', d => broadcast({ type: 'output', role: id, data: d }));
    s.on('exit', () => broadcast({ type: 'login', id, state: 'exited', account: accounts.status(accountsDir, cli, name) }));
    logins[id] = s; s.start();
    return { id };
  }

  const api = {
    'GET /api/adapters': () => scan(allAdapters()),
    'POST /api/adapters': b => {
      const id = String(b.id || b.label || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
      if (!id || !b.command) throw new Error('ADAPTER_INVALID: id/label and command are required');
      if (BUILTIN.some(a => a.id === id)) throw new Error('ADAPTER_ID_TAKEN');
      for (const s of [].concat(b.busy || [])) new RegExp(s);
      const list = readJson(files.adapters, []).filter(a => a.id !== id);
      list.push({ id, label: b.label || id, commands: [b.command], busy: [].concat(b.busy || []).filter(Boolean), exit: b.exit || '/exit', args: splitArgs(b.args) });
      writeJson(files.adapters, list); return scan(allAdapters());
    },
    'DELETE /api/adapters': b => { writeJson(files.adapters, readJson(files.adapters, []).filter(a => a.id !== b.id)); return scan(allAdapters()); },
    'GET /api/presets': () => readJson(files.presets, {}),
    'POST /api/presets': b => { if (!b.name) throw new Error('PRESET_NAME_REQUIRED'); const p = readJson(files.presets, {}); p[b.name] = b.config; writeJson(files.presets, p); return p; },
    'DELETE /api/presets': b => { const p = readJson(files.presets, {}); delete p[b.name]; writeJson(files.presets, p); return p; },
    'GET /api/ui-state': () => uistate.load(files.ui),
    'POST /api/ui-state': b => uistate.apply(files.ui, b),
    'POST /api/pick-folder': async b => {
      if (picking) throw new Error('PICKER_BUSY');
      picking = true;
      try {
        const r = await pickFolder({ initial: b.initial || '' });
        if (r.path) uistate.apply(files.ui, { addRecent: r.path });
        return r;
      } finally { picking = false; }
    },
    'GET /api/cliflags': () => cliflags.allCapabilities(),
    'POST /api/preview-args': b => {
      const a = allAdapters().find(x => x.id === b.adapter) || {};
      const args = cliflags.buildArgs(a.custom ? '' : a.id, b.options, b.args, a.args || []);
      return { command: (a.commands || [b.adapter || ''])[0], args, resumes: cliflags.isResume(a.custom ? '' : a.id, args) };
    },
    'GET /api/status': () => statusPayload(),
    'POST /api/restart-role': b => { const s = roleSession(b.role); if (s.restarting) throw new Error(`ROLE_RESTARTING:${s.name}`); restartRole(s.name).catch(e => log('restart failed', e.message)); return { ok: true, role: s.name }; },
    'POST /api/stop-role': b => stopRole(b.role),
    'POST /api/add-role': b => addRole(b),
    'POST /api/rebrief': b => rebriefRole(b),
    'GET /api/accounts': () => accountsPayload(),
    'POST /api/accounts': b => { accounts.create(accountsDir, String(b.cli || ''), String(b.name || '').trim().toLowerCase()); return accountsPayload(); },
    'POST /api/open-account-folder': b => { const st = accounts.status(accountsDir, String(b.cli || ''), String(b.name || '')); if (!st.exists) throw new Error(`ACCOUNT_MISSING:${b.cli}-${b.name}`); openFolder(st.dir); return { ok: true, dir: st.dir }; },
    'POST /api/account-login': b => startLogin({ cli: String(b.cli || ''), name: String(b.name || '') }),
    'POST /api/account-login-stop': async b => { const s = logins[b.id]; if (s) { await s.stop(2000); delete logins[b.id]; } return accountsPayload(); },
    'GET /api/defaults': () => ({ workspace: process.cwd(), home: os.homedir(), platform: process.platform, briefing: { stateDir: STATE_SUBDIR, sendScript: SEND_SCRIPT, tag: TAG } }),
    'POST /api/start': b => start(b),
    'POST /api/stop': () => stop(),
    'POST /api/send': b => { if (!run) throw new Error('NOT_RUNNING'); return run.bridge.enqueue(b); },
    'POST /api/pause': b => { if (!run) throw new Error('NOT_RUNNING'); run.bridge.setPaused(!!b.paused); return statusPayload(); },
    'POST /api/input': b => { if (!run || !run.sessions[b.role]) throw new Error('ROLE_UNKNOWN'); run.sessions[b.role].input(String(b.data)); return { ok: true }; },
    'GET /api/screen': (_, q) => { if (!run || !run.sessions[q.get('role')]) throw new Error('ROLE_UNKNOWN'); return { screen: run.sessions[q.get('role')].screen() }; },
  };

  // Local-only: reject foreign Host/Origin (DNS rebinding / cross-site requests).
  const okHost = h => /^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(String(h || ''));
  const okOrigin = o => !o || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(o);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!okHost(req.headers.host) || !okOrigin(req.headers.origin)) { res.writeHead(403); return res.end('forbidden'); }
    const key = `${req.method} ${url.pathname}`;
    if (api[key]) {
      if (req.method !== 'GET' && req.headers['x-cli-conductor'] !== '1') { res.writeHead(403); return res.end('missing header'); }
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 1e6) break; }
      try {
        const out = await api[key](body ? JSON.parse(body) : {}, url.searchParams);
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
      } catch (e) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
      return;
    }
    let file = VENDOR[url.pathname] ? require.resolve(VENDOR[url.pathname]) : path.join(ROOT, 'public', url.pathname === '/' ? 'index.html' : url.pathname);
    if (!VENDOR[url.pathname] && !path.resolve(file).startsWith(path.join(ROOT, 'public'))) { res.writeHead(404); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(data);
    });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  server.on('upgrade', (req, sock, head) => {
    if (!okHost(req.headers.host) || !okOrigin(req.headers.origin) || !req.url.startsWith('/ws')) return sock.destroy();
    wss.handleUpgrade(req, sock, head, ws => {
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
      ws.send(JSON.stringify({ type: 'status', status: statusPayload() }));
      if (run) for (const [n, s] of Object.entries(run.sessions)) ws.send(JSON.stringify({ type: 'snapshot', role: n, data: s.ring }));
      ws.on('message', raw => {
        let m; try { m = JSON.parse(raw); } catch { return; }
        const s = (run && run.sessions[m.role]) || logins[m.role]; if (!s) return;
        if (m.type === 'input' && typeof m.data === 'string') s.input(m.data);
        if (m.type === 'resize') s.resize(m.cols, m.rows);
      });
    });
  });

  return {
    server, start, stop, restartRole, stopRole, addRole, status: statusPayload, get run() { return run; },
    listen: () => new Promise(r => server.listen(port, host, () => { const a = server.address(); listenPort = a.port; log(`cli-conductor on http://${host}:${a.port}`); r(a.port); })),
    close: async () => { await stop(); for (const s of Object.values(logins)) await s.stop(1000); for (const ws of sockets) ws.terminate(); await new Promise(r => server.close(r)); },
  };
}

module.exports = { createApp };

if (require.main === module) {
  const port = Number(process.env.CC_PORT || process.argv[2] || 7430);
  const app = createApp({ port });
  app.listen();
  const shutdown = async () => { console.log('stopping roles...'); await app.close(); process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}