'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { detectFirstRun, compile, BUILTIN } = require('../lib/adapters');
const { splitArgs, resolveSpawn } = require('../lib/scanner');
const { Bridge, sha256File } = require('../lib/bridge');
const { fillBriefing } = require('../lib/briefing');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tbapp-unit-'));
const wait = ms => new Promise(r => setTimeout(r, ms));

test('first-run detector is strict', () => {
  assert.ok(detectFirstRun('Do you trust the files in this folder?'));
  assert.ok(detectFirstRun('Continue anyway? [y/N]: '));
  assert.ok(detectFirstRun('Do you trust the contents of this directory? Working with untrusted contents...'));
  // codex help text that fooled the step-1 probe must not match
  assert.equal(detectFirstRun('/permissions - choose what Codex is allowed to do\n/model - choose what model'), null);
  assert.equal(detectFirstRun('Ask Codex to do anything'), null);
  assert.equal(detectFirstRun('user wrote: do you trust me'), null);
});

test('adapter table compiles busy patterns', () => {
  const codex = compile(BUILTIN.find(a => a.id === 'codex'));
  assert.ok(codex.busyRe[0].test('Working (3s • esc to interrupt)'));
  const q = compile(BUILTIN.find(a => a.id === 'qodercn'));
  assert.ok(q.busyRe.some(r => r.test('Generating... (esc to cancel, 2s)')));
});

test('splitArgs and resolveSpawn', () => {
  assert.deepEqual(splitArgs('--model x "a b" c'), ['--model', 'x', 'a b', 'c']);
  assert.deepEqual(splitArgs(''), []);
  if (process.platform === 'win32') assert.match(resolveSpawn('C:\\x\\q.cmd', ['a']).args.join(' '), /\/c C:\\x\\q\.cmd a/);
});

function stubSession(name) {
  return { name, state: 'idle', writes: [], write(t) { this.writes.push(t); this.state = 'busy'; return Promise.resolve(); } };
}

function mkBridge(extra = {}) {
  const ws = tmp();
  fs.writeFileSync(path.join(ws, 'ref.txt'), 'ref');
  const A = stubSession('A_ROLE'), B = stubSession('B_ROLE');
  const roles = { A_ROLE: { delivery: 'immediate', session: A }, B_ROLE: { delivery: 'immediate', session: B }, OBS: { delivery: 'archive_only', send_policy: 'after_turn', session: null }, ...extra };
  const bridge = new Bridge({ workspace: ws, roles, sendScript: 'send.ps1', configPath: path.join(ws, '.tmp/cli_conductor/app.config.json'), pollMs: 1e9 });
  bridge.start();
  return { ws, A, B, bridge, roles };
}
const kinds = b => b.recent.map(e => e.kind);

test('bridge: queue, deliver via session.write, no resend, config written', async () => {
  const { ws, B, bridge } = mkBridge();
  const q = bridge.enqueue({ from: 'A_ROLE', to: 'B_ROLE', message: 'hello\nsecond line', refs: ['ref.txt'] });
  assert.equal(q.status, 'QUEUED');
  const msg = JSON.parse(fs.readFileSync(q.path, 'utf8'));
  assert.equal(msg.schema, 'CliConductorMessage/v1');
  assert.equal(msg.refs[0].sha256, sha256File(path.join(ws, 'ref.txt')));
  await bridge.poll();
  assert.equal(B.writes.length, 1);
  assert.match(B.writes[0], /\[CLIConductor .* A_ROLE->B_ROLE\]\nhello\nsecond line/);
  assert.match(B.writes[0], /-From B_ROLE -To A_ROLE/);
  assert.deepEqual(kinds(bridge).filter(k => k !== 'FRESH_START'), ['QUEUED', 'UNCERTAIN', 'DELIVERED']);
  B.state = 'idle'; await bridge.poll();
  assert.equal(B.writes.length, 1);
  const cfg = JSON.parse(fs.readFileSync(path.join(ws, '.tmp/cli_conductor/app.config.json'), 'utf8'));
  assert.equal(cfg.schema, 'CliConductorConfig/v1');
  assert.equal(cfg.roles.OBS.delivery, 'archive_only');
  bridge.stop();
});

test('bridge: archive_only observer, after_turn hold, attention hold, reject bad', async () => {
  const { ws, A, B, bridge, roles } = mkBridge();
  bridge.enqueue({ from: 'A_ROLE', to: 'OBS', message: 'fyi' });
  await bridge.poll();
  assert.ok(kinds(bridge).includes('ARCHIVED'));
  assert.equal(fs.readdirSync(path.join(ws, '.tmp/cli_conductor/inbox/OBS')).length, 1);
  // observer -> busy target: held until idle (send_policy after_turn)
  B.state = 'busy';
  bridge.enqueue({ from: 'OBS', to: 'B_ROLE', message: 'note' });
  await bridge.poll();
  assert.equal(B.writes.length, 0);
  assert.equal(bridge.recent.at(-1).detail.reason, 'waiting_for_turn_end');
  B.state = 'idle'; await bridge.poll();
  assert.equal(B.writes.length, 1);
  // attention blocks even immediate
  A.state = 'attention';
  bridge.enqueue({ from: 'B_ROLE', to: 'A_ROLE', message: 'x' });
  await bridge.poll();
  assert.equal(A.writes.length, 0);
  assert.equal(bridge.recent.at(-1).detail.reason, 'target_needs_attention');
  A.state = 'idle'; await bridge.poll();
  assert.equal(A.writes.length, 1);
  // stale ref + bad route
  fs.writeFileSync(path.join(bridge.p.outbox, 'bad.json'), '{');
  const q = bridge.enqueue({ from: 'A_ROLE', to: 'B_ROLE', message: 'r', refs: ['ref.txt'] });
  fs.writeFileSync(path.join(ws, 'ref.txt'), 'changed');
  B.state = 'idle'; await bridge.poll();
  const rej = bridge.recent.filter(e => e.kind === 'REJECTED').map(e => e.detail.reason).join(' ');
  assert.match(rej, /REF_HASH_MISMATCH/);
  assert.ok(bridge.state.rejected['bad.json']);
  assert.throws(() => bridge.enqueue({ from: 'A_ROLE', to: 'A_ROLE', message: 'x' }), /ROUTE/);
  assert.throws(() => bridge.enqueue({ from: 'A_ROLE', to: 'B_ROLE', message: 'x', refs: ['..\\..\\outside.txt'] }), /REF_ESCAPE|REF_MISSING/);
  bridge.stop();
});

test('bridge: pause, client_key duplicate, fresh start ignores old files', async () => {
  const ws = tmp();
  const ob = path.join(ws, '.tmp/cli_conductor/outbox'); fs.mkdirSync(ob, { recursive: true });
  fs.writeFileSync(path.join(ob, 'old.json'), JSON.stringify({ schema: 'CliConductorMessage/v1', message_id: 'old', from: 'A_ROLE', to: 'B_ROLE', message: 'old', reply_required: false, refs: [] }));
  const B = stubSession('B_ROLE');
  const bridge = new Bridge({ workspace: ws, roles: { A_ROLE: { delivery: 'immediate', session: stubSession('A') }, B_ROLE: { delivery: 'immediate', session: B } }, pollMs: 1e9 });
  bridge.start();
  await bridge.poll();
  assert.equal(B.writes.length, 0);
  bridge.setPaused(true);
  const a = bridge.enqueue({ from: 'A_ROLE', to: 'B_ROLE', message: 'k', client_key: 'ck' });
  const b = bridge.enqueue({ from: 'A_ROLE', to: 'B_ROLE', message: 'k', client_key: 'ck' });
  assert.equal(b.status, 'DUPLICATE'); assert.equal(b.message_id, a.message_id);
  await bridge.poll();
  assert.equal(B.writes.length, 0);
  assert.ok(kinds(bridge).includes('PAUSED'));
  bridge.setPaused(false); await bridge.poll();
  assert.equal(B.writes.length, 1);
  assert.equal(bridge.status().counts.outbox, 0);
  bridge.stop();
});
test('briefing: empty briefing sends nothing extra', async () => {
  const { A, B, bridge } = mkBridge({ A_ROLE: { delivery: 'immediate', session: stubSession('A_ROLE'), briefing: '   ' } });
  const A2 = bridge.roles.A_ROLE.session;
  await bridge.poll();
  assert.equal(A2.writes.length, 0); assert.equal(B.writes.length, 0);
  assert.ok(!kinds(bridge).includes('BRIEFED'));
  bridge.enqueue({ from: 'B_ROLE', to: 'A_ROLE', message: 'hi' });
  await bridge.poll();
  assert.equal(A2.writes.length, 1); assert.match(A2.writes[0], /\nhi\n/);
  bridge.stop();
});

test('briefing: non-empty is sent once, first, and holds bridged messages', async () => {
  const B = stubSession('B_ROLE'); B.state = 'starting';
  const { A, bridge } = mkBridge({ B_ROLE: { delivery: 'immediate', session: B, briefing: 'You are B_ROLE.' } });
  bridge.enqueue({ from: 'A_ROLE', to: 'B_ROLE', message: 'task 1' });
  await bridge.poll();
  assert.equal(B.writes.length, 0, 'nothing before ready');
  assert.equal(bridge.recent.at(-1).detail.reason, 'target_starting');
  B.state = 'idle'; await bridge.poll();
  assert.deepEqual(B.writes, ['You are B_ROLE.'], 'briefing first, message held in same poll');
  assert.ok(kinds(bridge).includes('BRIEFED'));
  B.state = 'idle'; await bridge.poll();
  assert.equal(B.writes.length, 2); assert.match(B.writes[1], /task 1/);
  B.state = 'idle'; await bridge.poll(); await bridge.poll();
  assert.equal(B.writes.filter(w => w === 'You are B_ROLE.').length, 1, 'sent only once');
  assert.equal(A.writes.length, 0);
  bridge.stop();
});

test('briefing: waits while target needs attention', async () => {
  const B = stubSession('B_ROLE'); B.state = 'attention';
  const { bridge } = mkBridge({ B_ROLE: { delivery: 'immediate', session: B, briefing: 'hello' } });
  await bridge.poll(); assert.equal(B.writes.length, 0);
  B.state = 'idle'; await bridge.poll(); assert.deepEqual(B.writes, ['hello']);
  bridge.stop();
});

test('briefing: placeholders are filled', () => {
  const out = fillBriefing('I am {role}; peers {peers}; in {workspace}; send {send}; keep {other}', { role: 'CODER', peers: 'REVIEWER, OBS (observer)', workspace: 'C:\\w', send: 'pwsh x' });
  assert.equal(out, 'I am CODER; peers REVIEWER, OBS (observer); in C:\\w; send pwsh x; keep {other}');
  assert.equal(fillBriefing('', {}), '');
});

const { buildArgs, capabilities, SPECS } = require('../lib/cliflags');
test('cliflags: codex resume subcommand goes first, raw args last', () => {
  assert.deepEqual(buildArgs('codex', { resume: 'last', model: 'gpt-5.5', perm: 'edit' }, '--search'), ['resume', '--last', '-m', 'gpt-5.5', '--sandbox', 'workspace-write', '--search']);
  assert.deepEqual(buildArgs('codex', { resume: 'id', resumeId: 'abc' }, '', ['--x']), ['resume', 'abc', '--x']);
  assert.deepEqual(buildArgs('codex', { skipAll: true, perm: 'readonly' }), ['--dangerously-bypass-approvals-and-sandbox'], 'yolo excludes --sandbox');
  assert.deepEqual(buildArgs('codex', { addDirs: ['D:\\a', ' ', 'D:\\b'] }), ['--add-dir', 'D:\\a', '--add-dir', 'D:\\b']);
});
test('cliflags: claude effort/perm/resume, gemini resume latest, cline has no skip-all', () => {
  assert.deepEqual(buildArgs('claude', { effort: 'high', perm: 'edit', resume: 'last' }), ['--continue', '--effort', 'high', '--permission-mode', 'acceptEdits']);
  assert.deepEqual(buildArgs('claude', { effort: 'bogus' }), []);
  assert.deepEqual(buildArgs('gemini', { resume: 'last', addDirs: ['a', 'b'] }), ['--resume', 'latest', '--include-directories', 'a,b']);
  assert.equal(capabilities('cline').skipAll, false);
  assert.deepEqual(buildArgs('cline', { skipAll: true, effort: 'low' }), ['--thinking', 'low']);
  assert.deepEqual(buildArgs('kiro', { resume: 'id', resumeId: 'r1' }), ['chat', '--resume-id', 'r1']);
  assert.deepEqual(buildArgs('amp', { resume: 'id', resumeId: 'T-1', skipAll: true }), ['threads', 'continue', 'T-1', '--dangerously-allow-all']);
  assert.deepEqual(buildArgs('mycustom', { model: 'x', skipAll: true }, '--a "b c"'), ['--a', 'b c'], 'custom CLI: raw args only');
});
test('cliflags: picker-opening resume forms are never emitted', () => {
  for (const id of Object.keys(SPECS)) {
    const noId = buildArgs(id, { resume: 'id', resumeId: '  ' });
    assert.deepEqual(noId, [...(SPECS[id].base || [])], `${id}: empty id emits nothing`);
    const last = buildArgs(id, { resume: 'last' });
    const s = last.join(' ');
    assert.ok(!/^resume$|(^| )-r$|--resume-picker|^resume( |$)(?!--last)/.test(s) || /resume --last/.test(s), `${id}: ${s}`);
    if (id === 'codex') assert.deepEqual(last, ['resume', '--last']);
    if (['claude', 'qoder', 'qodercn', 'auggie'].includes(id)) assert.ok(!last.includes('--resume') && !last.includes('-r'), `${id} uses --continue`);
  }
  assert.deepEqual(buildArgs('iflow', { resume: 'id', resumeId: 'x' }), [], 'iflow has no id resume (would open a picker)');
});

const { RoleSession } = require('../lib/session');
const { compile: compileAd } = require('../lib/adapters');
// RoleSession with a fake PTY: ignoresCr = number of \r to swallow; busy = whether it ever shows a busy line.
function fakeRole({ ignoresCr = 0, goesBusy = true, busyRe = ['esc to interrupt'] } = {}) {
  const s = new RoleSession({ name: 'R', adapter: compileAd({ id: 'fake', busy: busyRe }), file: 'x', idleMs: 300, submitDelayMs: 20, submitVerifyMs: [250, 300, 350], turnMaxWaitMs: 2000 });
  const { Terminal } = require('@xterm/headless');
  s.head = new Terminal({ cols: 80, rows: 10, allowProposedApi: true });
  s.crSeen = 0; s.state = 'idle';
  s.pty = { write: d => {
    if (d !== '\r') { s.onData('> pasted'); return; }
    s.crSeen++;
    if (s.crSeen <= ignoresCr || !goesBusy) return;
    s.onData('\r\n• Working (3s • esc to interrupt)\r\n');
    setTimeout(() => s.onData('\x1b[2J\x1b[HANSWER done\r\n> '), 400);
  } };
  s.timer = setInterval(() => s.tick(), 50);
  const turns = []; s.on('turn_end', t => turns.push(t));
  return { s, turns, stop: () => clearInterval(s.timer) };
}
function withRole(t, opts) { const r = fakeRole(opts); t.after(r.stop); return r;
}
test('session: first \\r swallowed -> retry, confirmed, real turn end', async t => {
  const { s, turns, stop } = withRole(t, { ignoresCr: 1 });
  const res = await s.write('hello');
  assert.deepEqual(res, { confirmed: true, attempts: 2 });
  assert.equal(s.crSeen, 2);
  await wait(1200);
  assert.equal(turns.length, 1); assert.equal(turns[0].sawBusy, true);
  stop();
});
test('session+bridge: never busy -> SUBMIT_UNCONFIRMED, held, no TURN_END, no resend', async t => {
  const { s, turns, stop } = withRole(t, { goesBusy: false });
  const ws = tmp();
  const bridge = new Bridge({ workspace: ws, roles: { A_ROLE: { delivery: 'immediate', session: stubSession('A_ROLE') }, B_ROLE: { delivery: 'immediate', session: s } }, pollMs: 1e9 });
  bridge.start();
  bridge.enqueue({ from: 'A_ROLE', to: 'B_ROLE', message: 'one' });
  bridge.enqueue({ from: 'A_ROLE', to: 'B_ROLE', message: 'two' });
  await bridge.poll();
  assert.equal(s.crSeen, 3, 'initial + 2 retries');
  assert.ok(kinds(bridge).includes('SUBMIT_UNCONFIRMED'));
  assert.ok(!kinds(bridge).includes('DELIVERED'));
  assert.equal(s.state, 'attention'); assert.equal(s.attention, 'SUBMIT_UNCONFIRMED');
  await wait(800);
  assert.equal(s.state, 'attention', 'sticky until a human types');
  assert.equal(turns.length, 0);
  await bridge.poll();
  assert.equal(s.crSeen, 3, 'nothing resent, second message held');
  assert.equal(bridge.recent.at(-1).detail.reason, 'target_needs_attention');
  assert.equal(bridge.status().counts.unconfirmed, 1);
  stop(); bridge.stop();
});
test('session: no busy regex -> output after submit confirms; quiet screen does not', async t => {
  const a = withRole(t, { busyRe: [] });
  assert.equal((await a.s.write('x')).confirmed, true); a.stop();
  const b = withRole(t, { busyRe: [], goesBusy: false });
  assert.equal((await b.s.write('x')).confirmed, false); b.stop();
});
