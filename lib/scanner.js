'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function which(cmd) {
  if (path.isAbsolute(cmd)) return fs.existsSync(cmd) ? cmd : null;
  const win = process.platform === 'win32';
  const r = spawnSync(win ? 'where.exe' : 'which', [cmd], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 || !r.stdout) return null;
  const hits = r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!win) return hits[0] || null;
  // prefer real executables/shims; .ps1 shims are launched through pwsh (see resolveSpawn); skip extensionless npm stubs
  const exe = hits.find(h => /\.(exe|cmd|bat|com)$/i.test(h));
  if (exe) return exe;
  // .ps1 is not in PATHEXT, so look it up explicitly
  const p = /\.ps1$/i.test(cmd) ? null : spawnSync('where.exe', [cmd + '.ps1'], { encoding: 'utf8', windowsHide: true });
  const ps = p && p.status === 0 ? p.stdout.split(/\r?\n/).map(s => s.trim()).find(h => /\.ps1$/i.test(h)) : null;
  return ps || hits.find(h => /\.ps1$/i.test(h)) || null;
}

function scan(adapters) {
  return adapters.map(a => {
    let found = null;
    for (const c of a.commands || []) { found = which(c); if (found) break; }
    return { ...a, path: found };
  });
}

// .cmd/.bat need cmd.exe on Windows.
function resolveSpawn(file, args) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', file, ...args] };
  }
  if (process.platform === 'win32' && /\.ps1$/i.test(file)) {
    return { file: 'pwsh.exe', args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args] };
  }
  return { file, args };
}

// Split a raw argument string; double quotes group.
function splitArgs(raw) {
  const out = []; let cur = ''; let q = false; let has = false;
  for (const ch of String(raw || '')) {
    if (ch === '"') { q = !q; has = true; continue; }
    if (!q && /\s/.test(ch)) { if (has) { out.push(cur); cur = ''; has = false; } continue; }
    cur += ch; has = true;
  }
  if (has) out.push(cur);
  return out;
}

module.exports = { which, scan, resolveSpawn, splitArgs };