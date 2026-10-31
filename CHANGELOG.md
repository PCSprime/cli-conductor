# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0] - 2026-10-31

Terminal display overhaul, a primary-account switch for Codex, and resume fixes. / 终端显示层重构、Codex 主账号切换与续接修复。

### Added

- Primary account switch (Codex): the Accounts panel lists the logins saved by [codex-auth](https://www.npmjs.com/package/@loongphy/codex-auth) (alias, masked email, plan, active, last refresh) and switches the login of the default `~/.codex` home. The confirm sheet lists affected running roles (busy/idle) and only suggests restarting them; nothing is restarted automatically. / 新增「切换主账号」（Codex）：账号面板列出 codex-auth 保存的账号（别名、打码邮箱、套餐、当前、上次刷新），切换默认 `~/.codex` 目录的登录；确认框列出受影响的运行中角色，只提示重启，不自动重启。
- Switch safety: blocked while the Codex desktop app is running; holds `<home>/auth.lock` during the switch, checks the current login was saved back to its snapshot first, verifies the identity afterwards and rolls back `auth.json` and the registry on failure. Tokens are never shown. / 切换保护：Codex 桌面版运行时不允许切换；切换期间持有 `auth.lock`，先确认当前登录已回存快照，切换后校验身份，失败自动还原 `auth.json` 与 registry；从不显示 token。
- When a role's account changes while it resumes a fixed session ID, you choose: switch to "last", clear the ID, or keep it. / 角色改账号且按 ID 续接时，可选：改为最近一次 / 清空 ID / 保留。
- The account dropdown's "Default" now reads "Primary (current: …)" for Codex. / 账号下拉框「默认」改为「主账号（当前：…）」。
- Snapshot replay: the server sends a rendered snapshot of each terminal (screen + scrollback, via `@xterm/addon-serialize`) with its cols/rows; the browser resizes first, then writes, and output produced while the snapshot is prepared is queued. / 快照回放：服务端用 `@xterm/addon-serialize` 发送渲染好的画面与历史并附 cols/rows，浏览器先调到同尺寸再写，准备期间的输出排队补发。

### Changed

- Cross-account resume: under the primary account a session created by another login is resumed with the current login (`codex resume <id>`); the card only shows a small grey note ("created by …, resumed as …"). A start is blocked only when the session is not in the home the role uses; if Codex itself refuses, its own error is shown. Nothing starts a new conversation or clears an ID automatically. / 跨账号续接：主账号下由其他登录创建的会话直接用当前登录续接，卡片只显示灰色提示；仅当会话不在该角色所用账号目录时才阻止启动；Codex 自己拒绝时显示它的报错；不会自动新开对话或清空 ID。
- Display-layer refactor: fewer compositing layers (`contain`, handles in grid gaps at whole pixels, repaint-only spinners), output written once per animation frame (complete frames waited up to 60 ms), WebGL only for terminals on the stage, Dock last line throttled to ~1/s, no fit/resize while dragging panel handles, decorative animations paused in the background. / 显示层重构：减少合成层、按帧写入输出（整帧最多等 60ms）、WebGL 只给主区终端、Dock 末行约 1 秒刷新一次、拖动把手时不 fit、后台暂停装饰动画。

### Fixed

- Flicker and mixed-up role content after reopening the dashboard; side lists and bars rebuild only when their content changes; terminals open the first time they are placed on the stage; WebGL is re-enabled after a context loss (up to 3 times per terminal). / 修复重开网页后的闪烁与角色内容错乱；侧栏只在内容变化时重建；终端首次上主区时才初始化；WebGL 上下文丢失后自动重新启用。
- Scrollbar hidden when the buffer cannot scroll (alternate screen / less than one screen), instead of a fake full-height thumb. / 备用屏或不满一屏时隐藏滚动条，不再显示假滑块。
- Codex history scrolling after a page refresh: snapshots restore the mouse SGR encoding (`?1006h`). / 刷新网页后 Codex 能继续用滚轮翻历史：快照补上鼠标 SGR 编码。
- Stage order is restored when collapsing to 2 slots and expanding back to 3; less flicker around terminals in 3-slot layout. / 修复 3↔2 栏切换后主区顺序被打乱，减少 3 栏时终端四周闪烁。
- Session lookup also finds compressed (`.jsonl.zst`) and forked (`<id>_<id>.jsonl`) rollouts and sessions listed only in `session_index.jsonl` (previously reported as "not found"); Codex's "No saved session found" is shown on the role card. / 会话查找支持 `.jsonl.zst`、分叉文件名与 `session_index.jsonl`（之前会误报找不到）；Codex 输出 No saved session found 时在卡片上标红。

### UI polish / 界面优化

#### Fixed

- Scroll flicker on Windows Chrome/Edge: removed `backdrop-filter` from scrolling panels, header, dock, popovers and sheets, and dropped `background-attachment: fixed`. / 修复 Windows Chrome/Edge 滚动闪烁：滚动区、顶栏、Dock、弹窗去掉毛玻璃，取消固定背景。
- Status dots are aligned in a fixed trailing slot; enabled-but-not-started roles show a hollow ring instead of green. / 状态灯对齐；已启用未启动的角色显示空心圈而非绿色。
- Lists (roles, feed, status) are only rebuilt when their data changes, keeping scroll position. / 列表仅在数据变化时重建，保持滚动位置。
- Untranslated account hint and `ROLE_UNKNOWN` toast now show in Chinese. / 账号说明与 ROLE_UNKNOWN 提示中文化。

#### Added

- Status dots use shape + tooltip/ARIA label, not color alone (ring, spinning arc, exclamation). / 状态灯增加形状与文字提示，不再只靠颜色。
- In-app confirm sheet for shared-account start, structured duplicate-account banner, error/ok toasts (`aria-live`). / 同账号启动改为页内确认框，同账号提示条，toast 分级。
- `?` keyboard-shortcuts sheet, `:focus-visible` rings and keyboard-selectable role rows. / `?` 快捷键卡、键盘焦点环、角色行可键盘选择。
- Empty states with actions (no roles / no CLI detected / no activity) and a "Scanning…" state for Rescan. / 空状态提示与操作按钮，重新扫描显示“扫描中”。
- Terminals use the WebGL renderer (`@xterm/addon-webgl`), falling back to DOM automatically; opt out with `localStorage.tbWebgl = "0"`. / 终端启用 WebGL 渲染，失败自动回退。
- Role rows show a second line: CLI · account · delivery · turns. / 角色行第二行显示 CLI·账号·投递·回合。

#### Changed

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

[Unreleased]: https://github.com/PCSprime/cli-conductor/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/PCSprime/cli-conductor/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/PCSprime/cli-conductor/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/PCSprime/cli-conductor/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/PCSprime/cli-conductor/releases/tag/v0.1.0
