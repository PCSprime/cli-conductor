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

const SPECS = {
  codex: {
    model: { values: ['gpt-5.5', 'gpt-5.5-codex', 'gpt-5-mini'], args: kv('-m') },
    perm: { readonly: ['--sandbox', 'read-only'], edit: ['--sandbox', 'workspace-write'], auto: ['--approve-for-me'] },
    skipAll: ['--dangerously-bypass-approvals-and-sandbox'], skipAllExclusive: true,
    resume: { last: ['resume', '--last'], id: id => ['resume', id], first: true },
    addDir: rep('--add-dir'),
  },
  claude: {
    model: { values: ['sonnet', 'opus', 'haiku'], args: kv('--model') },
    effort: { values: EFF5, args: kv('--effort') },
    perm: { readonly: ['--permission-mode', 'plan'], edit: ['--permission-mode', 'acceptEdits'], auto: ['--permission-mode', 'auto'] },
    skipAll: ['--dangerously-skip-permissions'], skipAllExclusive: true,
    resume: { last: ['--continue'], id: id => ['--resume', id] },
    addDir: rep('--add-dir'),
  },
  gemini: {
    model: { values: ['auto', 'pro', 'flash', 'flash-lite'], args: kv('-m') },
    perm: { readonly: ['--approval-mode', 'plan'], edit: ['--approval-mode', 'auto_edit'], auto: ['--approval-mode', 'yolo'] },
    skipAll: ['--approval-mode', 'yolo'], skipAllExclusive: true,
    resume: { last: ['--resume', 'latest'], id: id => ['--resume', id], idHint: 'index' },
    addDir: joined('--include-directories'),
  },
  qoder: {
    model: { values: ['auto', 'lite', 'performance', 'efficient'], args: kv('-m') },
    effort: { values: ['low', 'medium', 'high'], args: kv('--reasoning-effort') },
    perm: { readonly: ['--permission-mode', 'plan'], edit: ['--permission-mode', 'accept_edits'], auto: ['--permission-mode', 'auto'] },
    skipAll: ['--yolo'], skipAllExclusive: true,
    resume: { last: ['--continue'], id: id => ['--resume', id] },
  },
  copilot: {
    model: { values: ['auto'], args: kv('--model', true) },
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
    model: { values: [], args: kv('-m') },
    effort: { values: ['low', 'medium', 'high'], args: kv('--reasoning-effort') },
    resume: { last: ['--resume'], id: id => ['--resume', id] },
  },
  cline: {
    model: { values: [], args: kv('-m') },
    effort: { values: ['none', 'low', 'medium', 'high', 'xhigh'], args: kv('--thinking') },
    perm: { readonly: ['--plan'], edit: ['--act'], auto: ['--act', '--auto-approve', 'true'] },
    // no skipAll: `-y/--yolo` forces non-interactive mode and exits.
  },
  goose: {
    base: ['session'],
    model: { values: [], args: kv('--model') },
    resume: { last: ['--resume'], id: id => ['--resume', '--session-id', id] },
  },
};
SPECS.qodercn = { ...SPECS.qoder, model: { values: ['auto'], args: kv('-m') }, addDir: rep('--add-dir') };

// What the UI may show for a CLI (no functions).
function capabilities(id) {
  const s = SPECS[id]; if (!s) return null;
  return {
    model: s.model ? { values: s.model.values, placeholder: s.model.placeholder || '' } : null,
    effort: s.effort ? { values: s.effort.values } : null,
    perm: s.perm ? Object.keys(s.perm) : null,
    skipAll: !!s.skipAll,
    resume: s.resume ? { last: !!s.resume.last, id: !!s.resume.id, idHint: s.resume.idHint || 'id' } : null,
    addDir: !!s.addDir,
  };
}
function allCapabilities() { return Object.fromEntries(Object.keys(SPECS).map(k => [k, capabilities(k)])); }

const clean = v => String(v == null ? '' : v).trim();
function buildArgs(id, options = {}, rawArgs = '', defaultArgs = []) {
  const s = SPECS[id] || {};
  const o = options || {};
  const first = [], flags = [];
  if (s.resume && o.resume === 'last' && s.resume.last) (s.resume.first ? first : flags).push(...s.resume.last);
  if (s.resume && o.resume === 'id' && s.resume.id && clean(o.resumeId)) (s.resume.first ? first : flags).push(...s.resume.id(clean(o.resumeId)));
  if (s.model && clean(o.model)) flags.push(...s.model.args(clean(o.model)));
  if (s.effort && clean(o.effort) && s.effort.values.includes(clean(o.effort))) flags.push(...s.effort.args(clean(o.effort)));
  const skip = !!(o.skipAll && s.skipAll);
  if (s.perm && o.perm && s.perm[o.perm] && !(skip && s.skipAllExclusive)) flags.push(...s.perm[o.perm]);
  if (skip) flags.push(...s.skipAll);
  const dirs = [].concat(o.addDirs || []).map(clean).filter(Boolean);
  if (s.addDir && dirs.length) flags.push(...s.addDir(dirs));
  return [...first, ...(s.base || []), ...defaultArgs, ...flags, ...splitArgs(rawArgs)];
}
module.exports = { SPECS, buildArgs, capabilities, allCapabilities };
