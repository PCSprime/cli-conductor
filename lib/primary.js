'use strict';
// 主账号 (primary Codex login): every Codex role without a separate account uses the CLI's own
// home (~/.codex), so sessions/history stay in one place and any role can resume any session.
// Switching the primary login only swaps <home>/auth.json, and that is delegated to codex-auth
// (@loongphy/codex-auth): it keeps per-account snapshots in <home>/accounts/, syncs the live
// auth.json back into its snapshot before work (keeps tokens Codex refreshed) and backs it up.
// CLI Conductor adds: desktop-app block, <home>/auth.lock around the switch (the lock Codex
// takes for token refresh), a save-back check, identity verification and rollback.
// Tokens are never returned, logged or rendered; emails are masked.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const defaultHome = () => process.env.CC_PRIMARY_HOME || path.join(os.homedir(), '.codex');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function maskEmail(e) {
  e = String(e || '').trim().toLowerCase(); if (!e) return '';
  const at = e.indexOf('@'); if (at < 0) return e.slice(0, 2) + '***';
  return e.slice(0, Math.min(2, at)) + '***' + e.slice(at);
}
function jwtClaims(tok) {
  if (tok && typeof tok === 'object') tok = tok.raw_jwt || tok.rawJwt || '';
  const p = String(tok || '').split('.'); if (p.length < 2) return {};
  try { return JSON.parse(Buffer.from(p[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) || {}; } catch { return {}; }
}
// Identity of an auth.json document (never returns tokens).
function identityOf(doc) {
  if (!doc || typeof doc !== 'object') return { mode: 'none' };
  if (doc.OPENAI_API_KEY) return { mode: 'apikey', key: 'apikey', lastRefresh: doc.last_refresh || null };
  const tk = doc.tokens || {}; const c = jwtClaims(tk.id_token); const a = c['https://api.openai.com/auth'] || {};
  const accountId = tk.account_id || a.chatgpt_account_id || '';
  const userId = a.chatgpt_user_id || a.user_id || c.user_id || '';
  const email = c.email || (c['https://api.openai.com/profile'] || {}).email || '';
  if (!accountId || !tk.access_token) return { mode: 'invalid' };
  return { mode: 'chatgpt', key: userId ? `${userId}::${accountId}` : `?::${accountId}`, accountId, userId, email: maskEmail(email), plan: a.chatgpt_plan_type || '', lastRefresh: doc.last_refresh || null };
}
const readJsonFile = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const sameKey = (a, b) => { if (!a || !b) return false; const [ua, aa] = String(a).split('::'), [ub, ab] = String(b).split('::'); return aa === ab && (ua === ub || ua === '?' || ub === '?'); };
// codex-auth snapshot file: <home>/accounts/<base64url(account_key)>.auth.json
const snapshotPath = (home, key) => path.join(home, 'accounts', Buffer.from(String(key)).toString('base64url') + '.auth.json');
function atomicWrite(file, buf) {
  const tmp = `${file}.tb-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(tmp, buf); fs.renameSync(tmp, file);
}

// codex-auth invocation: CC_CODEX_AUTH (a .js shim or an executable) or the npm-installed binary.
function resolveTool() {
  const env = process.env.CC_CODEX_AUTH;
  if (env) return /\.m?js$/i.test(env) ? [process.execPath, env] : [env];
  if (process.platform === 'win32') {
    const base = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@loongphy', 'codex-auth');
    for (const arch of [process.arch === 'arm64' ? 'arm64' : 'x64', 'x64']) {
      const exe = path.join(base, 'node_modules', '@loongphy', `codex-auth-win32-${arch}`, 'bin', 'codex-auth.exe');
      if (fs.existsSync(exe)) return [exe];
    }
    const js = path.join(base, 'bin', 'codex-auth.js');
    if (fs.existsSync(js)) return [process.execPath, js];
    return null;
  }
  return ['codex-auth'];
}

// Codex Desktop (ChatGPT.exe from the OpenAI.Codex package, or its codex.exe app-server) shares
// ~/.codex and keeps the login in memory: switching under it would break it, so we block.
function probeDesktop() {
  if (process.platform !== 'win32') return Promise.resolve([]);
  const ps = "Get-CimInstance Win32_Process -Filter \"Name='ChatGPT.exe' or Name='codex.exe'\" | Where-Object { ($_.Name -eq 'ChatGPT.exe' -and $_.ExecutablePath -match 'OpenAI\\.Codex') -or ($_.Name -eq 'codex.exe' -and $_.CommandLine -match '\\sapp-server(\\s|$)' -and $_.ExecutablePath -match '\\\\OpenAI\\\\Codex\\\\') } | ForEach-Object { \"$($_.ProcessId) $($_.Name)\" }";
  return new Promise(res => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15000 }, (err, out) => {
    if (err && !out) return res(null); // unknown (probe failed)
    res(String(out || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => { const [pid, ...n] = l.split(' '); return { pid: Number(pid), name: n.join(' ') }; }));
  }));
}

// Exclusive lock on <home>/auth.lock (see authlock.ps1). Resolves to a release function.
function lockAuth(home, timeoutMs) {
  if (process.platform !== 'win32') return Promise.resolve(() => { });
  return new Promise((res, rej) => {
    const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'authlock.ps1'), '-Path', path.join(home, 'auth.lock'), '-TimeoutMs', String(timeoutMs)], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '', done = false;
    const fail = e => { if (done) return; done = true; try { c.kill(); } catch { } rej(e); };
    const guard = setTimeout(() => fail(new Error('PRIMARY_LOCK_TIMEOUT')), timeoutMs + 15000);
    c.on('error', e => { clearTimeout(guard); fail(new Error(`PRIMARY_LOCK_FAILED:${e.message}`)); });
    c.on('exit', code => { clearTimeout(guard); if (!done) fail(new Error(code === 3 ? 'PRIMARY_LOCK_TIMEOUT' : `PRIMARY_LOCK_FAILED:exit ${code}`)); });
    c.stdout.on('data', d => {
      out += d; if (done) return;
      if (/TIMEOUT/.test(out)) { clearTimeout(guard); fail(new Error('PRIMARY_LOCK_TIMEOUT')); return; }
      if (/LOCKED/.test(out)) {
        clearTimeout(guard); done = true;
        res(() => new Promise(r => { c.once('exit', () => r()); try { c.stdin.end(); } catch { } setTimeout(() => { try { c.kill(); } catch { } r(); }, 3000); }));
      }
    });
  });
}

// ---------- sessions (rollout files) ----------
function walkRollouts(dir, out = []) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) { const f = path.join(dir, e.name); if (e.isDirectory()) walkRollouts(f, out); else if (/^rollout-.*\.jsonl(\.zst)?$/i.test(e.name)) out.push(f); }
  return out;
}
const rolloutsIn = home => [...walkRollouts(path.join(home, 'sessions')), ...walkRollouts(path.join(home, 'archived_sessions'))];
// Rollout names seen in ~/.codex: rollout-<ts>-<id>.jsonl, …-<id>.jsonl.zst (compressed by Codex),
// …-<id>_<other id>.jsonl. Prefer the plain file (its first line is readable session_meta).
function findRollout(home, id) {
  const i = String(id).toLowerCase().replace(/[^0-9a-f-]/g, ''); if (!i) return null;
  const re = new RegExp(`-${i}(?:_[0-9a-f-]+)?\\.jsonl(?:\\.zst)?$`, 'i');
  const hits = rolloutsIn(home).filter(f => re.test(path.basename(f)));
  const rank = f => /\.zst$/i.test(f) ? 2 : new RegExp(`-${i}\\.jsonl$`, 'i').test(f) ? 0 : 1;
  return hits.sort((a, b) => rank(a) - rank(b))[0] || null;
}
// Codex's own index of threads in that home (one JSON per line, "id": …).
function inSessionIndex(home, id) { try { return fs.readFileSync(path.join(home, 'session_index.jsonl'), 'utf8').toLowerCase().includes(`"${String(id).toLowerCase()}"`); } catch { return false; } }
const sessionExists = (home, id) => findRollout(home, id) || (inSessionIndex(home, id) ? 'index' : null);
// First line of a rollout is session_meta: { id, cwd, creator_user_id, creator_account_id, ... }.
function sessionMeta(file) {
  let fd; try {
    fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(256 * 1024); const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const line = buf.subarray(0, n).toString('utf8').split('\n')[0];
    const j = JSON.parse(line); const p = j && j.type === 'session_meta' ? j.payload || {} : {};
    return { id: p.id || p.session_id || '', cwd: p.cwd || '', userId: p.creator_user_id || '', accountId: p.creator_account_id || '' };
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { } }
}
const samePath = (a, b) => { if (!a || !b) return false; const n = x => path.resolve(x).replace(/[\\/]+$/, ''); return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b); };
function lastRolloutFor(home, cwd) {
  const files = rolloutsIn(home).map(f => { try { return [f, fs.statSync(f).mtimeMs]; } catch { return null; } }).filter(Boolean).sort((a, b) => b[1] - a[1]).slice(0, 300);
  for (const [f] of files) { const m = sessionMeta(f); if (m && samePath(m.cwd, cwd)) return { file: f, meta: m }; }
  return null;
}

function createPrimary({ home = defaultHome(), accountsDir, dataDir, tool, desktop = probeDesktop, lock = lockAuth, lockTimeoutMs = 5000, log = () => { } } = {}) {
  const ownersFile = dataDir ? path.join(dataDir, 'session-owners.json') : null;
  let busy = false, cache = null;

  function runTool(args) {
    const t = tool || resolveTool();
    if (!t) return Promise.reject(new Error('PRIMARY_TOOL_MISSING'));
    return new Promise((res, rej) => execFile(t[0], [...t.slice(1), ...args], { env: { ...process.env, CODEX_HOME: home }, windowsHide: true, timeout: 30000, maxBuffer: 4 << 20 }, (err, stdout) => {
      if (err && err.code === 'ENOENT') return rej(new Error('PRIMARY_TOOL_MISSING'));
      let j = null; try { j = JSON.parse(String(stdout || '').trim().split(/\r?\n/).pop()); } catch { }
      if (!j) return rej(new Error(`PRIMARY_TOOL_FAILED:${err ? (err.code || err.message) : 'no JSON'}`));
      if (j.error) return rej(new Error(`PRIMARY_TOOL_FAILED:${j.error.code || ''} ${j.error.message || ''}`.trim()));
      res(j);
    }));
  }
  const current = () => identityOf(readJsonFile(path.join(home, 'auth.json')));
  const safeAccount = a => {
    const snap = readJsonFile(snapshotPath(home, a.account_key)) || {};
    return { key: a.account_key, alias: a.alias || '', email: maskEmail(a.email), plan: a.plan || '', authMode: a.auth_mode || '', active: !!a.active, lastUsedAt: a.last_used_at || null, lastRefresh: snap.last_refresh || null };
  };
  // Registry read without codex-auth (tool missing): read-only, never written by us.
  function registryFallback() {
    const r = readJsonFile(path.join(home, 'accounts', 'registry.json')) || {};
    return { active_account_key: r.active_account_key || null, accounts: (r.accounts || []).map(a => ({ ...a, active: a.account_key === r.active_account_key })) };
  }
  async function list() {
    let j, toolOk = true, toolError = '';
    try { j = await runTool(['list', '--json', '--skip-api']); } catch (e) { toolOk = false; toolError = e.message; j = registryFallback(); }
    const cur = current();
    const accounts = (j.accounts || []).map(safeAccount);
    const inList = accounts.find(a => sameKey(a.key, cur.key));
    const out = { home, toolOk, toolError, current: { mode: cur.mode, key: cur.key || null, email: cur.email || (inList ? inList.email : ''), alias: inList ? inList.alias : '', plan: cur.plan || (inList ? inList.plan : ''), lastRefresh: cur.lastRefresh || null, known: !!inList }, accounts };
    cache = out; return out;
  }
  const labelFor = key => {
    const pool = cache ? cache.accounts : (registryFallback().accounts || []).map(x => ({ key: x.account_key, alias: x.alias || '', email: maskEmail(x.email) }));
    const a = pool.find(x => sameKey(x.key, key));
    if (a) return a.alias ? `${a.alias}（${a.email}）` : a.email;
    const acc = String(key || '').split('::')[1] || ''; return acc ? `…${acc.slice(-6)}` : '?';
  };

  async function precheck(key, affected = []) {
    const d = await desktop();
    return { desktop: d || [], desktopUnknown: d === null, blocked: !!(d && d.length), roles: affected };
  }

  // Switch the primary login. Steps: desktop block → mutex → auth.lock → codex-auth list (syncs the
  // live auth.json into its snapshot) → verify the save-back → keep in-memory backups →
  // codex-auth switch → verify identity → rollback on any failure → unlock.
  async function switchTo(key, affected = []) {
    if (busy) throw new Error('PRIMARY_SWITCH_BUSY');
    busy = true;
    let release = null;
    const authFile = path.join(home, 'auth.json'), regFile = path.join(home, 'accounts', 'registry.json');
    let backup = null;
    try {
      const d = await desktop();
      if (d && d.length) throw new Error(`PRIMARY_DESKTOP_RUNNING:${d.map(x => `${x.name} ${x.pid}`).join(', ')}`);
      if (d === null) throw new Error('PRIMARY_DESKTOP_UNKNOWN');
      release = await lock(home, lockTimeoutMs);
      const before = await list(); // fresh registry read + codex-auth foreground sync (save-back)
      if (!before.toolOk) throw new Error(before.toolError || 'PRIMARY_TOOL_MISSING');
      const target = before.accounts.find(a => a.key === key);
      if (!target) throw new Error('PRIMARY_ACCOUNT_UNKNOWN');
      const cur = current();
      if (cur.key && sameKey(cur.key, key)) return { ok: true, unchanged: true, to: labelFor(key), roles: [], list: before };
      // Save-back check: the live login must be in its snapshot, otherwise refreshed tokens would be lost.
      if (cur.mode === 'chatgpt' || cur.mode === 'apikey') {
        const live = readJsonFile(authFile), owner = before.accounts.find(a => sameKey(a.key, cur.key));
        const snap = owner ? readJsonFile(snapshotPath(home, owner.key)) : null;
        if (cur.mode === 'chatgpt' && (!snap || JSON.stringify((snap || {}).tokens) !== JSON.stringify((live || {}).tokens))) throw new Error('PRIMARY_SAVEBACK_FAILED');
      }
      backup = { auth: fs.existsSync(authFile) ? fs.readFileSync(authFile) : null, reg: fs.existsSync(regFile) ? fs.readFileSync(regFile) : null };
      const fromLabel = cur.key ? labelFor(cur.key) : '';
      try {
        await runTool(['switch', key, '--json']);
        const now = current();
        if (!sameKey(now.key, key)) throw new Error('PRIMARY_VERIFY_FAILED');
      } catch (e) {
        try { if (backup.auth) atomicWrite(authFile, backup.auth); if (backup.reg) atomicWrite(regFile, backup.reg); } catch (re) { log('primary rollback failed', re.message); throw new Error(`PRIMARY_ROLLBACK_FAILED:${e.message}`); }
        throw new Error(`PRIMARY_SWITCH_FAILED:${e.message} (rolled back)`);
      }
      const after = await list().catch(() => cache);
      return { ok: true, from: fromLabel, to: labelFor(key), roles: affected, list: after };
    } finally {
      if (release) { try { await release(); } catch { } }
      busy = false;
    }
  }

  // ---------- session owners ----------
  const readOwners = () => (ownersFile && readJsonFile(ownersFile)) || { sessions: {} };
  function recordOwner(id, key) {
    if (!ownersFile || !UUID_RE.test(String(id || '')) || !key) return;
    const o = readOwners(); o.sessions = o.sessions || {}; o.sessions[String(id).toLowerCase()] = { key, at: new Date().toISOString() };
    try { fs.mkdirSync(path.dirname(ownersFile), { recursive: true }); atomicWrite(ownersFile, JSON.stringify(o, null, 2)); } catch { }
  }
  // Owner = the account that created the session (rollout session_meta.creator_*), else the
  // account recorded when CLI Conductor last ran it, else unknown.
  function ownerOf(id, file) {
    const m = file && sessionMeta(file);
    if (m && m.accountId) return { key: `${m.userId || '?'}::${m.accountId}`, source: 'rollout' };
    const r = readOwners().sessions[String(id).toLowerCase()];
    return r ? { key: r.key, source: 'recorded' } : { key: null, source: 'unknown' };
  }
  const isolatedHomes = () => { try { return fs.readdirSync(accountsDir, { withFileTypes: true }).filter(e => e.isDirectory() && /^codex-/.test(e.name)).map(e => ({ name: e.name.slice(6), dir: path.join(accountsDir, e.name) })); } catch { return []; } };
  function whereIs(id, exceptDir) {
    const homes = [{ name: '', dir: home }, ...isolatedHomes()].filter(h => !exceptDir || !samePath(h.dir, exceptDir));
    for (const h of homes) { if (sessionExists(h.dir, id)) return h; }
    return null;
  }

  // Gate before starting a Codex role that resumes. Returns { ok } | { ok, warn } | { block }.
  // role: { adapter, account, options: { resume, resumeId }, cwd }
  function checkResume(role) {
    if (!role || role.adapter !== 'codex') return { ok: true };
    const o = role.options || {}; const mode = o.resume;
    const id = String(o.resumeId || '').trim();
    if (mode !== 'id' && mode !== 'last') return { ok: true };
    if (mode === 'id' && !UUID_RE.test(id)) return { ok: true }; // not an ID we can check (thread name etc.)
    const acct = role.account && role.account !== 'default' ? role.account : '';
    const myHome = acct ? path.join(accountsDir, `codex-${acct}`) : home;
    const here = acct ? `codex-${acct}` : 'primary';
    let file = null, sid = id;
    if (mode === 'id') {
      file = sessionExists(myHome, id);
      if (file === 'index') file = null; // listed by Codex, but no readable rollout: exists, owner unknown
      else if (!file) {
        const w = whereIs(id, myHome);
        if (w) return { block: true, code: 'RESUME_ELSEWHERE', id, where: w.name ? `codex-${w.name}` : 'primary', here };
        return { block: true, code: 'RESUME_NOT_FOUND', id, here };
      }
    } else {
      const l = role.cwd ? lastRolloutFor(myHome, role.cwd) : null;
      if (!l) return { ok: true }; // nothing to continue: Codex starts its own picker-free fresh path
      file = l.file; sid = l.meta.id;
    }
    if (acct) return { ok: true, id: sid }; // isolated home: one login, the file is there
    // Primary home: any session there is continued with the current primary login (that is what
    // switching the primary account is for). A different creator is only an informational note;
    // if Codex itself refuses, its own error shows on the card.
    const cur = current();
    const ow = ownerOf(sid, file);
    if (ow.key && cur.mode === 'chatgpt' && !sameKey(ow.key, cur.key)) return { ok: true, id: sid, note: { code: 'OWNER_OTHER', owner: labelFor(ow.key), current: labelFor(cur.key) } };
    return { ok: true, id: sid };
  }
  // After a primary-home Codex role started: remember which login ran that session.
  function noteStarted(role) {
    if (!role || role.adapter !== 'codex' || (role.account && role.account !== 'default')) return;
    const o = role.options || {}; const cur = current(); if (cur.mode !== 'chatgpt') return;
    if (o.resume === 'id') recordOwner(o.resumeId, cur.key);
  }
  return { home, list, precheck, switchTo, checkResume, noteStarted, ownerOf, recordOwner, current, labelFor, get busy() { return busy; } };
}

module.exports = { createPrimary, identityOf, maskEmail, sessionMeta, snapshotPath, lockAuth, probeDesktop, defaultHome, UUID_RE };
