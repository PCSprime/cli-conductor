'use strict';
// Structured per-role options -> CLI arguments. Only flags verified in the official docs
// (flags verified against each CLI's --help output) are mapped. Rules:
//  - resume never emits a picker-opening form (no bare `-r`, no `codex resume` without --last/ID);
//  - resume subcommands (codex resume, amp threads continue) go first;
//  - raw args are appended last.
// options: { model, effort, resume: 'off'|'last'|'id', resumeId, perm: ''|'readonly'|'edit'|'auto', skipAll, addDirs: [] }
const { splitArgs } = require('./scanner');

const kv = (flag, eq) => v => eq ? [`${flag}=${v}`] : [flag, v];
const rep = (flag, eq) => dirs => dirs.flatMap(d => eq ? [`${flag}=${d}`] : [flag, d]);
const joined = flag => dirs => [flag, dirs.join(',')];
const EFF5 = ['low', 'medium', 'high', 'xhigh', 'max'];
// Model and effort lists: only values the CLI's official docs/source show for that flag (checked 2026-10-20),
// newest/recommended first. Effort levels a given model doesn't support are handled by the CLI itself.
// What an account can actually use depends on its plan/provider; the UI keeps a free-text option.

const SPECS = {
  codex: {
    model: { values: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'], args: kv('-m') },
    effort: { values: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], args: v => ['-c', `model_reasoning_effort=${v}`] },
    perm: { readonly: ['--sandbox', 'read-only'], edit: ['--sandbox', 'workspace-write'], auto: ['--approve-for-me'] },
    skipAll: ['--dangerously-bypass-approvals-and-sandbox'], skipAllExclusive: true,
    resume: { last: ['resume', '--last'], id: id => ['resume', id], first: true },
    addDir: rep('--add-dir'),
  },
  claude: {
    model: { values: ['opus', 'sonnet', 'haiku', 'fable', 'best', 'opusplan', 'opus[1m]', 'sonnet[1m]', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'claude-fable-5'], args: kv('--model') },
    effort: { values: EFF5, args: kv('--effort') },
    perm: { readonly: ['--permission-mode', 'plan'], edit: ['--permission-mode', 'acceptEdits'], auto: ['--permission-mode', 'auto'] },
    skipAll: ['--dangerously-skip-permissions'], skipAllExclusive: true,
    resume: { last: ['--continue'], id: id => ['--resume', id] },
    addDir: rep('--add-dir'),
  },
  gemini: {
    model: { values: ['auto', 'pro', 'flash', 'flash-lite', 'gemini-3.1-pro-preview', 'gemini-3-pro-preview', 'gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-2.5-pro'], args: kv('-m') },
    perm: { readonly: ['--approval-mode', 'plan'], edit: ['--approval-mode', 'auto_edit'], auto: ['--approval-mode', 'yolo'] },
    skipAll: ['--approval-mode', 'yolo'], skipAllExclusive: true,
    resume: { last: ['--resume', 'latest'], id: id => ['--resume', id], idHint: 'index' },
    addDir: joined('--include-directories'),
  },
  qoder: {
    model: { values: ['auto', 'efficient'], args: kv('-m') },
    effort: { values: EFF5, args: kv('--reasoning-effort') },
    perm: { readonly: ['--permission-mode', 'plan'], edit: ['--permission-mode', 'accept_edits'], auto: ['--permission-mode', 'auto'] },
    skipAll: ['--yolo'], skipAllExclusive: true,
    resume: { last: ['--continue'], id: id => ['--resume', id] },
  },
  copilot: {
    model: { values: ['auto', 'claude-sonnet-5.5', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'claude-opus-5.5', 'claude-haiku-5.5', 'claude-haiku-4.5', 'gpt-5.3-codex', 'gemini-3.8-flash'], args: kv('--model', true) },
    effort: { values: EFF5, args: kv('--effort', true) },
    perm: { readonly: ['--mode=plan'], auto: ['--mode=autopilot'] },
    skipAll: ['--yolo'],
    resume: { last: ['--continue'], id: id => [`--resume=${id}`] },
    addDir: rep('--add-dir', true),
  },
  cursor: {
    model: { values: ['auto'], args: kv('--model') },
    perm: { readonly: ['--mode', 'ask'] },
    skipAll: ['--force'],
    resume: { last: ['--continue'], id: id => ['--resume', id] },
  },
  aider: {
    model: { values: [], args: kv('--model') },
    effort: { values: ['low', 'medium', 'high'], args: kv('--reasoning-effort') },
    skipAll: ['--yes-always'],
    resume: { last: ['--restore-chat-history'] },
  },
  opencode: {
    model: { values: [], args: kv('-m'), placeholder: 'provider/model' },
    perm: { readonly: ['--agent', 'plan'] },
    skipAll: ['--auto'],
    resume: { last: ['--continue'], id: id => ['--session', id] },
  },
  qwen: {
    model: { values: [], args: kv('-m') },
    perm: { readonly: ['--approval-mode', 'plan'], edit: ['--approval-mode', 'auto-edit'], auto: ['--approval-mode', 'auto'] },
    skipAll: ['--yolo'], skipAllExclusive: true,
    addDir: joined('--include-directories'),
  },
  kimi: {
    model: { values: [], args: kv('-m') },
    effort: { values: ['off', 'on'], args: v => v === 'on' ? ['--thinking'] : ['--no-thinking'] },
    perm: { readonly: ['--plan'] },
    skipAll: ['--yolo'],
    resume: { last: ['--continue'], id: id => ['--session', id] },
    addDir: rep('--add-dir'),
  },
  iflow: {
    model: { values: [], args: kv('-m') },
    skipAll: ['--yolo'],
    resume: { last: ['--continue'] },
    addDir: joined('--include-directories'),
  },
  amp: {
    skipAll: ['--dangerously-allow-all'],
    resume: { id: id => ['threads', 'continue', id], first: true },
  },
  kiro: {
    base: ['chat'],
    effort: { values: EFF5, args: kv('--effort') },
    skipAll: ['--trust-all-tools'],
    resume: { last: ['--resume'], id: id => ['--resume-id', id] },
  },
  crush: { skipAll: ['--yolo'] },
  auggie: {
    model: { values: [], args: kv('--model') },
    resume: { last: ['--continue'], id: id => ['--resume', id] },
    addDir: rep('--add-workspace'),
  },
  droid: {
    model: { values: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5.1', 'claude-haiku-5-5', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5.6-sol', 'gemini-3.1-pro-preview', 'gemini-3.8-flash', 'grok-4.7', 'glm-5.3', 'kimi-k3', 'qwen3.8-max', 'deepseek-v4.1-flash', 'minimax-m3'], args: kv('-m') },
    effort: { values: ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], args: kv('--reasoning-effort') },
    resume: { last: ['--resume'], id: id => ['--resume', id] },
  },
  cline: {
    model: { values: [], args: kv('-m') },
    effort: { values: ['none', 'low', 'medium', 'high', 'xhigh'], args: kv('--thinking') },
    perm: { readonly: ['--plan'], edit: ['--act'], auto: ['--act', '--auto-approve', 'true'] },
    permNative: { auto: '--auto-approve' }, // shorter UI hint than the full arg list
    // no skipAll: `-y/--yolo` forces non-interactive mode and exits.
  },
  goose: {
    base: ['session'],
    model: { values: [], args: kv('--model') },
    resume: { last: ['--resume'], id: id => ['--resume', '--session-id', id] },
  },
};
SPECS.qodercn = { ...SPECS.qoder, model: { values: ['auto', 'Qwen3.8-Max', 'Qwen3.7-Max', 'Qwen3.7-Plus', 'Qwen3.6-Flash', 'DeepSeek-V4-Pro', 'DeepSeek-V4-Flash', 'GLM-5.2', 'Kimi-K2.7-Code', 'MiniMax-M2.7'], args: kv('-m') }, addDir: rep('--add-dir') };

// Short native name of a mapped option, as the CLI calls it, derived from its args so it can't drift:
// ['--sandbox', 'read-only'] -> 'read-only', ['--mode=plan'] -> 'plan', ['--yolo'] -> '--yolo'.
function nativeHint(args) {
  const a = [].concat(args || []).map(String);
  if (a.length === 2 && !a[1].startsWith('-')) return a[1];
  if (a.length === 1) { const m = /^--?[^=]+=(.+)$/.exec(a[0]); return m ? m[1] : a[0]; }
  return a.join(' ');
}
const own = (o, k) => !!o && typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
// Drop saved choices this CLI doesn't offer (e.g. a role saved with perm 'edit', then switched to copilot):
// the UI shows them as Default and buildArgs sends nothing for them.
function sanitizeOptions(id, options = {}) {
  const s = SPECS[id] || {};
  const o = { ...(options || {}) };
  if (o.perm && !own(s.perm, o.perm)) o.perm = '';
  if (o.skipAll && !s.skipAll) o.skipAll = false;
  if (o.effort && !(s.effort && s.effort.values.includes(clean(o.effort)))) o.effort = '';
  return o;
}

// What the UI may show for a CLI (no functions).
function capabilities(id) {
  const s = SPECS[id]; if (!s) return null;
  return {
    model: s.model ? { values: s.model.values, placeholder: s.model.placeholder || '' } : null,
    effort: s.effort ? { values: s.effort.values } : null,
    perm: s.perm ? Object.keys(s.perm) : null,
    permNative: s.perm ? Object.fromEntries(Object.entries(s.perm).map(([k, a]) => [k, (s.permNative && s.permNative[k]) || nativeHint(a)])) : null,
    skipAll: !!s.skipAll,
    skipAllNative: s.skipAll ? nativeHint(s.skipAll) : '',
    resume: s.resume ? { last: !!s.resume.last, id: !!s.resume.id, idHint: s.resume.idHint || 'id' } : null,
    addDir: !!s.addDir,
  };
}
function allCapabilities() { return Object.fromEntries(Object.keys(SPECS).map(k => [k, capabilities(k)])); }

const clean = v => String(v == null ? '' : v).trim();
function buildArgs(id, options = {}, rawArgs = '', defaultArgs = []) {
  const s = SPECS[id] || {};
  const o = sanitizeOptions(id, options);
  const first = [], flags = [];
  if (s.resume && o.resume === 'last' && s.resume.last) (s.resume.first ? first : flags).push(...s.resume.last);
  if (s.resume && o.resume === 'id' && s.resume.id && clean(o.resumeId)) (s.resume.first ? first : flags).push(...s.resume.id(clean(o.resumeId)));
  if (s.model && clean(o.model)) flags.push(...s.model.args(clean(o.model)));
  if (s.effort && clean(o.effort) && s.effort.values.includes(clean(o.effort))) flags.push(...s.effort.args(clean(o.effort)));
  const skip = !!(o.skipAll && s.skipAll);
  if (o.perm && own(s.perm, o.perm) && !(skip && s.skipAllExclusive)) flags.push(...s.perm[o.perm]);
  if (skip) flags.push(...s.skipAll);
  const dirs = [].concat(o.addDirs || []).map(clean).filter(Boolean);
  if (s.addDir && dirs.length) flags.push(...s.addDir(dirs));
  return [...first, ...(s.base || []), ...defaultArgs, ...flags, ...splitArgs(rawArgs)];
}
// True when the final argv continues an earlier conversation, whether it came from the structured
// "Continue conversation" option or from raw args. Used to skip the opening briefing (the resumed
// session already has it). Short flags are only matched where the CLI documents them.
const RESUME_LONG = new Set(['--resume', '--continue', '--resume-id', '--restore-chat-history']);
const RESUME_SHORT = { claude: ['-c', '-r'], gemini: ['-r'], opencode: ['--session', '-s'], kimi: ['--session'] };
function isResume(id, args = []) {
  const a = [].concat(args || []).map(x => String(x));
  if (a.some(x => RESUME_LONG.has(x) || /^--(resume|continue|resume-id)=/.test(x))) return true;
  if ((RESUME_SHORT[id] || []).some(f => a.includes(f))) return true;
  if (id === 'codex' && a.includes('resume')) return true;
  for (let i = 0; i + 1 < a.length; i++) if (a[i] === 'threads' && a[i + 1] === 'continue') return true;
  return false;
}
module.exports = { SPECS, buildArgs, capabilities, allCapabilities, isResume, sanitizeOptions, nativeHint };
