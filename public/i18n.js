'use strict';
// Minimal i18n: English strings are the keys; ZH holds Simplified Chinese.
const ZH = {
  'CLI Conductor': 'CLI 调度台', 'Not running': '未运行', 'Stop': '停止', 'New Message': '新消息',
  'Workspace': '工作区', 'Folder': '文件夹',
  'Message refs must be inside this folder. State is kept in .tmp/cli_conductor.': '消息引用的文件必须位于此文件夹内。状态保存在 .tmp/cli_conductor。',
  'Roles': '角色', 'Add Role': '添加角色', 'Options': '选项',
  'Wait for turn end before delivering': '投递前等待回合结束', 'Idle time for turn end': '回合结束空闲时间',
  'The strict first-run prompt check is always on. A role showing a trust or login prompt is held until you answer it in its card.': '严格的首次运行提示检测始终开启。出现信任或登录提示的角色会被暂停投递，直到你在其终端卡片中作答。',
  'Detected CLIs': '已检测到的 CLI', 'Rescan': '重新扫描', 'Add CLI Manually': '手动添加 CLI', 'Name': '名称',
  'Command or full path': '命令或完整路径', 'Default arguments': '默认参数', 'Busy pattern (regex)': '忙碌匹配（正则）',
  'Exit command': '退出命令', 'Add CLI': '添加 CLI', 'Presets': '预设', 'Choose a preset...': '选择预设…',
  'Load': '加载', 'Delete': '删除', 'Preset name': '预设名称', 'Save Current': '保存当前', 'Start Conductor': '启动调度', 'Stop Conductor': '停止调度',
  'Delivery': '投递', 'Pause delivery': '暂停投递', 'Wait for turn end': '等待回合结束', 'Status': '状态', 'Activity': '活动',
  'Cancel': '取消', 'From': '发送方', 'To': '接收方', 'Reply required': '需要回复', 'Message': '消息', 'Refs': '引用',
  'paths inside workspace, comma separated': '工作区内的路径，用逗号分隔', 'Send': '发送', 'My CLI': '我的 CLI', 'optional': '可选',
  'Type': '类型', 'Agent': '代理', 'Observer': '观察者', 'CLI': 'CLI',
  'Archived to inbox; its messages wait for the target turn end': '归档到收件箱；其消息会等待目标回合结束',
  '(not found)': '（未找到）', 'Immediate': '立即', 'After turn': '回合后', 'Working folder': '工作文件夹', 'workspace': '工作区',
  'Raw arguments': '原始参数', 'none': '无', 'Remove Role': '移除角色', 'Remove': '移除', 'not found': '未找到',
  'No activity yet': '暂无活动', 'Paused': '已暂停', 'Bridge running': '桥接运行中', 'roles': '个角色', 'held': '条暂缓',
  'working': '工作中', 'observer · inbox only': '观察者 · 仅收件箱', 'after turn': '回合后', 'immediate': '立即',
  'all roles': '所有角色', 'per role': '按角色',
  'idle': '空闲', 'starting': '启动中', 'offline': '离线', 'needs attention': '需要处理', 'inbox only': '仅收件箱',
  'queued': '已排队', 'delivered': '已投递', 'failed': '失败', 'rejected': '已拒绝', 'replied': '已回复',
  'Agents reply with': '代理回复命令：', 'Waiting for you:': '等待你处理：',
  '— answer it in this terminal. Deliveries are held.': '—— 请在此终端中作答。投递已暂停。',
  'Rescanned PATH': '已重新扫描 PATH', 'CLI added': '已添加 CLI', 'Enter a preset name': '请输入预设名称', 'Saved': '已保存',
  'Preset loaded': '预设已加载', 'Preset deleted': '预设已删除', 'Stop the bridge and exit all CLIs?': '停止桥接并退出所有 CLI？',
  'Message queued': '消息已排队', 'turn': '回合',
  'Language': '语言', 'submit unconfirmed': '提交未确认', 'submit retry': '重发回车', 'unconfirmed': '提交未确认',
  'The message was pasted but the CLI did not start (Enter seems ignored). Click this terminal and press Enter to submit it. Deliveries are held.': '消息已粘贴，但 CLI 没有开始处理（回车似乎被忽略）。请点击此终端并按回车提交。投递已暂停。', 'Cannot reach the server. Is npm start running?': '无法连接服务，请确认 npm start 正在运行。', 'The server is an older version. Restart npm start.': '服务版本较旧，请重启 npm start。',
  'Launch options': '启动选项', 'Model': '模型', 'Which model this CLI uses. Leave on default to use its own setting.': '这个 CLI 使用哪个模型。保持“默认”则沿用它自己的设置。',
  'Default': '默认', 'Custom…': '自定义…', 'model name': '模型名称', 'Thinking effort': '思考强度', 'How hard the model thinks before answering. Higher is slower but more careful.': '模型回答前思考的深度。越高越慢，但更仔细。',
  'low': '低', 'medium': '中', 'high': '高', 'xhigh': '很高', 'max': '最高', 'none': '无', 'off': '关', 'on': '开',
  'Continue conversation': '继续对话', 'Pick up an earlier session instead of starting fresh. An empty ID sends nothing, so no picker opens.': '接着之前的会话，而不是重新开始。ID 留空则不发送，不会弹出选择器。',
  'Most recent': '最近一次', 'By ID': '填 ID', 'session ID': '会话 ID', 'session index (e.g. 3)': '会话序号（如 3）',
  'Permission level': '权限级别', 'What the CLI may do without asking you.': 'CLI 不经询问可以做哪些事。', 'Read-only': '只读', 'Auto-edit files': '自动改文件', 'Full auto': '全自动',
  'Skip all confirmations': '跳过所有确认', 'Dangerous: never asks before running commands or editing files.': '危险：运行命令或修改文件前不再询问。',
  'Skip ALL confirmations? The CLI will run commands and edit files without asking. Use only in an isolated environment.': '确定跳过所有确认？CLI 将不经询问直接运行命令和修改文件。仅建议在隔离环境中使用。',
  'Extra folders': '额外目录', 'Let the CLI read and write folders outside its working folder.': '允许 CLI 读写工作文件夹以外的目录。', '＋ Add folder': '＋ 添加目录',
  'This CLI has no switchable options here; use Advanced.': '此 CLI 暂无可切换的选项，请在“高级”中填写参数。', 'extra arguments, appended last': '额外参数，追加在最后',
  'Advanced': '高级', 'Appended after the options above.': '追加在上面各选项之后。', 'Final command': '最终命令', 'Running': '运行中', 'roles enabled': '个角色已启用', 'Set a workspace folder first.': '请先设置工作区文件夹。', 'Enable at least two roles.': '请至少启用两个角色。', 'Wait for the CLI to finish before delivering': '等对方说完再投递', 'Quiet time that counts as finished': '判定说完的静止时长',
  'The bridge waits until the target CLI finishes its current turn, instead of interrupting it right away.': '桥接会等目标 CLI 完成当前这一轮回复后再投递，而不是立刻打断它。',
  'How long the screen must stay unchanged before a turn counts as finished. Shorter is faster, longer is safer.': '屏幕保持不变多少秒才算这一轮结束。越短越快，越长越稳妥。', 'Browse…': '浏览…', 'Recent:': '最近：', 'Role settings': '角色设置', 'Done': '完成', 'CLI & launch': 'CLI 与启动',
  'Settings are read-only while the bridge runs.': '桥接运行期间设置为只读。', 'Manual': '手动', 'Hide': '隐藏', 'Show': '显示', 'Hidden': '已隐藏',
  'Other supported CLIs': '其他支持的 CLI', 'No CLI detected on PATH': 'PATH 中未检测到 CLI', '＋ Add Role': '＋ 添加角色', '＋ Add CLI Manually': '＋ 手动添加 CLI',
  'Role status': '角色运行状态', 'wait for turn end: all roles': '等待回合结束：所有角色', 'wait for turn end: per role': '等待回合结束：按角色', 'Role': '角色', 'Enabled': '启用', 'On': '开', 'Off': '关', 'Panel': '面板',
  'e.g. --model, resume <id>': '如 --model、resume <id>', 'Model, conversation id and other CLI flags go in Raw arguments.': '模型、会话 ID 等 CLI 参数请填写在原始参数中。',
  'Press Start Conductor to launch this CLI here.': '点击“启动调度”后，此 CLI 会在这里运行。', 'Enable at least two roles in the sidebar.': '请在左侧至少启用两个角色。',
  'outbox': '待投递', 'uncertain': '不确定', 'archived': '已归档', 'held': '暂缓', 'paused': '已暂停', 'resumed': '已恢复', 'Opening briefing': '开场说明', 'Insert default template': '插入默认模板', 'briefed': '已发送开场说明', 'briefing failed': '开场说明发送失败',
  'Optional. Empty = nothing is sent. Placeholders: {role} {peers} {workspace} {send}': '可选。留空则不发送。占位符：{role} {peers} {workspace} {send}',
  'Replace the current briefing with the default template?': '用默认模板替换当前开场说明？', 'waiting_for_briefing': '等待开场说明', 'archived': '已归档', 'attention': '需处理', 'fresh start': '全新启动', 'role exited': '角色退出', 'role started': '角色启动', 'stopped': '已停止', 'turn end': '回合结束', 'busy': '忙碌',
  "Archive": "消息存档",
  "archive · inbox only": "消息存档 · 仅收件箱",
  "archive only": "仅存档",
  "restarting": "重启中",
  "stopped": "已停止",
  "Role Dock": "角色 Dock",
  "On stage": "在主区",
  "Muted": "已静音",
  "Restart": "重启",
  "View": "查看",
  "Mute": "静音",
  "Unmute": "取消静音",
  "Stop this role": "停止此角色",
  "Stop this role?": "停止此角色？",
  "Messages to it are held until you restart it.": "发给它的消息会暂缓，直到你重启它。",
  "restarting…": "正在重启…",
  "Restarting: exiting and relaunching with the same arguments…": "重启中：正在退出并以相同参数重新启动…",
  "Restart this CLI (same arguments)": "重启此 CLI（相同参数）",
  "Focus mode (double-click the title bar) · Esc to exit": "专注模式（或双击标题栏）· Esc 退出",
  "Click to expand": "单击展开",
  "Drag to resize · click to collapse": "拖动调整宽度 · 单击收起",
  "Deliv.": "投递",
  "Work": "工作",
  "Held": "暂缓",
  "Arch.": "存档",
  "Status & activity": "状态与活动",
  "Show sidebar": "展开侧栏",
  "Account": "账号",
  "Which login this CLI uses. Each account has its own config folder; the default one is never touched.": "此 CLI 使用哪个登录账号。每个账号有独立的配置文件夹，默认账号的文件夹不会被改动。",
  "New account…": "新账号…",
  "account name, e.g. work": "账号名，如 work",
  "Create & log in": "创建并登录",
  "Stored in": "保存在",
  "logged in ✓": "已登录 ✓",
  "not logged in": "未登录",
  "Logged in": "已登录",
  "Not logged in yet": "尚未登录",
  "Log in…": "登录…",
  "Log in": "登录",
  "Logged in ✓ — you can close this.": "已登录 ✓ —— 可以关闭此窗口。",
  "Waiting for login…": "等待登录…",
  "Close": "关闭",
  "Finish the login in the terminal above (a browser window may open). Close this when the status shows logged in.": "在上方终端中完成登录（可能会打开浏览器窗口）。状态显示已登录后即可关闭。",
  "Same CLI and same account:": "同一 CLI 且同一账号：",
  "These roles use the same CLI with the same account and will share one login and session state:": "以下角色使用同一 CLI 的同一账号，会共用登录和会话状态：",
  "Start anyway?": "仍要启动？",
  "role restarting": "角色重启中",
  "role restarted": "角色已重启",
  "role stopped": "角色已停止",
  "role_stopped": "角色已停止",
  "target_offline": "目标离线",
  "target_starting": "目标启动中",
  "target_needs_attention": "目标需要处理",
  "waiting_for_turn_end": "等待回合结束",
  "one_delivery_per_poll": "每轮只投递一条",
  "Accounts": "账号",
  "New account": "新建账号",
  "Re-login": "重新登录",
  "Open folder": "打开文件夹",
  "Default login": "默认账号",
  "the CLI's own login": "CLI 自己的登录",
  "Create": "创建并登录",
  "Manage accounts": "管理账号",
  "To use an account for a role: click the role → Account → pick it.": "让某个角色使用某个账号：点击该角色 → 账号 → 选择它。",
  "Only Codex, Claude Code and Gemini CLI support separate accounts.": "目前只有 Codex、Claude Code 和 Gemini CLI 支持多账号。",
  "Which login this CLI uses. Second account: pick “New account…”, type a name, then “Create & log in”.": "此 CLI 使用哪个登录账号。要用第二个账号：选“新账号…”，起个名字，再点“创建并登录”。",
  "Opened": "已打开",
  "cols": "栏",
  "3 terminals side by side when both side panels are collapsed and each still gets at least 70 columns.": "两侧面板都收起、且每个终端仍有至少 70 列时，并排显示 3 个终端。",
  "Click to switch between 2 and 3 terminals side by side.": "点击切换并排 2 / 3 个终端。",
  "Collapse both side panels to show 3 terminals side by side.": "收起左右两侧面板即可并排显示 3 个终端。",
  "Stop the bridge and exit all CLIs": "停止桥接并退出所有 CLI",
};
const ERR_ZH = {
  ALREADY_RUNNING: '桥接已在运行', WORKSPACE_MISSING: '工作区文件夹不存在', ROLES_INVALID: '至少需要启用两个角色',
  ROLE_NAME_INVALID: '角色名无效（请使用大写下划线格式，如 CODER）', ROLE_DUPLICATE: '角色名重复', ADAPTER_UNKNOWN: '未知的 CLI',
  ADAPTER_NOT_FOUND: '在 PATH 中找不到该 CLI，请用完整路径手动添加', CWD_MISSING: '工作文件夹不存在',
  PICKER_UNSUPPORTED: '此系统不支持原生文件夹选择器，请手动输入路径', PICKER_FAILED: '无法打开文件夹选择器', PICKER_BUSY: '文件夹选择器已打开', ADAPTER_INVALID: '需要填写名称和命令', ADAPTER_ID_TAKEN: '该 CLI 名称已被内置项占用', PRESET_NAME_REQUIRED: '需要预设名称',
  NOT_RUNNING: '桥接未运行', ROLE_UNKNOWN: '未知角色', MESSAGE_FIELD_MISSING: '消息缺少字段', MESSAGE_SCHEMA_INVALID: '消息格式无效',
  MESSAGE_ROUTE_INVALID: '发送方/接收方无效（不能相同）', MESSAGE_TEXT_EMPTY: '消息内容为空', MESSAGE_REPLY_REQUIRED_INVALID: 'reply_required 字段无效',
  REF_ESCAPE: '引用文件必须位于工作区内', REF_MISSING: '引用文件不存在', REF_HASH_MISMATCH: '引用文件哈希不匹配', QUEUED: '消息已排队',
  ACCOUNT_DUPLICATE: '多个角色使用同一 CLI 的同一账号', ACCOUNT_UNSUPPORTED: '此 CLI 不支持多账号', ACCOUNT_MISSING: '账号文件夹不存在', ACCOUNT_EXISTS: '账号已存在', ACCOUNT_NAME_INVALID: '账号名无效（仅限 a-z、0-9、- 或 _，最多 32 个字符）', ROLE_RESTARTING: '该角色正在重启', ROLE_OFFLINE: '该角色已离线',
};
let LANG = (() => { try { const s = localStorage.ccLang; if (s === 'zh' || s === 'en') return s; } catch { } return /^zh/i.test(navigator.language || '') ? 'zh' : 'en'; })();
function t(s) { return LANG === 'zh' && ZH[s] !== undefined ? ZH[s] : s; }
// Backend errors look like CODE or CODE:detail or "CODE: text".
function tErr(msg) {
  msg = String(msg || ''); if (LANG !== 'zh') return msg;
  const m = /^([A-Z_]+)(?::\s*(.*))?$/s.exec(msg); if (!m || !ERR_ZH[m[1]]) return msg;
  return m[2] ? `${ERR_ZH[m[1]]}：${m[2]}` : ERR_ZH[m[1]];
}
const i18nOrig = new WeakMap();
function translateStatic(root = document.body) {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n; (n = w.nextNode());) {
    if (n.parentElement.closest('.xterm,script,style,#roles,#adapters,#pop,#wsRow,#otherTitle,#hiddenTitle,#otherList,#hiddenList,#roleRun,#runSum,#startWhy,#optIdle,#statusList,#feed,#terms,#shandle,#accounts,#acctFoot,#stage,#dock,#parking,#srail,#prail,#ctx,#loginTitle,#loginCmd,#loginState,#loginTermBox,#pill,#toast,#cfgInfo,#waitInfo,#sFrom,#sTo,#presetSel')) continue;
    if (!i18nOrig.has(n)) { const k = n.nodeValue.trim(); if (!k || !(k in ZH)) continue; i18nOrig.set(n, k); }
    const k = i18nOrig.get(n); n.nodeValue = n.nodeValue.replace(n.nodeValue.trim(), t(k));
  }
  for (const e of document.querySelectorAll('[placeholder]')) { if (!e.dataset.ph) e.dataset.ph = e.getAttribute('placeholder'); e.setAttribute('placeholder', t(e.dataset.ph)); }
  const ph = document.querySelector('#presetSel option[value=""]'); if (ph) ph.textContent = t('Choose a preset...');
}
function setLang(l, rerender) {
  LANG = l; try { localStorage.ccLang = l; } catch { }
  document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en';
  document.title = t('CLI Conductor');
  const b = document.getElementById('btnLang'); if (b) { b.querySelectorAll('span[data-l]').forEach(s => s.classList.toggle('on', s.dataset.l === l)); b.title = t('Language'); }
  translateStatic();
  if (rerender) rerender();
}

const BRIEFING_TEMPLATES = {
  en: `You are {role}, one of several AI agents working together through CLI Conductor in the workspace {workspace}.
Your duty: <describe what {role} is responsible for>.
Other roles: {peers}.
How it works:
- Messages from other roles arrive in this terminal as a block starting with [CLIConductor <id> FROM->TO]. Each one tells you whether a reply is required and the exact command to reply with.
- To send a message or reply, run: {send} -From {role} -To <ROLE> -Message "<text>". The bridge delivers it to that role automatically; do not edit outbox files by hand.
- The other role cannot see your terminal. Keep every message self-contained: state the goal, what you did, results, and file paths (inside the workspace) they need.
- Only message a role when you need something from it or are reporting a result. Stay within your duty.
Reply "ready" in this terminal (no bridge message needed) and wait for the first task.`,
  zh: `你是 {role}，是在工作区 {workspace} 中通过 CLI 调度台 协作的几个 AI 代理之一。
你的职责：<请填写 {role} 负责的工作>。
其他角色：{peers}。
协作方式：
- 其他角色发来的消息会以 [CLIConductor <id> 发送方->接收方] 开头的文本块出现在本终端中，并注明是否需要回复以及回复所用的确切命令。
- 发送消息或回复时运行：{send} -From {role} -To <角色名> -Message "<内容>"。桥接会自动把它投递给对方；不要手动编辑 outbox 文件。
- 对方看不到你的终端。每条消息都要完整自足：写清目标、你做了什么、结果，以及对方需要的文件路径（必须在工作区内）。
- 只在需要对方协助或汇报结果时才发消息，专注于你的职责。
请在本终端回复“就绪”（无需通过桥接发消息），然后等待第一个任务。`,
};
function briefingTemplate() { return BRIEFING_TEMPLATES[LANG] || BRIEFING_TEMPLATES.en; }
