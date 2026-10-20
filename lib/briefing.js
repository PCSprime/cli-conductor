// Opening briefing (开场说明) = global dispatch briefing (全局调度说明) + the role's duty + extra notes.
// Placeholders: {role} {duty} {peers} {workspace} {send} {briefingFile}. Unknown {x} are left as-is.
// Pure functions, shared by the server (require) and the browser (served as /briefing.js -> window.Briefing).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Briefing = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const KEYS = ['role', 'duty', 'peers', 'workspace', 'send', 'briefingFile'];
  const RE = /\{(role|duty|peers|workspace|send|briefingFile)\}/g;
  const STR = {
    zh: { unset: '未指定', dutyLine: '你的职责：', archive: '仅存档', open: '（', close: '）', join: '；', anyRole: '<你的角色名>', seeList: '见上方角色列表',
      title: 'CLI 调度台 · 调度说明', note: '每次启动调度或有新角色加入时自动更新。', list: '角色列表', body: '调度说明', none: '（无）' },
    en: { unset: 'not specified', dutyLine: 'Your duty: ', archive: 'archive only', open: ' (', close: ')', join: '; ', anyRole: '<YOUR_ROLE>', seeList: 'see the role list above',
      title: 'CLI Conductor · dispatch briefing', note: 'Rewritten every time the conductor starts or a role joins.', list: 'Roles', body: 'Briefing', none: '(none)' },
  };
  const S = lang => STR[lang] || STR.en;
  const clean = v => String(v == null ? '' : v).trim();

  // wrap(key, value) lets the UI highlight substituted values; default is the plain value.
  function fillBriefing(text, vars, wrap) {
    return String(text || '').replace(RE, (m, k) => vars[k] !== undefined ? (wrap ? wrap(k, String(vars[k])) : String(vars[k])) : m);
  }
  // roles: [{ name, type, duty }]. NAME（duty） when a duty is set; observers are marked archive-only.
  function peerList(roles, self, lang) {
    const s = S(lang);
    const items = (roles || []).filter(o => o && o.name && o.name !== self).map(o => {
      const bits = [o.type === 'observer' ? s.archive : '', clean(o.duty)].filter(Boolean);
      return bits.length ? `${o.name}${s.open}${bits.join(s.join === '；' ? '，' : ', ')}${s.close}` : o.name;
    });
    const anyDuty = (roles || []).some(o => o && o.name !== self && clean(o.duty));
    return items.join(anyDuty ? s.join : ', ') || s.none;
  }
  // Full text one role receives. '' = nothing to send.
  // ctx: { global, roles, workspace, send, briefingFile, lang }; role: { name, duty, extra }.
  function composeBriefing(ctx, role, wrap) {
    const s = S(ctx.lang), duty = clean(role.duty);
    const vars = { role: role.name, duty: duty || s.unset, peers: peerList(ctx.roles, role.name, ctx.lang), workspace: ctx.workspace || '', send: ctx.send || '', briefingFile: ctx.briefingFile || '' };
    const global = String(ctx.global || '');
    let g = fillBriefing(global, vars, wrap).trim();
    if (duty && !/\{duty\}/.test(global)) {
      const line = s.dutyLine + (wrap ? wrap('duty', duty) : duty);
      if (!g) g = line;
      else { const i = g.indexOf('\n'); g = i < 0 ? `${g}\n${line}` : `${g.slice(0, i)}\n${line}${g.slice(i)}`; }
    }
    const extra = fillBriefing(String(role.extra || ''), vars, wrap).trim();
    return [g, extra].filter(Boolean).join('\n\n');
  }
  // BRIEFING.md: the role-neutral briefing plus the full role list with duties (agents can reread it).
  function briefingFileText(ctx, at) {
    const s = S(ctx.lang);
    const colon = ctx.lang === 'zh' ? '：' : ': ';
    const list = (ctx.roles || []).map(o => `- ${o.name}${o.type === 'observer' ? `${s.open}${s.archive}${s.close}` : ''}${colon}${clean(o.duty) || s.unset}`);
    const vars = { role: s.anyRole, duty: s.seeList, peers: (ctx.roles || []).map(o => o.name).join(', ') || s.none, workspace: ctx.workspace || '', send: ctx.send || '', briefingFile: ctx.briefingFile || '' };
    const body = fillBriefing(String(ctx.global || ''), vars).trim();
    return `# ${s.title}\n\n${s.note}${at ? `${s.open}${at}${s.close}` : ''}\n\n## ${s.list}\n\n${list.join('\n') || s.none}\n\n## ${s.body}\n\n${body || s.none}\n`;
  }
  return { KEYS, fillBriefing, peerList, composeBriefing, briefingFileText };
});
