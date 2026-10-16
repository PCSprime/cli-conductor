'use strict';
// Native folder picker. Windows: PowerShell (STA) FolderBrowserDialog with a topmost
// owner so the dialog comes to the front. Returns { path } or { path: null, cancelled: true }.
const { spawn } = require('child_process');
const fs = require('fs');

function psScript(initial) {
  const init = String(initial || '').replace(/'/g, "''");
  return [
    "$ErrorActionPreference='Stop'",
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    '[System.Windows.Forms.Application]::EnableVisualStyles()',
    '$owner=New-Object System.Windows.Forms.Form -Property @{TopMost=$true;ShowInTaskbar=$false;StartPosition="CenterScreen";Width=1;Height=1;Opacity=0}',
    '$owner.Show();$owner.Activate()',
    '$d=New-Object System.Windows.Forms.FolderBrowserDialog',
    '$d.ShowNewFolderButton=$true',
    "try{$d.UseDescriptionForTitle=$true}catch{}",
    "$d.Description='CLI Conductor'",
    `$i='${init}'`,
    'if($i -and (Test-Path -LiteralPath $i)){$d.SelectedPath=$i}',
    '$r=$d.ShowDialog($owner)',
    '$owner.Close()',
    "if($r -eq [System.Windows.Forms.DialogResult]::OK){Write-Output ('PICKED:'+$d.SelectedPath)}else{Write-Output 'CANCELLED'}",
  ].join(';');
}

function parseOutput(out) {
  const line = String(out || '').split(/\r?\n/).map(s => s.trim()).find(s => s.startsWith('PICKED:') || s === 'CANCELLED');
  if (!line || line === 'CANCELLED') return { path: null, cancelled: true };
  return { path: line.slice(7) };
}

function pickFolder({ initial = '', timeoutMs = 10 * 60 * 1000 } = {}) {
  if (process.platform !== 'win32') return Promise.reject(new Error('PICKER_UNSUPPORTED'));
  const exe = ['pwsh.exe', 'powershell.exe'];
  return new Promise((resolve, reject) => {
    const run = i => {
      const p = spawn(exe[i], ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', psScript(initial)], { windowsHide: true });
      let out = '', err = '';
      const t = setTimeout(() => { try { p.kill(); } catch { } }, timeoutMs);
      p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
      p.on('error', e => { clearTimeout(t); if (i + 1 < exe.length) run(i + 1); else reject(new Error('PICKER_FAILED:' + e.message)); });
      p.on('close', code => { clearTimeout(t); if (code !== 0 && !/PICKED:|CANCELLED/.test(out)) return reject(new Error('PICKER_FAILED:' + (err.trim().split('\n')[0] || code))); resolve(parseOutput(out)); });
    };
    run(0);
  });
}
module.exports = { pickFolder, parseOutput, psScript };
