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
  return status(root, cli, name);
}
// '' / 'default' -> {} (the CLI's own default home). Otherwise the documented variable.
function envFor(root, cli, name) {
  if (!name || name === 'default') return {};
  const st = status(root, cli, name);
  if (!st.exists) throw new Error(`ACCOUNT_MISSING:${cli}-${name}`);
  return { [SPECS[cli].env]: st.dir };
}
const loginArgs = cli => (SPECS[cli] ? SPECS[cli].login.slice() : []);
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
module.exports = { SPECS, NAME_RE, defaultRoot, supported, dirFor, status, list, create, envFor, loginArgs, duplicates, capabilities };
