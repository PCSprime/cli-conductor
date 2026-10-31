# Holds an exclusive byte-range lock on <CODEX_HOME>\auth.lock while CLI Conductor switches the
# primary Codex login. Codex itself locks this file (Rust File::lock -> LockFileEx, whole range)
# around every token refresh read/modify/write, so holding byte 0 here makes Codex wait for us and
# makes us wait for an in-flight refresh. Protocol: prints LOCKED (or TIMEOUT, exit 3) on stdout,
# then holds the lock until stdin closes.
param([Parameter(Mandatory = $true)][string]$Path, [int]$TimeoutMs = 5000)
$ErrorActionPreference = 'Stop'
$deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
$fs = $null
while ($true) {
  try {
    if (-not $fs) { $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete) }
    $fs.Lock(0, 1)
    break
  } catch {
    if ([DateTime]::UtcNow -ge $deadline) { [Console]::Out.WriteLine('TIMEOUT'); [Console]::Out.Flush(); if ($fs) { $fs.Dispose() }; exit 3 }
    Start-Sleep -Milliseconds 100
  }
}
[Console]::Out.WriteLine('LOCKED'); [Console]::Out.Flush()
try { [void][Console]::In.ReadToEnd() } finally { try { $fs.Unlock(0, 1) } catch { }; $fs.Dispose() }
