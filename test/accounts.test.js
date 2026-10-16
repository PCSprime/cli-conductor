'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const accounts = require('../lib/accounts');
const { createApp } = require('../server');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tbapp-acct-'));

test('accounts: env mapping per CLI (documented variables only)', () => {
  const root = tmp();
  accounts.create(root, 'codex', 'work'); accounts.create(root, 'claude', 'work'); accounts.create(root, 'gemini', 'alt');
  assert.deepEqual(accounts.envFor(root, 'codex', 'work'), { CODEX_HOME: path.join(root, 'codex-work') });
  assert.deepEqual(accounts.envFor(root, 'claude', 'work'), { CLAUDE_CONFIG_DIR: path.join(root, 'claude-work') });
  assert.deepEqual(accounts.envFor(root, 'gemini', 'alt'), { GEMINI_CLI_HOME: path.join(root, 'gemini-alt') });
  assert.ok(fs.existsSync(path.join(root, 'gemini-alt', '.gemini')));
  for (const d of ['', 'default', undefined]) assert.deepEqual(accounts.envFor(root, 'codex', d), {});
  assert.throws(() => accounts.envFor(root, 'qodercn', 'x'), /ACCOUNT_UNSUPPORTED/);
  assert.throws(() => accounts.envFor(root, 'codex', 'nope'), /ACCOUNT_MISSING/);
  assert.equal(accounts.supported('qodercn'), false);
  assert.deepEqual(accounts.loginArgs('codex'), ['login']);
  assert.deepEqual(accounts.loginArgs('claude'), []);
});

test('accounts: dir creation, name validation, list + login status, never the default home', () => {
  const root = path.join(tmp(), 'nested', 'accounts');
  const st = accounts.create(root, 'codex', 'acct-2');
  assert.equal(st.dir, path.join(root, 'codex-acct-2'));
  assert.ok(fs.statSync(st.dir).isDirectory());
  assert.equal(st.loggedIn, false);
  assert.throws(() => accounts.create(root, 'codex', 'acct-2'), /ACCOUNT_EXISTS/);
  for (const bad of ['../x', 'A B', '', 'x/y', '.hidden', 'a'.repeat(40)]) assert.throws(() => accounts.create(root, 'codex', bad), /ACCOUNT_NAME_INVALID/);
  fs.writeFileSync(path.join(st.dir, 'auth.json'), '{}');
  fs.mkdirSync(path.join(root, 'junk')); fs.mkdirSync(path.join(root, 'unknown-x'));
  const l = accounts.list(root);
  assert.deepEqual(l.codex.map(a => [a.name, a.loggedIn]), [['acct-2', true]]);
  assert.deepEqual(l.claude, []);
  assert.ok(!JSON.stringify(l).includes(path.join(os.homedir(), '.codex')));
  assert.match(accounts.defaultRoot(), /\.cli-conductor[\\/]accounts$/);
});

test('accounts: duplicate CLI+account warning', () => {
  const d = accounts.duplicates([
    { name: 'A', adapter: 'codex' }, { name: 'B', adapter: 'codex', account: 'default' }, { name: 'C', adapter: 'codex', account: 'work' },
    { name: 'D', adapter: 'claude', account: 'w' }, { name: 'E', adapter: 'claude', account: 'w' }, { name: 'F', adapter: 'claude', account: 'w', enabled: false },
    { name: 'O', type: 'observer' }, { name: 'G', adapter: 'qodercn', account: 'ignored' }]);
  assert.deepEqual(d.map(x => [x.adapter, x.account, x.roles]), [['codex', 'default', ['A', 'B']], ['claude', 'w', ['D', 'E']]]);
  assert.deepEqual(accounts.duplicates([{ name: 'A', adapter: 'codex' }, { name: 'B', adapter: 'claude' }]), []);
});

test('accounts: start refuses duplicate accounts unless allowed; API creates account dirs', async t => {
  const ws = tmp(); const root = path.join(ws, 'acct');
  const app = createApp({ port: 0, dataDir: path.join(ws, 'appdata'), log: () => {}, accountsDir: root });
  const port = await app.listen(); t.after(() => app.close());
  const call = async (m, u, b) => { const r = await fetch(`http://127.0.0.1:${port}${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-cli-conductor': '1' }, body: b && JSON.stringify(b) }); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; };
  const p = await call('POST', '/api/accounts', { cli: 'codex', name: 'Work' });
  assert.equal(p.accounts.codex[0].name, 'work');
  assert.ok(fs.existsSync(path.join(root, 'codex-work')));
  assert.equal(p.supported.codex.env, 'CODEX_HOME');
  await assert.rejects(call('POST', '/api/accounts', { cli: 'qodercn', name: 'x' }), /ACCOUNT_UNSUPPORTED/);
  await assert.rejects(call('POST', '/api/start', { workspace: ws, roles: [{ name: 'A', adapter: 'codex' }, { name: 'B', adapter: 'codex' }] }), /ACCOUNT_DUPLICATE:codex\/default: A, B/);
  // allowed -> passes the duplicate check (then fails later only because codex is not installed here, or starts)
  await assert.rejects(call('POST', '/api/start', { workspace: ws, allowDuplicateAccounts: true, roles: [{ name: 'A', adapter: 'codex', account: 'nope' }, { name: 'B', adapter: 'codex' }] }), e => !/ACCOUNT_DUPLICATE/.test(e.message));
});

test('accounts: open-account-folder only opens existing account dirs', async t => {
  const ws = tmp(); const root = path.join(ws, 'acct'); const opened = [];
  const app = createApp({ port: 0, dataDir: path.join(ws, 'appdata'), log: () => {}, accountsDir: root, openFolder: d => opened.push(d) });
  const port = await app.listen(); t.after(() => app.close());
  const call = async (m, u, b) => { const r = await fetch(`http://127.0.0.1:${port}${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-cli-conductor': '1' }, body: b && JSON.stringify(b) }); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; };
  await call('POST', '/api/accounts', { cli: 'codex', name: 'second' });
  const r = await call('POST', '/api/open-account-folder', { cli: 'codex', name: 'second' });
  assert.deepEqual(opened, [path.join(root, 'codex-second')]); assert.equal(r.dir, opened[0]);
  await assert.rejects(call('POST', '/api/open-account-folder', { cli: 'codex', name: 'nope' }), /ACCOUNT_MISSING/);
  await assert.rejects(call('POST', '/api/open-account-folder', { cli: 'codex', name: '../..' }), /ACCOUNT_NAME_INVALID/);
  assert.equal(opened.length, 1);
});
