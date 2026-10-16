# Shared configuration loader for CLI Conductor. Dot-source this file.
# Produces one hashtable ($cfg) with resolved absolute paths, roles and timings.
Set-StrictMode -Off

$script:BridgeDefaults = @{
    state_dir = '.tmp/cli_conductor'
    poll_seconds = 2
    ping_timeout_seconds = 120
    heartbeat_alive_seconds = 90
    status_max_bytes = 65536
    delivery = @{
        backend = 'windows-sendinput'
        max_paste_chars = 4096
        newline_marker = ' <NL> '
        paste_settle_ms = 5000
        pre_enter_ms = 500
        enter_retry = $true
        enter_retry_delay_ms = 1500
        focus_attempts = 3
        focus_wait_retry_seconds = 30
        clipboard_retries = 10
        tmux_command = @('tmux')
        tmux_enter_delay_ms = 300
    }
    templates = @{
        header = '[CLIConductor {message_id} {from}->{to}]'
        refs_label = 'Referenced files:'
        reply = 'When done, reply with: pwsh -File "{send_script}" -From {to} -To {from} -Message "<text>" -RefPath <absolute path of your result file>. Use -ReplyRequired $false for a pure completion notice. Never hand-write or edit outbox JSON.'
        no_reply = 'No reply is required for this message. Do not create a return message.'
        long_message = 'This message exceeds the single-paste limit. Full content is in: {path} (SHA256={sha256}). Read that UTF-8 JSON file, verify the SHA256, message_id, from and to, then follow its message and refs. reply_required in the file is authoritative.'
        ping = 'Bridge connectivity test. Do not touch project files. Create the file {ack_path} containing exactly {ack_text}, then reply that you are done.'
    }
}

$script:BridgeDeliveryPolicies = @('immediate','after_turn','archive_only')
$script:BridgeSendPolicies = @('immediate','after_turn')
$script:BridgeMatchModes = @('token','exact','contains','regex')

function Merge-BridgeMap([hashtable]$base, $over) {
    $result = @{}
    foreach ($k in $base.Keys) { $result[$k] = $base[$k] }
    if ($null -eq $over) { return $result }
    foreach ($k in $over.Keys) {
        if ($result[$k] -is [hashtable] -and $over[$k] -is [System.Collections.IDictionary]) {
            $result[$k] = Merge-BridgeMap $result[$k] $over[$k]
        } else { $result[$k] = $over[$k] }
    }
    return $result
}

function Resolve-BridgePath([string]$base, [string]$path) {
    if ([IO.Path]::IsPathRooted($path)) { return [IO.Path]::GetFullPath($path) }
    return [IO.Path]::GetFullPath((Join-Path $base $path))
}

function Get-BridgeConfig {
    param([string]$ConfigPath, [string]$Workspace = '')
    if ([string]::IsNullOrWhiteSpace($ConfigPath)) { throw 'CONFIG_PATH_REQUIRED' }
    $ConfigPath = [IO.Path]::GetFullPath($ConfigPath)
    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw "CONFIG_MISSING:$ConfigPath" }
    $raw = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($raw.schema -ne 'CliConductorConfig/v1') { throw 'CONFIG_SCHEMA_INVALID: expected "schema": "CliConductorConfig/v1"' }
    $cfg = Merge-BridgeMap $script:BridgeDefaults $raw
    $configDir = Split-Path -Parent $ConfigPath
    if (-not [string]::IsNullOrWhiteSpace($Workspace)) { $cfg.workspace = $Workspace }
    if ([string]::IsNullOrWhiteSpace([string]$cfg.workspace)) { $cfg.workspace = '.' }
    $root = Resolve-BridgePath $configDir ([string]$cfg.workspace)
    if ($root.Length -gt 1 -and $root -ne [IO.Path]::GetPathRoot($root)) { $root = $root.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) }
    $stateDir = Resolve-BridgePath $root ([string]$cfg.state_dir)
    $cfg.ConfigPath = $ConfigPath
    $cfg.Root = $root
    $cfg.StateDir = $stateDir
    if (-not $raw.delivery -or -not $raw.delivery.backend) { $cfg.delivery.backend = Get-BridgeDefaultBackend }
    $cfg.Outbox = Join-Path $stateDir 'outbox'
    $cfg.InboxRoot = Join-Path $stateDir 'inbox'
    $cfg.EventsPath = Join-Path $stateDir 'events.jsonl'
    $cfg.HeartbeatPath = Join-Path $stateDir 'heartbeat.json'
    $cfg.StatePath = Join-Path $stateDir 'state.json'
    $cfg.PausePath = Join-Path $stateDir 'PAUSE'
    $cfg.PingRoot = Join-Path $stateDir 'ping'

    if ($null -eq $cfg.roles -or $cfg.roles.Count -lt 2) { throw 'CONFIG_ROLES_INVALID: at least two roles are required' }
    $roles = [ordered]@{}
    $titles = @{}
    foreach ($name in @($cfg.roles.Keys | Sort-Object)) {
        if ($name -cnotmatch '^[A-Z][A-Z0-9_]{0,31}$') { throw "CONFIG_ROLE_NAME_INVALID:$name (use UPPER_SNAKE_CASE)" }
        $r = $cfg.roles[$name]
        if ($null -eq $r) { $r = @{} }
        $delivery = if ($r.delivery) { [string]$r.delivery } else { 'immediate' }
        $send = if ($r.send_policy) { [string]$r.send_policy } else { 'immediate' }
        if ($delivery -notin $script:BridgeDeliveryPolicies) { throw "CONFIG_ROLE_DELIVERY_INVALID:$name=$delivery" }
        if ($send -notin $script:BridgeSendPolicies) { throw "CONFIG_ROLE_SEND_POLICY_INVALID:$name=$send" }
        $window = $null
        if ($delivery -ne 'archive_only') {
            if ($null -eq $r.window -or ([string]::IsNullOrWhiteSpace([string]$r.window.title) -and [string]::IsNullOrWhiteSpace([string]$r.window.tmux_target))) { throw "CONFIG_ROLE_WINDOW_REQUIRED:$name (window.title or window.tmux_target)" }
            $match = if ($r.window.match) { [string]$r.window.match } else { 'token' }
            if ($match -notin $script:BridgeMatchModes) { throw "CONFIG_ROLE_MATCH_INVALID:$name=$match" }
            $title = [string]$r.window.title
            $tmux = [string]$r.window.tmux_target
            if ($cfg.delivery.backend -eq 'tmux' -and [string]::IsNullOrWhiteSpace($tmux)) { throw "CONFIG_ROLE_TMUX_TARGET_REQUIRED:$name" }
            $key = if ($cfg.delivery.backend -eq 'tmux') { 'tmux:' + $tmux } else { $title }
            if ($key -and $titles.ContainsKey($key)) { throw "CONFIG_WINDOW_TITLE_DUPLICATE:$key ($($titles[$key]), $name)" }
            if ($key) { $titles[$key] = $name }
            $window = @{ title = $title; match = $match; tmux_target = $tmux }
        }
        $roles[$name] = @{ name = $name; delivery = $delivery; send_policy = $send; window = $window; description = [string]$r.description }
    }
    $cfg.Roles = $roles
    $cfg.RoleNames = @($roles.Keys)
    return $cfg
}

function Format-BridgeTemplate([string]$template, [hashtable]$values) {
    $text = $template
    foreach ($k in $values.Keys) { $text = $text.Replace('{' + $k + '}', [string]$values[$k]) }
    return $text
}

function Write-BridgeEventTo {
    param([hashtable]$Cfg, [Parameter(Mandatory = $true)][string]$Kind, [string]$MessageId = '', [string]$FromRole = '', [string]$ToRole = '', $Detail = $null)
    try {
        New-Item -ItemType Directory -Force -Path $Cfg.StateDir | Out-Null
        if ($null -eq $Detail) { $Detail = @{} }
        $record = [ordered]@{ ts = [DateTimeOffset]::Now.ToString('o'); kind = $Kind; message_id = $MessageId; from = $FromRole; to = $ToRole; detail = $Detail }
        $line = ($record | ConvertTo-Json -Compress -Depth 8) + "`n"
        [IO.File]::AppendAllText($Cfg.EventsPath, $line, [Text.UTF8Encoding]::new($false))
    } catch { Write-Warning "EVENT_LOG_FAILED:$($_.Exception.Message)" }
}
function Get-BridgeDefaultBackend { if ($IsWindows) { return 'windows-sendinput' } return 'tmux' }

function Format-BridgeWindowSpec($window) {
    if ($null -eq $window) { return '(no window)' }
    $parts = @()
    if ($window.title) { $parts += "match=$($window.match) title='$($window.title)'" }
    if ($window.tmux_target) { $parts += "tmux_target='$($window.tmux_target)'" }
    return $parts -join ' '
}