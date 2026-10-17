'use strict';
// Per-role CLI accounts: each account is its own config/state dir, selected by an env var
// that the CLI documents officially. CLIs without a documented variable get no account option.
// Dirs live under %USERPROFILE%\.cli-conductor\accounts\<cli>-<name>; the CLI's default
// home (~/.codex, ~/.claude, ~/.gemini) is never read or written.
const fs = require('fs');
const os = require('os');
const path = require('path');

const SPECS = {
  // https://learn.chatgpt.com/docs/config-file/environment-variables (CODEX_HOME, dir must exist)
  // https://learn.chatgpt.com/docs/auth.md (auth.json under CODEX_HOME when file storage is used; `codex login`)
  codex: { env: 'CODEX_HOME', auth: ['auth.json'], login: ['login'] },
  // https://code.claude.com/docs/en/authentication (CLAUDE_CONFIG_DIR per account; .credentials.json under it;
  // first launch walks through login)
  claude: { env: 'CLAUDE_CONFIG_DIR', auth: ['.credentials.json'], login: [] },
  // https://geminicli.com/docs/cli/enterprise/ (GEMINI_CLI_HOME; CLI creates .gemini inside)
  // auth file name is not documented there: oauth_creds.json is what current versions write (best effort).
  gemini: { env: 'GEMINI_CLI_HOME', auth: ['.gemini/oauth_creds.json'], login: [], mkdirs: ['.gemini'] },
};
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const defaultRoot = () => process.env.CC_ACCOUNTS_DIR || path.join(process.env.CC_DATA_DIR || path.join(os.homedir(), '.cli-conductor'), 'accounts');
const supported = id => Object.prototype.hasOwnProperty.call(SPECS, id);

function dirFor(root, cli, name) {
  if (!supported(cli)) throw new Error(`ACCOUNT_UNSUPPORTED:${cli}`);
  if (!NAME_RE.test(String(name || ''))) throw new Error('ACCOUNT_NAME_INVALID: use a-z, 0-9, - or _ (max 32)');
  return path.join(root, `${cli}-${name}`);
}
function status(root, cli, name) {
  const dir = dirFor(root, cli, name);
  const authFile = SPECS[cli].auth.map(a => path.join(dir, a)).find(f => fs.existsSync(f)) || null;
  return { cli, name, dir, exists: fs.existsSync(dir), loggedIn: !!authFile, authFile };
}
function list(root = defaultRoot()) {
  const out = {};
  for (const cli of Object.keys(SPECS)) out[cli] = [];
  let names = []; try { names = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { }
  for (const n of names.sort()) {
    const i = n.indexOf('-'); if (i < 1) continue;
    const cli = n.slice(0, i), name = n.slice(i + 1);
    if (supported(cli) && NAME_RE.test(name)) out[cli].push(status(root, cli, name));
  }
  return out;
}
function create(root, cli, name) {
  const dir = dirFor(root, cli, name);
  if (fs.existsSync(dir)) throw new Error(`ACCOUNT_EXISTS:${cli}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const m of SPECS[cli].mkdirs || []) fs.mkdirSync(path.join(dir, m), { recursive: true });
  if (cli === 'codex') ensureCodexSandbox(dir);
  return status(root, cli, name);
}
// '' / 'default' -> {} (the CLI's own default home). Otherwise the documented variable.
function envFor(root, cli, name) {
  if (!name || name === 'default') return {};
  const st = status(root, cli, name);
  if (!st.exists) throw new Error(`ACCOUNT_MISSING:${cli}-${name}`);
  if (cli === 'codex') { try { ensureCodexSandbox(st.dir); } catch { } } // protect older accounts on start/login
  return { [SPECS[cli].env]: st.dir };
}
// Codex on Windows: elevated sandbox setup under one CODEX_HOME resets the machine-wide
// CodexSandboxOffline/Online passwords and records them only in that home, which breaks the
// default ~/.codex (Codex Desktop: "Windows setup incomplete"). See openai/codex#40627.
// Extra homes therefore pin [windows] sandbox = "unelevated". Only ever called on dirs inside
// the tool's accounts root (dirFor); the CLI's own ~/.codex is never touched.
function ensureCodexSandbox(dir) {
  const f = path.join(dir, 'config.toml');
  let txt = ''; try { txt = fs.readFileSync(f, 'utf8'); } catch { }
  const next = setTomlWindowsSandbox(txt, 'unelevated');
  if (next !== txt) fs.writeFileSync(f, next);
  return next !== txt;
}
function setTomlWindowsSandbox(txt, value) {
  const eol = /\r\n/.test(txt) ? '\r\n' : '\n';
  const lines = txt.length ? txt.split(/\r?\n/) : [];
  const want = `sandbox = "${value}"`;
  let sec = '', winAt = -1, done = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    const h = /^\[\s*([^\[\]]+?)\s*\]\s*(#.*)?$/.exec(t);
    if (h) { sec = h[1]; if (sec === 'windows' && winAt < 0) winAt = i; continue; }
    if (sec === '' && /^windows\.sandbox\s*=/.test(t)) { if (t !== `windows.${want}`) lines[i] = `windows.${want}`; done = true; break; }
    if (sec === 'windows' && /^sandbox\s*=/.test(t)) { if (t !== want) lines[i] = want; done = true; break; }
  }
  if (!done) {
    if (winAt >= 0) lines.splice(winAt + 1, 0, want);
    else { while (lines.length && lines[lines.length - 1].trim() === '') lines.pop(); if (lines.length) lines.push(''); lines.push('[windows]', want, ''); }
  }
  let out = lines.join(eol); if (!out.endsWith(eol)) out += eol;
  return out === txt || out === txt + eol ? txt : out;
}
const loginArgs = cli => (SPECS[cli] ? SPECS[cli].login.slice() : []);
// Per-run override for non-default Codex homes (verified: `codex -c windows.sandbox="unelevated" --version`
// on codex-cli 0.163.0). Prepended before subcommands so it applies to resume/login too.
function argOverrides(cli, name) {
  if (cli === 'codex' && name && name !== 'default') return ['-c', 'windows.sandbox=unelevated'];
  return [];
}
// Roles that share an account-capable CLI and the same account (default counts as one account).
// CLIs without account support are not reported: there is nothing the user could pick instead.
function duplicates(roles) {
  const g = new Map();
  for (const r of roles) {
    if (!r || r.type === 'observer' || r.enabled === false || !supported(r.adapter)) continue;
    const acct = r.account && r.account !== 'default' ? r.account : 'default';
    const k = `${r.adapter}\u0000${acct}`;
    if (!g.has(k)) g.set(k, { adapter: r.adapter, account: acct, roles: [] });
    g.get(k).roles.push(String(r.name || '').toUpperCase());
  }
  return [...g.values()].filter(x => x.roles.length > 1);
}
const capabilities = () => Object.fromEntries(Object.entries(SPECS).map(([k, v]) => [k, { env: v.env, login: v.login.length ? v.login.join(' ') : '' }]));
module.exports = { SPECS, NAME_RE, defaultRoot, supported, dirFor, status, list, create, envFor, loginArgs, argOverrides, ensureCodexSandbox, setTomlWindowsSandbox, duplicates, capabilities };
