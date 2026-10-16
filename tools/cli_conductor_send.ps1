#Requires -Version 7
<#
.SYNOPSIS
  Queue one message for CLI Conductor. Writes an immutable JSON file into the outbox.
.EXAMPLE
  pwsh -File tools/cli_conductor_send.ps1 -From AGENT_A -To AGENT_B -Message "Review please" -RefPath C:\work\proj\notes.md
#>
param(
    [Parameter(Mandatory = $true)][string]$From,
    [Parameter(Mandatory = $true)][string]$To,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$Message,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string[]]$RefPath,
    [bool]$ReplyRequired = $true,
    [string]$ClientKey = '',
    [string]$ConfigPath,
    [string]$Workspace = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path (Join-Path $repoRoot 'lib') 'BridgeConfig.ps1')
if (-not $ConfigPath) { $ConfigPath = Join-Path $repoRoot 'bridge.config.json' }
$Cfg = Get-BridgeConfig -ConfigPath $ConfigPath -Workspace $Workspace

$From = $From.ToUpperInvariant(); $To = $To.ToUpperInvariant()
if ($From -notin $Cfg.RoleNames -or $To -notin $Cfg.RoleNames -or $From -eq $To) {
    throw "MESSAGE_ROUTE_INVALID: roles are $($Cfg.RoleNames -join ', ')"
}

$refs = @(
    foreach ($path in $RefPath) {
        $resolved = [IO.Path]::GetFullPath($path)
        if (-not $resolved.StartsWith($Cfg.Root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "REF_ESCAPE:$resolved (refs must be inside $($Cfg.Root))" }
        if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) { throw "REF_MISSING:$resolved" }
        [ordered]@{ path = $resolved; sha256 = (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
)

if (-not [string]::IsNullOrWhiteSpace($ClientKey) -and (Test-Path -LiteralPath $Cfg.Outbox)) {
    foreach ($existing in @(Get-ChildItem -LiteralPath $Cfg.Outbox -Filter '*.json' -File)) {
        try { $parsed = Get-Content -LiteralPath $existing.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } catch { continue }
        if ([string]$parsed.from -eq $From -and [string]$parsed.client_key -eq $ClientKey) {
            [ordered]@{
                status = 'DUPLICATE'; message_id = [string]$parsed.message_id; path = $existing.FullName
                sha256 = (Get-FileHash -LiteralPath $existing.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
                to = [string]$parsed.to; reply_required = [bool]$parsed.reply_required
            } | ConvertTo-Json
            exit 0
        }
    }
}

$messageId = '{0}-{1}-TO-{2}-{3}' -f ([DateTimeOffset]::Now.ToString('yyyyMMddTHHmmssfffK').Replace(':','')), $From, $To, ([guid]::NewGuid().ToString('N').Substring(0,8))
$record = [ordered]@{
    schema = 'CliConductorMessage/v1'
    message_id = $messageId
    from = $From
    to = $To
    message = $Message
    reply_required = $ReplyRequired
    refs = $refs
}
if (-not [string]::IsNullOrWhiteSpace($ClientKey)) { $record.client_key = $ClientKey }

New-Item -ItemType Directory -Force -Path $Cfg.Outbox | Out-Null
$finalPath = Join-Path $Cfg.Outbox ($messageId + '.json')
$tempPath = Join-Path $Cfg.Outbox ('.tmp-' + [guid]::NewGuid().ToString('N'))
try {
    [IO.File]::WriteAllText($tempPath, ($record | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
    [IO.File]::Move($tempPath, $finalPath)
    $queuedSha = (Get-FileHash -LiteralPath $finalPath -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-BridgeEventTo -Cfg $Cfg -Kind 'QUEUED' -MessageId $messageId -FromRole $From -ToRole $To -Detail @{ path = $finalPath; sha256 = $queuedSha }
} finally {
    if (Test-Path -LiteralPath $tempPath) { Remove-Item -LiteralPath $tempPath -Force }
}

[ordered]@{ status = 'QUEUED'; message_id = $messageId; path = $finalPath; sha256 = $queuedSha; to = $To; reply_required = $ReplyRequired } | ConvertTo-Json