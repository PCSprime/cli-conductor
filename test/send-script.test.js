'use strict';
// The agent-facing reply script (tools/cli_conductor_send.ps1): POSTs to the running server,
// falls back to the outbox file queue, never prompts, prints one line. Needs pwsh 7 (skipped without).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { createApp } = require('../server');

const PWSH = process.env.PWSH || 'pwsh';
const hasPwsh = spawnSync(PWSH, ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).status === 0;
const SCRIPT = path.join(__dirname, '..', 'tools', 'cli_conductor_send.ps1');
const FAKE = path.join(__dirname, 'fake-cli.js');
const wait = ms => new Promise(r => setTimeout(r, ms));
// Progress goes to stderr right away: if the process dies (e.g. a native crash in node-pty/ConPTY),
// node:test only reports 'test failed' for the file, and these lines show how far it got.
const step = s => process.stderr.write(`[send-script] ${s}\n`);
process.on('exit', c => { if (c) process.stderr.write(`[send-script] process exit code ${c}\n`); });
// Progress goes to stderr right away: if the process dies (e.g. a native crash in node-pty/ConPTY),
// node:test only reports 'test failed' for the file, and these lines show how far it got.
const step = s => process.stderr.write(`[send-script] ${s}\n`);
process.on('exit', c => { if (c) process.stderr.write(`[send-script] process exit code ${c}\n`); });
async function until(fn, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(200); } throw new Error('timeout'); }
// stdin stays open (like an agent's shell): a parameter prompt would hang, so a time limit catches it.
function send(args, env = {}, limitMs = 25000) {
  return new Promise(resolve => {
    const p = spawn(PWSH, ['-NoProfile', '-NonInteractive', '-File', SCRIPT, ...args], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', t0 = Date.now();
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    const k = setTimeout(() => p.kill(), limitMs);
    p.on('exit', code => { clearTimeout(k); resolve({ code, out: out.trim(), ms: Date.now() - t0 }); });
  });
}

test('send script: server path, MessagePath, string booleans, errors, file fallback', { skip: !hasPwsh && 'pwsh not installed', timeout: 180000 }, async t => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-send-'));
  const app = createApp({ port: 0, dataDir: path.join(ws, 'appdata'), log: () => {} });
  const port = await app.listen();
  // Stop the PTY sessions before closing the server, even when an assertion fails mid-test.
  t.after(async () => { try { await call('POST', '/api/stop'); } catch { } await app.close(); });
  const call = async (m, u, b) => { const r = await fetch(`http://127.0.0.1:${port}${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-cli-conductor': '1' }, body: b && JSON.stringify(b) }); return r.json(); };
  await call('POST', '/api/adapters', { label: 'fake', command: process.execPath, args: `"${FAKE}"`, busy: ['esc to interrupt'], exit: '/exit' });
  await call('POST', '/api/start', { workspace: ws, idleMs: 1000, pollMs: 300, roles: [
    { name: 'CODER', type: 'agent', adapter: 'fake', delivery: 'immediate', args: '--work=300' },
    { name: 'REVIEWER', type: 'agent', adapter: 'fake', delivery: 'immediate', args: '--work=300' }] });
  const cfg = path.join(ws, '.tmp', 'cli_conductor', 'app.config.json');
  assert.equal(JSON.parse(fs.readFileSync(cfg, 'utf8')).server.url, `http://127.0.0.1:${port}`);

  step('1 server path');
  step('1 server path');
  // 1) the reported command line: no -RefPath, "-ReplyRequired $false" as text → queued via the server, fast
  let r = await send(['-ConfigPath', cfg, '-From', 'CODER', '-To', 'REVIEWER', '-Message', 'done, no reply', '-ReplyRequired', '$false']);
  assert.equal(r.code, 0, r.out); assert.match(r.out, /^QUEUED \S+-CODER-TO-REVIEWER-\S+ CODER->REVIEWER reply_required=false$/); assert.ok(r.ms < 20000);
  const id1 = r.out.split(' ')[1];
  await until(async () => (await call('GET', '/api/status')).events.some(e => e.kind === 'QUEUED' && e.message_id === id1));

  step('2 MessagePath');
  step('2 MessagePath');
  // 2) -MessagePath (UTF-8, multi-line, quotes) and the -ReplyRequired:0 / -NoReply forms
  const mp = path.join(ws, 'msg.md'); fs.writeFileSync(mp, '第一行 "quoted" $(not run)\nsecond line\n');
  r = await send(['-ConfigPath', cfg, '-From', 'REVIEWER', '-To', 'CODER', '-MessagePath', mp, '-NoReply']);
  assert.equal(r.code, 0, r.out); assert.match(r.out, /^QUEUED .* reply_required=false$/);
  const file = path.join(ws, '.tmp', 'cli_conductor', 'outbox', r.out.split(' ')[1] + '.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).message, '第一行 "quoted" $(not run)\nsecond line\n');
  r = await send(['-ConfigPath', cfg, '-From', 'CODER', '-To', 'REVIEWER', '-Message', 'x', '-ReplyRequired:0']);
  assert.match(r.out, /reply_required=false$/);

  step('3 errors');
  step('3 errors');
  // 3) errors are one line, exit 1, no prompt
  r = await send(['-ConfigPath', cfg, '-From', 'CODER', '-To', 'REVIEWER']);
  assert.equal(r.code, 1); assert.match(r.out, /^ERROR ARGS: need -Message/);
  r = await send(['-ConfigPath', cfg, '-From', 'CODER', '-To', 'NOBODY', '-Message', 'x']);
  assert.equal(r.code, 1); assert.match(r.out, /^ERROR MESSAGE_ROUTE_INVALID/);
  r = await send(['-ConfigPath', cfg, '-From', 'CODER', '-To', 'REVIEWER', '-Message', 'x', '-ReplyRequired', 'maybe']);
  assert.equal(r.code, 1); assert.match(r.out, /^ERROR ARGS: -ReplyRequired/);

  step('3b port');
  step('3b port');
  // 3b) -Port alone (no config file) works; no server and no config → clear error
  r = await send(['-Port', String(port), '-From', 'CODER', '-To', 'REVIEWER', '-Message', 'via port', '-NoReply']);
  assert.equal(r.code, 0, r.out); assert.match(r.out, /^QUEUED /);
  r = await send(['-Port', '9', '-From', 'CODER', '-To', 'REVIEWER', '-Message', 'x', '-TimeoutSec', '2']);
  assert.equal(r.code, 1); assert.match(r.out, /^ERROR NO_SERVER: no server at http:\/\/127\.0\.0\.1:9/);

  step('4 file fallback');
  step('4 file fallback');
  // 4) no server reachable → bounded file-queue fallback with a clear note
  const dead = JSON.parse(fs.readFileSync(cfg, 'utf8')); dead.server.url = 'http://127.0.0.1:9'; const cfg2 = path.join(ws, '.tmp', 'cli_conductor', 'dead.config.json');
  fs.writeFileSync(cfg2, JSON.stringify(dead));
  r = await send(['-ConfigPath', cfg2, '-From', 'CODER', '-To', 'REVIEWER', '-Message', 'offline', '-TimeoutSec', '3']);
  assert.equal(r.code, 0, r.out); assert.match(r.out, /^QUEUED \S+ CODER->REVIEWER \(file queue; no server at http:\/\/127\.0\.0\.1:9/);
  assert.ok(fs.existsSync(path.join(ws, '.tmp', 'cli_conductor', 'outbox', r.out.split(' ')[1] + '.json')));
  step('stop');
  await call('POST', '/api/stop');
  step('done');
});
