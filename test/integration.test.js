'use strict';
// Integration: real server + real ConPTY + fake CLI. No real AI CLI, no windows, no focus.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { createApp } = require('../server');

const FAKE = path.join(__dirname, 'fake-cli.js');
const wait = ms => new Promise(r => setTimeout(r, ms));
// Progress goes to stderr right away (with elapsed ms): if the process dies (e.g. a native crash in
// node-pty/ConPTY, exit 0xC0000005), node:test only reports 'test failed' for the file.
const T0 = Date.now();
const step = s => process.stderr.write(`[integration +${Date.now() - T0}ms] ${s}\n`);
process.on('exit', c => { if (c) process.stderr.write(`[integration] process exit code ${c}\n`); });
async function until(fn, ms = 20000, step = 200) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(step); } throw new Error('timeout waiting for condition'); }
const readLog = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];

test('end to end with fake CLIs in ConPTY', { timeout: 120000 }, async t => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'tbapp-int-'));
  for (const d of ['a', 'b', 'c']) fs.mkdirSync(path.join(ws, d));
  fs.writeFileSync(path.join(ws, 'ref.txt'), 'ref');
  const app = createApp({ port: 0, dataDir: path.join(ws, 'appdata'), log: () => {} });
  const port = await app.listen();
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, url, body) => { const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-cli-conductor': '1' }, body: body && JSON.stringify(body) }); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; };
  // Stop the PTY sessions before closing the server, even when an assertion fails mid-test.
  t.after(async () => { try { await call('POST', '/api/stop'); } catch { } await app.close(); });

  step('security');
  // security: POST without the custom header and foreign Origin are refused
  assert.equal((await fetch(base + '/api/stop', { method: 'POST' })).status, 403);
  assert.equal((await fetch(base + '/api/status', { headers: { origin: 'http://evil.example' } })).status, 403);

  step('adapter');
  // manual adapter: node + fake-cli.js
  const adapters = await call('POST', '/api/adapters', { label: 'fake', command: process.execPath, args: `"${FAKE}"`, busy: ['esc to interrupt'], exit: '/exit' });
  assert.ok(adapters.find(a => a.id === 'fake' && a.path));
  await call('POST', '/api/presets', { name: 'p1', config: { workspace: ws } });
  assert.ok((await call('GET', '/api/presets')).p1);

  const st = await call('POST', '/api/start', { workspace: ws, idleMs: 1200, pollMs: 300, roles: [
    { name: 'CODER', type: 'agent', adapter: 'fake', delivery: 'immediate', cwd: 'a', args: '--work=800' },
    { name: 'REVIEWER', type: 'agent', adapter: 'fake', delivery: 'after_turn', cwd: 'b', args: '--work=2500' },
    { name: 'GATED', type: 'agent', adapter: 'fake', delivery: 'immediate', cwd: 'c', args: '--trust' },
    { name: 'OBSERVER', type: 'observer' },
    { name: 'DISABLED', type: 'agent', adapter: 'fake', enabled: false },
  ] });
  assert.equal(st.running, true);
  assert.equal(st.roles.length, 4);

  step('started; websocket');
  // websocket gets snapshot/output
  const sock = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const seen = []; sock.on('message', m => seen.push(JSON.parse(m)));
  t.after(() => sock.close());

  const role = async n => (await call('GET', '/api/status')).roles.find(r => r.name === n);
  await until(async () => (await role('CODER')).state === 'idle');
  await until(async () => (await role('REVIEWER')).state === 'idle');
  await until(async () => (await role('GATED')).state === 'attention');

  step('1 multi-line send');
  // 1) CODER -> REVIEWER, multi-line, lands as ONE prompt in the PTY
  await call('POST', '/api/send', { from: 'CODER', to: 'REVIEWER', message: 'first line\nsecond line', refs: ['ref.txt'] });
  const logB = path.join(ws, 'b', 'fake.log');
  const got = await until(() => readLog(logB)[0]);
  assert.match(got.line, /^\[CLIConductor .* CODER->REVIEWER\]\nfirst line\nsecond line\n/);
  assert.match(got.line, /-ConfigPath ".*app\.config\.json" -From REVIEWER -To CODER/);
  assert.equal(readLog(logB).length, 1, 'exactly one submission');

  step('2 after_turn hold');
  // 2) REVIEWER is after_turn and now busy (2.5s): next message is held until the turn ends
  await until(async () => (await role('REVIEWER')).state === 'busy', 5000);
  await call('POST', '/api/send', { from: 'CODER', to: 'REVIEWER', message: 'second message' });
  await wait(1000);
  assert.equal(readLog(logB).length, 1, 'held while busy');
  let s = await call('GET', '/api/status');
  assert.ok(s.bridge.held.some(h => h.reason === 'waiting_for_turn_end'));
  await until(() => readLog(logB).length === 2, 15000);
  s = await call('GET', '/api/status');
  assert.ok(s.events.some(e => e.kind === 'TURN_END' && e.from === 'REVIEWER'));

  step('3 observer archive');
  // 3) observer archive + screen shows the answer
  await call('POST', '/api/send', { from: 'REVIEWER', to: 'OBSERVER', message: 'fyi', reply_required: false });
  await until(() => fs.readdirSync(path.join(ws, '.tmp/cli_conductor/inbox/OBSERVER')).length === 1);
  const scr = await call('GET', '/api/screen?role=REVIEWER');
  assert.match(scr.screen, /ANSWER:\[CLIConductor/);

  step('4 gated attention');
  // 4) GATED shows a trust prompt: held, never auto-answered; human answers via input -> delivered
  await call('POST', '/api/send', { from: 'CODER', to: 'GATED', message: 'gated hello' });
  await wait(1200);
  const logC = path.join(ws, 'c', 'fake.log');
  assert.equal(readLog(logC).length, 0);
  assert.ok((await call('GET', '/api/status')).bridge.held.some(h => h.reason === 'target_needs_attention'));
  sock.send(JSON.stringify({ type: 'input', role: 'GATED', data: 'y' }));
  await until(() => readLog(logC).length === 1, 15000);

  step('5 on-disk format');
  // 5) on-disk format: events/state/heartbeat compatible with the PowerShell tools
  const ev = fs.readFileSync(path.join(ws, '.tmp/cli_conductor/events.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  for (const k of ['FRESH_START', 'QUEUED', 'UNCERTAIN', 'DELIVERED', 'HELD', 'ARCHIVED', 'ATTENTION', 'TURN_END']) assert.ok(ev.some(e => e.kind === k), k);
  assert.ok(ev.filter(e => e.kind === 'DELIVERED').every(e => e.detail.delivery_confirmed === false));
  assert.ok(fs.existsSync(path.join(ws, '.tmp/cli_conductor/heartbeat.json')));
  assert.ok(seen.some(m => m.type === 'output' || m.type === 'snapshot'));

  step('6 stop');
  // 6) stop exits all CLIs cleanly via their exit command
  const pids = (await call('GET', '/api/status')).roles.filter(r => r.pid).map(r => r.pid);
  await call('POST', '/api/stop');
  const evs = fs.readFileSync(path.join(ws, '.tmp/cli_conductor/events.jsonl'), 'utf8');
  assert.equal((evs.match(/"ROLE_EXITED"/g) || []).length, 3);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0));
  step('done');
});