#Requires -Version 7
<#
.SYNOPSIS
  Send one message to another role through CLI Conductor.
.DESCRIPTION
  Primary path: POST to the running web app (URL from app.config.json "server.url", or env
  CC_URL / CC_PORT). Fallback when no server answers: write an immutable JSON file into the
  outbox (picked up by whichever bridge runs next). Never prompts and never waits for delivery;
  prints one line: "QUEUED <message_id> ..." or "ERROR <code>: <detail>" (exit code 1).
.EXAMPLE
  pwsh -File tools/cli_conductor_send.ps1 -ConfigPath <ws>/.tmp/cli_conductor/app.config.json -From CODER -To REVIEWER -Message "Review please" -RefPath C:\work\proj\notes.md
.EXAMPLE
  pwsh -File tools/cli_conductor_send.ps1 -ConfigPath <cfg> -From REVIEWER -To CODER -MessagePath C:\work\proj\review.md -NoReply
#>
[CmdletBinding()]
param(
    [string]$From = '',
    [string]$To = '',
    [string]$Message = '',
    # UTF-8 text file whose content is the message (avoids shell quoting problems).
    [string]$MessagePath = '',
    [string[]]$RefPath = @(),
    # Accepts true/false/1/0/yes/no/$true/$false (pwsh -File passes everything as text).
    [string]$ReplyRequired = 'true',
    # Same as -ReplyRequired false: a pure notice, the receiver should not answer.
    [switch]$NoReply,
    [string]$ClientKey = '',
    [string]$ConfigPath = '',
    [string]$Workspace = '',
    # Server port (127.0.0.1). With -Port (or CC_PORT / CC_URL) no config file is needed.
    [int]$Port = 0,
    [int]$TimeoutSec = 10,
    # Print the full JSON result instead of one line.
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Done([string]$line, [int]$code, $obj = $null) {
    if ($Json -and $obj) { $obj | ConvertTo-Json -Depth 6 -Compress } else { $line }
    exit $code
}
function Fail([string]$code, [string]$detail) { Done "ERROR ${code}: $detail" 1 ([ordered]@{ status = 'ERROR'; error = $code; detail = $detail }) }

try {
    # ---- arguments (validated here so pwsh never prompts) ----
    if (-not $From -or -not $To) { Fail 'ARGS' 'need -From <ROLE> -To <ROLE>' }
    $From = $From.ToUpperInvariant(); $To = $To.ToUpperInvariant()
    switch -Regex ($ReplyRequired.Trim()) {
        '^(\$?true|1|yes|y|on)$' { $reply = $true; break }
        '^(\$?false|0|no|n|off)$' { $reply = $false; break }
        default { Fail 'ARGS' "-ReplyRequired must be true/false/1/0 (got '$ReplyRequired')" }
    }
    if ($NoReply) { $reply = $false }
    if ($MessagePath) {
        $mp = [IO.Path]::GetFullPath($MessagePath)
        if (-not (Test-Path -LiteralPath $mp -PathType Leaf)) { Fail 'MESSAGE_PATH_MISSING' $mp }
        $Message = [IO.File]::ReadAllText($mp, [Text.UTF8Encoding]::new($false))
    }
    if ([string]::IsNullOrWhiteSpace($Message)) { Fail 'ARGS' 'need -Message "<text>" or -MessagePath <utf8 file>' }
    $refs = @($RefPath | Where-Object { $_ } | ForEach-Object { [IO.Path]::GetFullPath($_) })

    # ---- config ----
    $repoRoot = Split-Path -Parent $PSScriptRoot
    $raw = @{}
    if ($ConfigPath) {
        $ConfigPath = [IO.Path]::GetFullPath($ConfigPath)
        if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { Fail 'CONFIG_MISSING' $ConfigPath }
        $raw = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    }

    # ---- primary: the running web app ----
    $url = if ($Port -gt 0) { "http://127.0.0.1:$Port" } else { $env:CC_URL }
    if (-not $url -and $env:CC_PORT) { $url = "http://127.0.0.1:$($env:CC_PORT)" }
    if (-not $url -and $raw.server -and $raw.server.url) { $url = [string]$raw.server.url }
    $header = if ($raw.server -and $raw.server.header) { [string]$raw.server.header } else { 'x-cli-conductor' }
    $serverNote = ''
    if ($url) {
        $body = [ordered]@{ from = $From; to = $To; message = $Message; refs = $refs; reply_required = $reply; client_key = $ClientKey } | ConvertTo-Json -Depth 5 -Compress
        try {
            $r = Invoke-RestMethod -Method Post -Uri ($url.TrimEnd('/') + '/api/send') -Headers @{ $header = '1' } -ContentType 'application/json; charset=utf-8' `
                -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec ([Math]::Max(1, $TimeoutSec)) -NoProxy
            Done "$($r.status) $($r.message_id) $From->$To reply_required=$($reply.ToString().ToLower())" 0 $r
        } catch {
            $resp = $_.Exception.Response
            $err = $null
            if ($_.ErrorDetails -and $_.ErrorDetails.Message) { try { $err = ($_.ErrorDetails.Message | ConvertFrom-Json).error } catch { $err = $_.ErrorDetails.Message } }
            if ($resp -and $err -and $err -ne 'NOT_RUNNING') { Fail (($err -split ':')[0]) $err }   # server answered with a real error
            $serverNote = if ($err) { "server at $url says $err" } else { "no server at $url ($($_.Exception.Message))" }
        }
    } else { $serverNote = 'no server URL in config (set CC_PORT or CC_URL)' }

    # ---- fallback: file queue (bounded: only local file I/O, no waiting for any bridge) ----
    if (-not $ConfigPath) { Fail 'NO_SERVER' "$serverNote; pass -ConfigPath <app.config.json> to queue into the outbox instead" }
    . (Join-Path (Join-Path $repoRoot 'lib') 'BridgeConfig.ps1')
    $Cfg = Get-BridgeConfig -ConfigPath $ConfigPath -Workspace $Workspace
    if ($From -notin $Cfg.RoleNames -or $To -notin $Cfg.RoleNames -or $From -eq $To) { Fail 'MESSAGE_ROUTE_INVALID' "roles are $($Cfg.RoleNames -join ', ')" }
    $refObjs = @(foreach ($p in $refs) {
        if (-not $p.StartsWith($Cfg.Root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { Fail 'REF_ESCAPE' "$p (refs must be inside $($Cfg.Root))" }
        if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { Fail 'REF_MISSING' $p }
        [ordered]@{ path = $p; sha256 = (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() }
    })
    New-Item -ItemType Directory -Force -Path $Cfg.Outbox | Out-Null
    if ($ClientKey) {
        foreach ($f in @(Get-ChildItem -LiteralPath $Cfg.Outbox -Filter '*.json' -File)) {
            try { $m = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } catch { continue }
            if ([string]$m.from -eq $From -and [string]$m.client_key -eq $ClientKey) { Done "DUPLICATE $($m.message_id) (file queue)" 0 ([ordered]@{ status = 'DUPLICATE'; message_id = $m.message_id; path = $f.FullName }) }
        }
    }
    $id = '{0}-{1}-TO-{2}-{3}' -f ([DateTimeOffset]::Now.ToString('yyyyMMddTHHmmssfffK').Replace(':', '')), $From, $To, ([guid]::NewGuid().ToString('N').Substring(0, 8))
    $rec = [ordered]@{ schema = 'CliConductorMessage/v1'; message_id = $id; from = $From; to = $To; message = $Message; reply_required = $reply; refs = $refObjs }
    if ($ClientKey) { $rec.client_key = $ClientKey }
    $final = Join-Path $Cfg.Outbox ($id + '.json'); $tmp = Join-Path $Cfg.Outbox ('.tmp-' + [guid]::NewGuid().ToString('N'))
    try {
        [IO.File]::WriteAllText($tmp, ($rec | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
        [IO.File]::Move($tmp, $final)
        Write-BridgeEventTo -Cfg $Cfg -Kind 'QUEUED' -MessageId $id -FromRole $From -ToRole $To -Detail @{ path = $final; via = 'file' }
    } finally { if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force } }
    Done "QUEUED $id $From->$To (file queue; $serverNote; delivered when a bridge runs)" 0 ([ordered]@{ status = 'QUEUED'; message_id = $id; path = $final; via = 'file'; note = $serverNote })
} catch {
    Fail 'SEND_FAILED' $_.Exception.Message
}
