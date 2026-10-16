'use strict';
// CLI adapter table. busy: regex sources visible on screen while a turn runs.
// exit: command typed to quit cleanly.
const BUILTIN = [
  { id: 'codex', label: 'Codex CLI', commands: ['codex'], busy: ['esc to interrupt'], done: ['Worked for \\d+'], exit: '/exit', submitDelayMs: 700 },
  { id: 'claude', label: 'Claude Code', commands: ['claude'], busy: ['esc to interrupt'], exit: '/exit' },
  { id: 'gemini', label: 'Gemini CLI', commands: ['gemini'], busy: ['esc to cancel'], exit: '/quit' },
  { id: 'qodercn', label: 'Qoder CLI (CN)', commands: ['qodercn', 'qoderclicn'], busy: ['esc to cancel', '(Thinking|Generating)\\.\\.\\.'], exit: '/exit' },
  { id: 'qoder', label: 'Qoder CLI', commands: ['qodercli', 'qoder'], busy: ['esc to cancel', '(Thinking|Generating)\\.\\.\\.'], exit: '/exit' },
  { id: 'copilot', label: 'GitHub Copilot CLI', commands: ['copilot'], busy: [], exit: '/exit' },
  { id: 'cursor', label: 'Cursor CLI', commands: ['agent', 'cursor-agent'], busy: [], exit: '/exit' },
  { id: 'aider', label: 'Aider', commands: ['aider'], busy: [], exit: '/exit' },
  { id: 'opencode', label: 'opencode', commands: ['opencode'], busy: [], exit: '/exit' },
  { id: 'qwen', label: 'Qwen Code', commands: ['qwen'], busy: ['esc to cancel'], exit: '/quit' },
  { id: 'kimi', label: 'Kimi Code CLI', commands: ['kimi'], busy: [], exit: '/exit' },
  { id: 'iflow', label: 'iFlow CLI', commands: ['iflow'], busy: ['esc to cancel'], exit: '/quit' },
  { id: 'amp', label: 'Amp', commands: ['amp'], busy: [], exit: '/exit' },
  { id: 'kiro', label: 'Kiro CLI', commands: ['kiro-cli', 'kiro'], busy: [], exit: '/quit' },
  { id: 'crush', label: 'Crush', commands: ['crush'], busy: [], exit: '' },
  { id: 'auggie', label: 'Augment Auggie', commands: ['auggie'], busy: [], exit: '/exit' },
  { id: 'droid', label: 'Factory Droid', commands: ['droid'], busy: [], exit: '/exit' },
  { id: 'cline', label: 'Cline CLI', commands: ['cline'], busy: [], exit: '/exit' },
  { id: 'goose', label: 'Goose', commands: ['goose'], busy: [], exit: '/exit' },
  { id: 'pwsh', label: 'PowerShell 7', commands: ['pwsh'], busy: [], exit: 'exit' },
];

// Strict first-run / blocking prompt detector, applied to the bottom of the screen only.
// A match puts the role in "attention"; nothing is delivered until a human answers in
// the terminal card. The bridge never answers these prompts by itself.
const FIRST_RUN = [
  /Do you trust the (files|contents|authors)\b[^?\n]{0,100}\?/i,
  /\btrust (this|the) (folder|directory|workspace)\b[^?\n]{0,40}\?/i,
  /\[y\/N\]\s*:?\s*$/im,
  /\[Y\/n\]\s*:?\s*$/im,
  /Press Enter to continue/i,
  /\b(sign|log) ?in (to continue|required)\b/i,
  /Allow [^\n]{1,80} to (run|execute|access)[^\n]{0,40}\?/i,
];

function compile(adapter) {
  return {
    ...adapter,
    busyRe: (adapter.busy || []).map(s => new RegExp(s, 'i')),
    doneRe: (adapter.done || []).map(s => new RegExp(s, 'i')),
  };
}

function detectFirstRun(bottomText) {
  for (const re of FIRST_RUN) {
    const m = bottomText.match(re);
    if (m) return m[0];
  }
  return null;
}

module.exports = { BUILTIN, FIRST_RUN, compile, detectFirstRun };