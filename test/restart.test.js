'use strict';
// Single-CLI restart with a real ConPTY + fake CLI: messages to the role are held while it
// restarts and delivered once it is ready; force kill when the exit command is ignored.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');

const FAKE = path.join(__dirname, 'fake-cli.js');
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 20000, step = 100) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(step); } throw new Error('timeout waiting for condition'); }
const readLog = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];

test('restart-role holds messages (reason restarting) and redelivers after ready; same args/env; stop-role', { timeout: 90000 }, async t => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'tbapp-rst-'));
  const acct = path.join(ws, 'accounts');
  const app = createApp({ port: 0, dataDir: path.join(ws, 'appdata'), log: () => {}, accountsDir: acct });
  await app.listen();
  t.after(async () => { await app.close(); });
  fs.writeFileSync(path.join(ws, 'appdata', 'adapters.json'), JSON.stringify([{ id: 'fake', label: 'fake', commands: [process.execPath], busy: ['esc to interrupt'], exit: '/exit', args: [FAKE] }]));
  const log = path.join(ws, 'fake.log'); process.env.FAKE_LOG = log;
  await app.start({ workspace: ws, idleMs: 800, pollMs: 200, roles: [
    { name: 'A', type: 'agent', adapter: 'fake', delivery: 'immediate', args: '--work=300' },
    { name: 'B', type: 'agent', adapter: 'fake', delivery: 'immediate', args: '--work=300 --ignore-exit' },
  ] });
  const run = app.run, b = run.bridge, sB = run.sessions.B;
  await until(() => sB.state === 'idle');
  const pid1 = sB.pid, args1 = sB.args.slice();
  const events = []; b.on('event', e => events.push(e));

  const p = app.restartRole('B', { graceMs: 800 }); // B ignores /exit -> force kill after 800ms
  await until(() => sB.state === 'restarting', 3000, 20);
  b.enqueue({ from: 'A', to: 'B', message: 'during restart', reply_required: false });
  await until(() => events.some(e => e.kind === 'HELD' && e.detail.reason === 'restarting'), 5000, 50);
  assert.ok(!events.some(e => e.kind === 'DELIVERED'), 'nothing delivered while restarting');
  await p;
  assert.notEqual(sB.pid, pid1, 'new process');
  assert.deepEqual(sB.args, args1, 'same args');
  assert.ok(events.some(e => e.kind === 'ROLE_RESTARTED' && e.to === '' && e.from === 'B'));
  assert.ok(!events.some(e => e.kind === 'ROLE_EXITED'), 'restart exit is not reported as a crash');
  await until(() => events.some(e => e.kind === 'DELIVERED' && e.to === 'B'), 20000);
  await until(() => readLog(log).some(l => /during restart/.test(l.line)));
  assert.equal(readLog(log).filter(l => /during restart/.test(l.line)).length, 1, 'delivered exactly once');

  // stop-role: offline + held with reason role_stopped
  await app.stopRole('A');
  assert.equal(run.sessions.A.state, 'offline');
  assert.equal(run.sessions.A.info().stopped, true);
  b.enqueue({ from: 'B', to: 'A', message: 'to stopped', reply_required: false });
  await until(() => events.some(e => e.kind === 'HELD' && e.detail.reason === 'role_stopped'), 5000, 50);
  assert.ok(events.some(e => e.kind === 'ROLE_STOPPED' && e.from === 'A'));
  // restart brings a stopped role back and delivers the held message
  await app.restartRole('A', { graceMs: 500 });
  await until(() => readLog(log).some(l => /to stopped/.test(l.line)), 20000);
  delete process.env.FAKE_LOG;
});
