# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-10-21

### Added
- Global dispatch briefing: the opening briefing is now the global dispatch briefing + the role's duty + extra notes. It is sent only to roles that start a NEW conversation (resume is detected from the final argv) and written to `.tmp/cli_conductor/BRIEFING.md`; per-role switch, preview and "Resend briefing".
- Permission options show the CLI's native value next to the unified label (e.g. `全自动（auto）`, `--yolo`); options a CLI does not support are hidden, and saved ones fall back to Default.
- Subtle aurora + meteor-shower effect on the highest reasoning-effort option (static with reduced motion).

### Changed
- Model and reasoning-effort lists only contain values documented for each CLI's flag (checked 2026-10-20); Codex effort is passed via `-c model_reasoning_effort`.
- Role joined / left notices were removed (they interrupted other roles).
- zh-CN strings for `minimal` / `ultra`; `[CLIConductor]` tag and `.tmp/cli_conductor` path fixed in UI text.

### Fixed
- POST requests from the UI send the `x-cli-conductor` header again (regression from 0.1.1).
- ConPTY sessions are stopped one at a time and their post-exit release is awaited (node-pty#922 crash).
- Clicking a Dock card no longer highlights the wrong role.

### CI
- Windows runner with Node 20 / 22 / 24; PTY-heavy test steps use the TAP reporter so native crash exit codes are visible.

## [0.1.1] - 2026-10-18

### Added
- Hot-add roles while the dispatcher is running; the left roster keeps the full configured list.
- Unified new-role form (Save / Save & start); Stop & remove for live roles.
- Dock: drag reorder, compact card layout, Restart / Stop in the overflow menu, even widths.

### Changed
- Sharing one CLI account between roles on hot-add shows a soft toast instead of blocking.
- Reply script posts to the running server first, with a bounded file-queue fallback and no prompts (`-MessagePath`, `-NoReply`, `-Port`, string `-ReplyRequired`; one-line result).

### Fixed
- Non-default Codex accounts pin `windows.sandbox = "unelevated"` (plus a `-c` override) so they cannot break the Codex Desktop elevated sandbox (see #1 and openai/codex#40627); the default `~/.codex` is never touched. UI tip and README troubleshooting added.
- Sidebar scroll position is kept when opening the new-role form.

## [0.1.0] - 2026-10-17

First public release.

### Added
- Local web UI (English / Simplified Chinese) that runs each AI CLI in its own ConPTY terminal with xterm.js.
- Detection of 19 AI CLIs on PATH, plus manual CLIs.
- Toggle-based launch options per CLI with a final-command preview.
- Message relay via an outbox of `CliConductorMessage/v1` JSON files, bracketed-paste delivery and submit verification with Enter retries.
- Immediate / after-turn delivery with busy-line plus idle turn-end detection; first-run prompt detection with hold.
- Multiple accounts for Codex, Claude Code and Gemini CLI, with a login terminal.
- Stage + Dock layout: 2 or 3 terminals, live Dock cards that follow the stage order, swap animations, unread badges, focus mode, Ctrl+1…9.
- Collapsible, resizable side panels; responsive sizing from 1366×768 to 4K.
- Single-CLI restart, stop and mute; opening briefings; presets; archive roles.
- `tools/cli_conductor_send.ps1` reply script for agents.

[Unreleased]: https://github.com/PCSprime/cli-conductor/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/PCSprime/cli-conductor/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/PCSprime/cli-conductor/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/PCSprime/cli-conductor/releases/tag/v0.1.0
