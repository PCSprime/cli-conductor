// Fake codex-auth for tests (never the real tool, never the real ~/.codex): implements
// `list --json --skip-api` and `switch <key> --json` on $CODEX_HOME like codex-auth 0.3.1:
// foreground sync of auth.json into its snapshot, backup, copy snapshot -> auth.json, registry.
// Fault flags: FAKE_CA_NOSYNC=1 (skip save-back), FAKE_CA_SWITCH_BAD=1 (write a wrong login),
// FAKE_CA_SWITCH_FAIL=1 (corrupt auth.json then exit 1), FAKE_CA_LOG=<file> (append argv).
const fs = require('fs'); const path = require('path');
const home = process.env.CODEX_HOME; const argv = process.argv.slice(2);
if (process.env.FAKE_CA_LOG) fs.appendFileSync(process.env.FAKE_CA_LOG, JSON.stringify({ argv, home }) + '\n');
const out = j => { process.stdout.write(JSON.stringify({ schema_version: 1, ...j }) + '\n'); };
if (!home || !fs.existsSync(home)) { out({ error: { code: 'no_home', message: 'CODEX_HOME missing' } }); process.exit(1); }
const accDir = path.join(home, 'accounts'), regF = path.join(accDir, 'registry.json'), authF = path.join(home, 'auth.json');
const snap = k => path.join(accDir, Buffer.from(k).toString('base64url') + '.auth.json');
const reg = JSON.parse(fs.readFileSync(regF, 'utf8'));
const claims = doc => { try { return JSON.parse(Buffer.from(doc.tokens.id_token.split('.')[1], 'base64url').toString()); } catch { return {}; } };
const keyOf = doc => { const c = claims(doc)['https://api.openai.com/auth'] || {}; return `${c.chatgpt_user_id}::${doc.tokens.account_id}`; };
// foreground sync (save-back)
let live = null; try { live = JSON.parse(fs.readFileSync(authF, 'utf8')); } catch { }
if (live && !process.env.FAKE_CA_NOSYNC) {
  const k = keyOf(live); const rec = reg.accounts.find(a => a.account_key === k);
  if (rec) { const cur = fs.existsSync(snap(k)) ? fs.readFileSync(snap(k), 'utf8') : ''; if (cur !== JSON.stringify(live)) fs.writeFileSync(snap(k), JSON.stringify(live)); reg.active_account_key = k; }
}
const acc = a => ({ number: 1, account_key: a.account_key, email: a.email, alias: a.alias || null, plan: a.plan, auth_mode: 'chatgpt', active: a.account_key === reg.active_account_key, last_used_at: a.last_used_at || null });
if (argv[0] === 'list') { fs.writeFileSync(regF, JSON.stringify(reg, null, 2)); out({ command: 'list', active_account_key: reg.active_account_key, accounts: reg.accounts.map(acc) }); process.exit(0); }
if (argv[0] === 'switch') {
  const k = argv[1]; const rec = reg.accounts.find(a => a.account_key === k);
  if (!rec) { out({ error: { code: 'account_not_found', message: 'no account' } }); process.exit(1); }
  if (process.env.FAKE_CA_SWITCH_FAIL) { fs.writeFileSync(authF, '{"broken":'); reg.active_account_key = k; fs.writeFileSync(regF, JSON.stringify(reg)); out({ error: { code: 'io', message: 'disk full' } }); process.exit(1); }
  if (fs.existsSync(authF)) fs.copyFileSync(authF, path.join(accDir, `auth.json.bak.${Date.now()}`));
  if (process.env.FAKE_CA_SWITCH_BAD) { const other = reg.accounts.find(a => a.account_key !== k && a.account_key !== reg.active_account_key) || reg.accounts.find(a => a.account_key !== k); fs.copyFileSync(snap(other.account_key), authF); }
  else fs.copyFileSync(snap(k), authF);
  reg.previous_active_account_key = reg.active_account_key; reg.active_account_key = k; fs.writeFileSync(regF, JSON.stringify(reg, null, 2));
  out({ command: 'switch', switched_to: acc(rec) }); process.exit(0);
}
out({ error: { code: 'usage', message: 'unsupported' } }); process.exit(2);
