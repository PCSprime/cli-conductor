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
const { Bridge, ROLE_RE } = require('./lib/bridge');
const { fillBriefing } = require('./lib/briefing');
const uistate = require('./lib/uistate');
const folderpicker = require('./lib/folderpicker');
const cliflags = require('./lib/cliflags');
const accounts = require('./lib/accounts');

const ROOT = __dirname;
const REPO = ROOT;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const VENDOR = {
  '/vendor/xterm.js': '@xterm/xterm/lib/xterm.js', '/vendor/xterm.css': '@xterm/xterm/css/xterm.css', '/vendor/addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js',
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
    return { running: true, startedAt: run.startedAt, roles: run.roles.map(r => ({ ...r, ...(run.sessions[r.name] ? run.sessions[r.name].info() : { state: 'archive' }) })), bridge: run.bridge.status(), events: run.bridge.recent.slice(-60) };
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
      const s = new RoleSession({ name: r.name, adapter: a, file: a.path, args: cliflags.buildArgs(a.custom ? '' : a.id, r.options, r.args, a.args || []), cwd: path.resolve(workspace, r.cwd || '.'), idleMs: body.idleMs || 3000, cols: 110, rows: 30, env });
      s.resumes = !!(r.options && r.options.resume && r.options.resume !== 'off');
      sessions[r.name] = s;
      bridgeRoles[r.name] = { delivery: r.delivery === 'after_turn' ? 'after_turn' : 'immediate', send_policy: 'immediate', session: s };
    }
    const stateDir = path.join(workspace, '.tmp', 'cli_conductor');
    try { uistate.apply(files.ui, { addRecent: workspace }); } catch { }
    const configPath = path.join(stateDir, 'app.config.json'), sendScript = path.join(REPO, 'tools', 'cli_conductor_send.ps1');
    for (const r of roles) if (bridgeRoles[r.name].session && String(r.briefing || '').trim()) {
      const peers = roles.filter(o => o.name !== r.name).map(o => o.type === 'observer' ? `${o.name} (archive only)` : o.name).join(', ');
      bridgeRoles[r.name].briefing = fillBriefing(r.briefing, { role: r.name, peers, workspace, send: `pwsh -File "${sendScript}" -ConfigPath "${configPath}"` });
    }
    const bridge = new Bridge({ workspace, stateDir, roles: bridgeRoles, sendScript, configPath, waitTurnEnd: !!body.waitTurnEnd, pollMs: body.pollMs || 1000 });
    bridge.on('event', e => broadcast({ type: 'event', event: e }));
    bridge.on('error', e => log('bridge error', e.message));
    bridge.start();
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
    run = { bridge, sessions, roles: roles.map(r => ({ name: r.name, type: r.type || 'agent', adapter: r.adapter || null, account: r.account || '', delivery: bridgeRoles[r.name].delivery, briefing: !!bridgeRoles[r.name].briefing })), startedAt: new Date().toISOString() };
    broadcast({ type: 'status', status: statusPayload() });
    return statusPayload();
  }

  async function stop() {
    if (!run) return { running: false };
    const r = run; run = null;
    r.bridge.stop();
    await Promise.all(Object.values(r.sessions).map(s => s.stop()));
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
    if (!s.resumes) r.bridge.rebrief(s.name);
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
  function accountsPayload() { return { root: accountsDir, supported: accounts.capabilities(), accounts: accounts.list(accountsDir), logins: Object.values(logins).map(l => ({ id: l.name, cli: l.cli, account: l.account, state: l.state })) }; }
  // Login terminal: the CLI (or its documented login subcommand) with the account's env.
  async function startLogin({ cli, name }) {
    const st = accounts.status(accountsDir, cli, name);
    if (!st.exists) throw new Error(`ACCOUNT_MISSING:${cli}-${name}`);
    const a = scan(allAdapters()).find(x => x.id === cli && !x.custom);
    if (!a || !a.path) throw new Error(`ADAPTER_NOT_FOUND:${cli}`);
    const id = `LOGIN_${cli}_${name}`.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    if (logins[id] && logins[id].alive) return { id };
    const s = new RoleSession({ name: id, adapter: compile(a), file: a.path, args: accounts.loginArgs(cli), cwd: os.homedir(), cols: 100, rows: 28, env: accounts.envFor(accountsDir, cli, name) });
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
      return { command: (a.commands || [b.adapter || ''])[0], args };
    },
    'GET /api/status': () => statusPayload(),
    'POST /api/restart-role': b => { const s = roleSession(b.role); if (s.restarting) throw new Error(`ROLE_RESTARTING:${s.name}`); restartRole(s.name).catch(e => log('restart failed', e.message)); return { ok: true, role: s.name }; },
    'POST /api/stop-role': b => stopRole(b.role),
    'GET /api/accounts': () => accountsPayload(),
    'POST /api/accounts': b => { accounts.create(accountsDir, String(b.cli || ''), String(b.name || '').trim().toLowerCase()); return accountsPayload(); },
    'POST /api/open-account-folder': b => { const st = accounts.status(accountsDir, String(b.cli || ''), String(b.name || '')); if (!st.exists) throw new Error(`ACCOUNT_MISSING:${b.cli}-${b.name}`); openFolder(st.dir); return { ok: true, dir: st.dir }; },
    'POST /api/account-login': b => startLogin({ cli: String(b.cli || ''), name: String(b.name || '') }),
    'POST /api/account-login-stop': async b => { const s = logins[b.id]; if (s) { await s.stop(2000); delete logins[b.id]; } return accountsPayload(); },
    'GET /api/defaults': () => ({ workspace: process.cwd(), home: os.homedir(), platform: process.platform }),
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
    server, start, stop, restartRole, stopRole, status: statusPayload, get run() { return run; },
    listen: () => new Promise(r => server.listen(port, host, () => { const a = server.address(); log(`cli-conductor on http://${host}:${a.port}`); r(a.port); })),
    close: async () => { await stop(); await Promise.all(Object.values(logins).map(s => s.stop(1000))); for (const ws of sockets) ws.terminate(); await new Promise(r => server.close(r)); },
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