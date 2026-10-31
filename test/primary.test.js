'use strict';
// 主账号 switch + resume gate. Uses ONLY temp CODEX_HOME dirs with fake auth.json/registry and
// test/fake-codex-auth.js; the real ~/.codex and the real codex-auth are never touched.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const primary = require('../lib/primary');
const { createApp } = require('../server');

const SHIM = [process.execPath, path.join(__dirname, 'fake-codex-auth.js')];
const NO_DESKTOP = async () => [];
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tbapp-prim-'));
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = c => `${b64({ alg: 'none' })}.${b64(c)}.sig`;
const ACC = {
  al: { user: 'user-al', acc: '11111111-0000-0000-0000-000000000001', email: 'alice@example.com', alias: '' },
  bo: { user: 'user-bo', acc: '22222222-0000-0000-0000-000000000002', email: 'bob@example.org', alias: 'work' },
  ca: { user: 'user-ca', acc: '33333333-0000-0000-0000-000000000003', email: 'carol@example.net', alias: 'x' },
};
const key = a => `${a.user}::${a.acc}`;
const authDoc = (a, gen = 1) => ({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: jwt({ email: a.email, 'https://api.openai.com/auth': { chatgpt_user_id: a.user, chatgpt_plan_type: 'plus' } }), access_token: `access-${a.user}-${gen}`, refresh_token: `refresh-${a.user}-${gen}`, account_id: a.acc }, last_refresh: '2026-10-29T11:33:38Z' });
// Fake home: registry with al + work (+ optional extra), snapshots, live auth.json = al.
function makeHome({ live = 'al', extra = [] } = {}) {
  const home = tmp(); const acc = path.join(home, 'accounts'); fs.mkdirSync(acc, { recursive: true });
  const list = ['al', 'bo', ...extra];
  fs.writeFileSync(path.join(acc, 'registry.json'), JSON.stringify({ schema_version: 4, active_account_key: key(ACC[live]), accounts: list.map(n => ({ account_key: key(ACC[n]), chatgpt_account_id: ACC[n].acc, chatgpt_user_id: ACC[n].user, email: ACC[n].email, alias: ACC[n].alias, plan: 'plus', auth_mode: 'chatgpt' })) }));
  for (const n of list) fs.writeFileSync(primary.snapshotPath(home, key(ACC[n])), JSON.stringify(authDoc(ACC[n])));
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify(authDoc(ACC[live])));
  return home;
}
const readAuth = home => JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'));
const noLock = async () => async () => { };
const mk = (home, o = {}) => primary.createPrimary({ home, accountsDir: path.join(home, 'iso'), dataDir: path.join(home, 'data'), tool: SHIM, desktop: NO_DESKTOP, lock: noLock, ...o });
const withEnv = async (env, fn) => { const old = {}; for (const k in env) { old[k] = process.env[k]; process.env[k] = env[k]; } try { return await fn(); } finally { for (const k in env) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } } };

test('primary: identity + list are masked and never contain tokens', async () => {
  const home = makeHome(); const p = mk(home);
  const l = await p.list();
  assert.equal(l.toolOk, true);
  assert.equal(l.current.email, 'al***@example.com');
  assert.deepEqual(l.accounts.map(a => [a.alias, a.email, a.active]), [['', 'al***@example.com', true], ['work', 'bo***@example.org', false]]);
  const s = JSON.stringify(l); assert.ok(!/access-|refresh-|id_token|eyJ/.test(s), 'no token material');
  assert.equal(primary.maskEmail('AB@x.io'), 'ab***@x.io');
  assert.equal(primary.identityOf({ OPENAI_API_KEY: 'sk-1' }).mode, 'apikey');
  assert.equal(primary.identityOf(null).mode, 'none');
});

test('primary: switch saves the refreshed live login back first, then swaps auth.json', async () => {
  const home = makeHome(); const p = mk(home);
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify(authDoc(ACC.al, 2))); // Codex refreshed tokens
  const r = await p.switchTo(key(ACC.bo), [{ name: 'CODER', state: 'busy' }]);
  assert.equal(r.ok, true); assert.match(r.to, /work/); assert.deepEqual(r.roles, [{ name: 'CODER', state: 'busy' }]);
  assert.equal(readAuth(home).tokens.account_id, ACC.bo.acc);
  const alSnap = JSON.parse(fs.readFileSync(primary.snapshotPath(home, key(ACC.al)), 'utf8'));
  assert.equal(alSnap.tokens.refresh_token, 'refresh-user-al-2', 'refreshed token kept in the snapshot');
  const back = await p.switchTo(key(ACC.al));
  assert.equal(readAuth(home).tokens.refresh_token, 'refresh-user-al-2');
  assert.ok(back.ok);
  assert.equal((await p.switchTo(key(ACC.al))).unchanged, true);
});

test('primary: no switch when the save-back did not happen (refresh token would be lost)', async () => {
  const home = makeHome(); const p = mk(home);
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify(authDoc(ACC.al, 3)));
  const before = fs.readFileSync(path.join(home, 'auth.json'));
  await withEnv({ FAKE_CA_NOSYNC: '1' }, () => assert.rejects(p.switchTo(key(ACC.bo)), /PRIMARY_SAVEBACK_FAILED/));
  assert.deepEqual(fs.readFileSync(path.join(home, 'auth.json')), before);
});

test('primary: wrong login after switch / tool failure -> rollback of auth.json and registry', async () => {
  for (const flag of ['FAKE_CA_SWITCH_BAD', 'FAKE_CA_SWITCH_FAIL']) {
    const home = makeHome({ extra: ['ca'] }); const p = mk(home);
    await p.list(); // settle registry formatting
    const a0 = fs.readFileSync(path.join(home, 'auth.json')), r0 = fs.readFileSync(path.join(home, 'accounts', 'registry.json'));
    await withEnv({ [flag]: '1' }, () => assert.rejects(p.switchTo(key(ACC.bo)), /PRIMARY_SWITCH_FAILED.*rolled back/));
    assert.deepEqual(fs.readFileSync(path.join(home, 'auth.json')), a0, `${flag}: auth.json restored`);
    assert.deepEqual(fs.readFileSync(path.join(home, 'accounts', 'registry.json')), r0, `${flag}: registry restored`);
    assert.equal(p.busy, false);
  }
});

test('primary: desktop app running or unknown blocks; concurrent switch is refused', async () => {
  const home = makeHome(); const a0 = fs.readFileSync(path.join(home, 'auth.json'));
  const p = mk(home, { desktop: async () => [{ pid: 4242, name: 'ChatGPT.exe' }] });
  await assert.rejects(p.switchTo(key(ACC.bo)), /PRIMARY_DESKTOP_RUNNING:ChatGPT\.exe 4242/);
  const pc = await p.precheck(key(ACC.bo), [{ name: 'A', state: 'idle' }]);
  assert.equal(pc.blocked, true); assert.deepEqual(pc.roles, [{ name: 'A', state: 'idle' }]);
  await assert.rejects(mk(home, { desktop: async () => null }).switchTo(key(ACC.bo)), /PRIMARY_DESKTOP_UNKNOWN/);
  assert.deepEqual(fs.readFileSync(path.join(home, 'auth.json')), a0);
  let open; const slow = mk(home, { lock: () => new Promise(r => { open = r; }) });
  const first = slow.switchTo(key(ACC.bo));
  await new Promise(r => setTimeout(r, 20));
  await assert.rejects(slow.switchTo(key(ACC.bo)), /PRIMARY_SWITCH_BUSY/);
  open(async () => { }); await first;
  assert.equal(readAuth(home).tokens.account_id, ACC.bo.acc);
});

test('primary: lock timeout aborts without touching auth.json (injected lock)', async () => {
  const home = makeHome(); const a0 = fs.readFileSync(path.join(home, 'auth.json'));
  const p = mk(home, { lock: async () => { throw new Error('PRIMARY_LOCK_TIMEOUT'); } });
  await assert.rejects(p.switchTo(key(ACC.bo)), /PRIMARY_LOCK_TIMEOUT/);
  assert.deepEqual(fs.readFileSync(path.join(home, 'auth.json')), a0); assert.equal(p.busy, false);
});

test('primary: real auth.lock (LockFileEx) - a held lock makes the switch time out', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const home = makeHome(); const a0 = fs.readFileSync(path.join(home, 'auth.json'));
  const release = await primary.lockAuth(home, 3000); // someone (e.g. Codex refreshing) holds it
  const p = mk(home, { lock: primary.lockAuth, lockTimeoutMs: 800 });
  const t0 = Date.now();
  await assert.rejects(p.switchTo(key(ACC.bo)), /PRIMARY_LOCK_TIMEOUT/);
  assert.ok(Date.now() - t0 >= 700);
  assert.deepEqual(fs.readFileSync(path.join(home, 'auth.json')), a0);
  await release();
  const r = await p.switchTo(key(ACC.bo)); assert.ok(r.ok);
  assert.equal(readAuth(home).tokens.account_id, ACC.bo.acc);
});

// ---------- resume gate ----------
function rollout(home, id, meta, sub = 'sessions/2026/10/09') {
  const d = path.join(home, sub); fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, `rollout-2026-10-09T17-40-16-${id}.jsonl`);
  fs.writeFileSync(f, JSON.stringify({ type: 'session_meta', payload: { id, cwd: meta.cwd || 'F:\\ws', ...(meta.acc ? { creator_user_id: meta.acc.user, creator_account_id: meta.acc.acc } : {}) } }) + '\n{"type":"event_msg"}\n');
  return f;
}
const ID1 = '0190aaaa-0000-7000-8000-000000000001', ID2 = '0190aaaa-0000-7000-8000-000000000002', ID3 = '0190aaaa-0000-7000-8000-000000000003';
test('resume gate (primary): a session created by another login is continued, with a note only', async () => {
  const home = makeHome({ live: 'bo' }); const p = mk(home); await p.list();
  rollout(home, ID1, { acc: ACC.al }); rollout(home, ID2, {});
  const role = id => ({ adapter: 'codex', account: '', options: { resume: 'id', resumeId: id }, cwd: 'F:\\ws' });
  const g = p.checkResume(role(ID1));
  assert.equal(g.ok, true); assert.equal(g.block, undefined);
  assert.deepEqual(g.note, { code: 'OWNER_OTHER', owner: 'al***@example.com', current: 'work（bo***@example.org）' });
  assert.ok(!JSON.stringify(g).includes('alice@'), 'masked');
  assert.deepEqual(p.checkResume(role(ID2)), { ok: true, id: ID2 }, 'unknown creator: plain ok');
  p.recordOwner(ID2, key(ACC.al));
  assert.equal(p.checkResume(role(ID2)).note.code, 'OWNER_OTHER', 'recorded owner used for the note');
  await p.switchTo(key(ACC.al));
  assert.deepEqual(p.checkResume(role(ID1)), { ok: true, id: ID1 }, 'same login: no note');
  p.noteStarted(role(ID1));
  assert.equal(p.ownerOf(ID1, null).source, 'recorded');
  // not a UUID / no resume / other CLI: not checked
  assert.deepEqual(p.checkResume({ adapter: 'codex', options: { resume: 'id', resumeId: 'my-thread' } }), { ok: true });
  assert.deepEqual(p.checkResume({ adapter: 'codex', options: { resume: 'off' } }), { ok: true });
  assert.deepEqual(p.checkResume({ adapter: 'claude', options: { resume: 'id', resumeId: ID1 } }), { ok: true });
});

test('resume gate: resume=last uses the newest session of that folder', async () => {
  const home = makeHome({ live: 'bo' }); const p = mk(home);
  const f1 = rollout(home, ID1, { acc: ACC.al, cwd: 'F:\\ws' }); const f2 = rollout(home, ID2, { acc: ACC.bo, cwd: 'F:\\other' });
  fs.utimesSync(f1, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  const g = p.checkResume({ adapter: 'codex', options: { resume: 'last' }, cwd: 'f:\\WS' });
  assert.equal(g.ok, true); assert.equal(g.id, ID1); assert.equal(g.note.code, 'OWNER_OTHER');
  assert.equal(p.checkResume({ adapter: 'codex', options: { resume: 'last' }, cwd: 'F:\\other' }).ok, true);
  assert.deepEqual(p.checkResume({ adapter: 'codex', options: { resume: 'last' }, cwd: 'F:\\none' }), { ok: true });
  void f2;
});

test('resume gate: compressed (.jsonl.zst), forked (<id>_<id>.jsonl) and index-only sessions count as present', async () => {
  const home = makeHome(); const p = mk(home);
  const d = path.join(home, 'sessions', '2026', '09', '25'); fs.mkdirSync(d, { recursive: true });
  const Z = '0190bbbb-0000-7000-8000-000000000371', F = '0190bbbb-0000-7000-8000-000000000300', X = '0190bbbb-0000-7000-8000-0000000003aa';
  fs.writeFileSync(path.join(d, `rollout-2026-09-25T22-46-55-${Z}.jsonl.zst`), Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));
  fs.writeFileSync(path.join(d, `rollout-2026-09-27T10-11-15-${F}_0190cccc-0000-7000-8000-000000000001.jsonl`), '{"type":"session_meta","payload":{}}\n');
  fs.writeFileSync(path.join(home, 'session_index.jsonl'), JSON.stringify({ id: X, thread_name: 't' }) + '\n');
  const r = id => p.checkResume({ adapter: 'codex', account: '', options: { resume: 'id', resumeId: id }, cwd: 'F:\\ws' });
  for (const id of [Z, F, X]) assert.equal(r(id).ok, true, id);
  assert.equal(r('0190bbbb-0000-7000-8000-0000000003ff').code, 'RESUME_NOT_FOUND');
});

test('resume gate: isolated accounts - session in another home is blocked and named', async () => {
  const home = makeHome(); const iso = path.join(home, 'iso'); fs.mkdirSync(path.join(iso, 'codex-carol'), { recursive: true }); fs.mkdirSync(path.join(iso, 'codex-dave'), { recursive: true });
  const p = mk(home);
  rollout(home, ID1, { acc: ACC.al }); rollout(path.join(iso, 'codex-carol'), ID3, { acc: ACC.ca });
  const r = (account, id) => p.checkResume({ adapter: 'codex', account, options: { resume: 'id', resumeId: id }, cwd: 'F:\\ws' });
  assert.deepEqual([r('dave', ID1).code, r('dave', ID1).where, r('dave', ID1).here], ['RESUME_ELSEWHERE', 'primary', 'codex-dave']);
  assert.deepEqual([r('', ID3).code, r('', ID3).where], ['RESUME_ELSEWHERE', 'codex-carol']);
  assert.equal(r('carol', ID3).ok, true);
  assert.equal(r('dave', ID2).code, 'RESUME_NOT_FOUND');
});

test('api: /api/primary, precheck, switch (fake codex-auth, temp home) and /api/resume-check', async t => {
  const home = makeHome({ live: 'bo' }); const ws = tmp();
  rollout(home, ID1, { acc: ACC.al, cwd: ws });
  const app = createApp({ port: 0, dataDir: path.join(ws, 'appdata'), log: () => { }, accountsDir: path.join(ws, 'acct'), primaryHome: home, primaryOpts: { tool: SHIM, desktop: NO_DESKTOP, lock: noLock } });
  const port = await app.listen(); t.after(() => app.close());
  const call = async (m, u, b) => { const r = await fetch(`http://127.0.0.1:${port}${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-cli-conductor': '1' }, body: b && JSON.stringify(b) }); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; };
  const l = await call('GET', '/api/primary');
  assert.equal(l.current.alias, 'work'); assert.equal(l.accounts.length, 2);
  const rc = await call('POST', '/api/resume-check', { workspace: ws, roles: [{ name: 'reviewer', adapter: 'codex', options: { resume: 'id', resumeId: ID1 } }, { name: 'B', adapter: 'codex' }, { name: 'O', type: 'observer' }] });
  assert.equal(rc.REVIEWER.ok, true); assert.equal(rc.REVIEWER.note.owner, 'al***@example.com'); assert.deepEqual(rc.B, { ok: true }); assert.equal(rc.O, undefined);
  const pc = await call('POST', '/api/primary-precheck', { key: key(ACC.al) });
  assert.deepEqual([pc.blocked, pc.roles], [false, []]);
  const sw = await call('POST', '/api/primary-switch', { key: key(ACC.al) });
  assert.equal(sw.ok, true); assert.equal(sw.list.current.email, 'al***@example.com');
  assert.ok(!JSON.stringify(sw).includes('refresh-'));
  const rc2 = await call('POST', '/api/resume-check', { workspace: ws, roles: [{ name: 'REVIEWER', adapter: 'codex', options: { resume: 'id', resumeId: ID1 } }] });
  assert.deepEqual(rc2.REVIEWER, { ok: true, id: ID1 });
  // start is refused (before any CLI is spawned) only when the session is missing; elsewhere ADAPTER_NOT_FOUND comes first
  await assert.rejects(call('POST', '/api/start', { workspace: ws, allowDuplicateAccounts: true, roles: [{ name: 'DESIGNER', adapter: 'codex', options: { resume: 'id', resumeId: ID3 } }, { name: 'B', adapter: 'codex' }] }), /RESUME_BLOCKED:DESIGNER\(RESUME_NOT_FOUND id=0190aaaa-0000-7000-8000-000000000003|ADAPTER_NOT_FOUND/);
  assert.equal(app.run, null, 'nothing started');
});

test('api: "No saved session found" from the CLI is reported on the role (resumeError)', { timeout: 60000 }, async t => {
  const ws = tmp(); const home = makeHome();
  const app = createApp({ port: 0, dataDir: path.join(ws, 'appdata'), log: () => { }, accountsDir: path.join(ws, 'acct'), primaryHome: home, primaryOpts: { tool: SHIM, desktop: NO_DESKTOP, lock: noLock } });
  await app.listen(); t.after(() => app.close());
  const say = path.join(ws, 'nosession.js');
  fs.writeFileSync(say, `process.stdout.write('ERROR: No saved session found with ID ${ID1}. Run \`codex resume\` without an ID to choose from existing sessions.\\r\\n'); setTimeout(() => process.exit(1), 300);`);
  fs.writeFileSync(path.join(ws, 'appdata', 'adapters.json'), JSON.stringify([{ id: 'nos', label: 'nos', commands: [process.execPath], busy: [], exit: '/exit', args: [say] }, { id: 'idle', label: 'idle', commands: [process.execPath], busy: [], exit: '/exit', args: ['-e', 'setInterval(()=>{},1000)'] }]));
  await app.start({ workspace: ws, idleMs: 500, pollMs: 200, roles: [{ name: 'A', adapter: 'nos' }, { name: 'B', adapter: 'idle' }] });
  const t0 = Date.now(); let info;
  while (Date.now() - t0 < 20000) { info = app.status().roles.find(r => r.name === 'A'); if (info.resumeError && info.state === 'offline') break; await new Promise(r => setTimeout(r, 100)); }
  assert.deepEqual(info.resumeError, { code: 'RESUME_NOT_FOUND_CLI', id: ID1 });
  assert.equal(info.state, 'offline');
});
