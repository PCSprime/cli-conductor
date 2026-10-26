# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

UI polish pass (front-end only; no protocol or bridge changes). / 界面优化（仅前端，不改协议与调度逻辑）。

### Fixed

- Scroll flicker on Windows Chrome/Edge: removed `backdrop-filter` from scrolling panels, header, dock, popovers and sheets, and dropped `background-attachment: fixed`. / 修复 Windows Chrome/Edge 滚动闪烁：滚动区、顶栏、Dock、弹窗去掉毛玻璃，取消固定背景。
- Status dots are aligned in a fixed trailing slot; enabled-but-not-started roles show a hollow ring instead of green. / 状态灯对齐；已启用未启动的角色显示空心圈而非绿色。
- Lists (roles, feed, status) are only rebuilt when their data changes, keeping scroll position. / 列表仅在数据变化时重建，保持滚动位置。
- Untranslated account hint and `ROLE_UNKNOWN` toast now show in Chinese. / 账号说明与 ROLE_UNKNOWN 提示中文化。

### Added

- Status dots use shape + tooltip/ARIA label, not color alone (ring, spinning arc, exclamation). / 状态灯增加形状与文字提示，不再只靠颜色。
- In-app confirm sheet for shared-account start, structured duplicate-account banner, error/ok toasts (`aria-live`). / 同账号启动改为页内确认框，同账号提示条，toast 分级。
- `?` keyboard-shortcuts sheet, `:focus-visible` rings and keyboard-selectable role rows. / `?` 快捷键卡、键盘焦点环、角色行可键盘选择。
- Empty states with actions (no roles / no CLI detected / no activity) and a "Scanning…" state for Rescan. / 空状态提示与操作按钮，重新扫描显示“扫描中”。
- Terminals use the WebGL renderer (`@xterm/addon-webgl`), falling back to DOM automatically; opt out with `localStorage.tbWebgl = "0"`. / 终端启用 WebGL 渲染，失败自动回退。
- Role rows show a second line: CLI · account · delivery · turns. / 角色行第二行显示 CLI·账号·投递·回合。

### Changed

- Unified type scale and a 12-step neutral color scale (light/dark) with higher-contrast secondary text. / 统一字号层级与 12 级灰阶配色，次要文字对比度提高。
- Dock cards no longer repeat the CLI name under the role name; glow toned down. / Dock 卡片去掉重复 CLI 名，发光收敛。
- Sidebar auto-collapses to a rail below 1024px on first visit; `prefers-reduced-transparency` respected; CJK monospace fallbacks and line height 1.2 for terminals. / 窄屏自动折叠侧栏，适配减少透明度，终端中文等宽字体回退。

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
