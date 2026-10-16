// Fake AI CLI for tests. Raw-mode TUI-ish: shows "fake> ", accepts bracketed paste,
// submits on \r, shows a busy line "(esc to interrupt)" for FAKE_WORK_MS, then prints
// "ANSWER:<first line>" and "Worked for 1s". Logs each submitted prompt to FAKE_LOG.
// FAKE_TRUST=1 shows a trust prompt first and waits for "y".
const fs = require('fs');
const argv = process.argv.slice(2);
const log = process.env.FAKE_LOG || require('path').join(process.cwd(), 'fake.log');
const workMs = Number((argv.find(a => a.startsWith('--work=')) || '--work=1500').slice(7));
// `login` (as in `codex login`): simulate a login by writing $CODEX_HOME/auth.json, then exit.
if (argv.includes('login')) {
  const home = process.env.CODEX_HOME;
  process.stdout.write(`fake login for ${home || '(default home)'}\r\n`);
  setTimeout(() => { if (home) fs.writeFileSync(require('path').join(home, 'auth.json'), '{"fake":true}'); process.stdout.write('Successfully logged in\r\n'); process.exit(0); }, 600);
  return;
}
let buf = '', trusting = argv.includes('--trust'), working = false;
const out = s => process.stdout.write(s);
process.stdin.setRawMode && process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
if (trusting) out('Do you trust the files in this folder? [y/N]: ');
else out('fake ready\r\nfake> ');
process.stdin.on('data', d => {
  if (trusting) {
    if (/y/i.test(d)) { trusting = false; out('y\r\nThanks.\r\nfake ready\r\nfake> '); }
    return;
  }
  if (d.includes('\x04')) process.exit(0);
  buf += d;
  let i;
  while ((i = buf.indexOf('\r')) >= 0) {
    // \r inside a bracketed paste is content, not submit
    const pasteOpen = buf.lastIndexOf('\x1b[200~', i) > buf.lastIndexOf('\x1b[201~', i);
    if (pasteOpen) { buf = buf.slice(0, i) + '\n' + buf.slice(i + 1); continue; }
    const line = buf.slice(0, i).replace(/\x1b\[20[01]~/g, '');
    buf = buf.slice(i + 1);
    if (!line.trim()) { out('\r\nfake> '); continue; }
    if (line.trim() === '/exit' && !argv.includes('--ignore-exit')) { out('\r\nbye\r\n'); process.exit(0); }
    if (log) fs.appendFileSync(log, JSON.stringify({ t: Date.now(), line }) + '\n');
    working = true;
    out('\r\n' + line.split('\n').length + ' line(s) received\r\n* Working (esc to interrupt)');
    setTimeout(() => {
      working = false;
      out('\r\x1b[2K' + 'ANSWER:' + line.split('\n')[0].slice(0, 60) + '\r\nWorked for 1s\r\nfake> ');
    }, workMs);
  }
});