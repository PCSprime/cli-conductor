'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const uistate = require('../lib/uistate');
const { parseOutput, psScript } = require('../lib/folderpicker');
const { createApp } = require('../server');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tbapp-ui-'));

test('uistate: recent dirs dedupe, newest first, capped; hide/unhide', () => {
  const f = path.join(tmp(), 'ui.json');
  assert.deepEqual(uistate.load(f), { recentDirs: [], hiddenAdapters: [] });
  for (let i = 0; i < 10; i++) uistate.apply(f, { addRecent: `C:\\p${i}` });
  let s = uistate.apply(f, { addRecent: 'c:\\P3' });
  assert.equal(s.recentDirs[0], 'c:\\P3');
  assert.equal(s.recentDirs.length, uistate.MAX_RECENT);
  assert.equal(s.recentDirs.filter(d => d.toLowerCase() === 'c:\\p3').length, 1);
  s = uistate.apply(f, { hide: 'gemini' }); s = uistate.apply(f, { hide: 'gemini' });
  assert.deepEqual(s.hiddenAdapters, ['gemini']);
  s = uistate.apply(f, { hide: '../bad id' });
  assert.deepEqual(s.hiddenAdapters, ['gemini']);
  s = uistate.apply(f, { unhide: 'gemini' });
  assert.deepEqual(s.hiddenAdapters, []);
});

test('folderpicker: output parsing and script quoting', () => {
  assert.deepEqual(parseOutput('noise\r\nPICKED:D:\\work dir\\a\r\n'), { path: 'D:\\work dir\\a' });
  assert.deepEqual(parseOutput('CANCELLED\r\n'), { path: null, cancelled: true });
  assert.deepEqual(parseOutput(''), { path: null, cancelled: true });
  const s = psScript("C:\\it's");
  assert.match(s, /\$i='C:\\it''s'/);
  assert.match(s, /FolderBrowserDialog/);
  assert.match(s, /TopMost=\$true/);
});

test('api: /api/pick-folder uses injected picker, records recent; /api/ui-state', async () => {
  const dataDir = tmp();
  let calls = 0;
  const app = createApp({ port: 0, dataDir, log: () => {}, pickFolder: async ({ initial }) => { calls++; return initial === 'cancel' ? { path: null, cancelled: true } : { path: 'D:\\picked' }; } });
  const port = await app.listen();
  const call = async (method, url, body) => { const r = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { 'content-type': 'application/json', 'x-cli-conductor': '1' }, body: body ? JSON.stringify(body) : undefined }); return [r.status, await r.json()]; };
  try {
    let [st, j] = await call('POST', '/api/pick-folder', { initial: 'x' });
    assert.equal(st, 200); assert.equal(j.path, 'D:\\picked');
    [st, j] = await call('POST', '/api/pick-folder', { initial: 'cancel' });
    assert.equal(j.cancelled, true);
    [st, j] = await call('GET', '/api/ui-state');
    assert.deepEqual(j.recentDirs, ['D:\\picked']);
    [st, j] = await call('POST', '/api/ui-state', { hide: 'codex' });
    assert.deepEqual(j.hiddenAdapters, ['codex']);
    const r = await fetch(`http://127.0.0.1:${port}/api/pick-folder`, { method: 'POST', body: '{}' });
    assert.equal(r.status, 403, 'needs x-cli-conductor header');
    assert.equal(calls, 2);
  } finally { await app.close(); }
});

test('api: briefing helpers (/briefing.js, preview-args resumes, rebrief needs a run)', async () => {
  const app = createApp({ port: 0, dataDir: tmp(), log: () => {} });
  const port = await app.listen();
  const call = async (method, url, body) => { const r = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { 'content-type': 'application/json', 'x-cli-conductor': '1' }, body: body ? JSON.stringify(body) : undefined }); return [r.status, await r.json()]; };
  try {
    const js = await fetch(`http://127.0.0.1:${port}/briefing.js`);
    assert.equal(js.status, 200); assert.match(await js.text(), /composeBriefing/);
    let [st, j] = await call('POST', '/api/preview-args', { adapter: 'qodercn', options: {}, args: '--resume abc' });
    assert.equal(st, 200); assert.equal(j.resumes, true);
    [st, j] = await call('POST', '/api/preview-args', { adapter: 'codex', options: { resume: 'off' }, args: '' });
    assert.equal(j.resumes, false);
    [st, j] = await call('GET', '/api/defaults');
    assert.ok(j.briefing && j.briefing.sendScript && j.briefing.stateDir);
    [st, j] = await call('POST', '/api/rebrief', { role: 'CODER' });
    assert.equal(st, 400); assert.match(j.error, /NOT_RUNNING/);
    [st, j] = await call('GET', '/api/status');
    assert.deepEqual(j, { running: false });
  } finally { await app.close(); }
});
