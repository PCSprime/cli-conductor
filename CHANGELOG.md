# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

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
