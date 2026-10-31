'use strict';
// 主账号 (primary Codex login) + resume gate UI. Server side: lib/primary.js.
// Shows masked emails / aliases / plan / last refresh only; never tokens.
let prim = null;              // GET /api/primary
const resumeBlock = {};       // role name -> { code, where, id } (blocked start / restart: session not in that home)
const resumeNote = {};        // role name -> { owner, current } (info only: session created by another login)
async function loadPrimary() { try { prim = await api('GET', '/api/primary'); } catch { prim = null; } return prim; }
const primName = a => a ? (a.alias || a.email || '?') : '';
const primLabel = a => a ? (a.alias ? `${a.alias}（${a.email}）` : a.email || '?') : '';
function primCurrentLabel() {
  if (!prim || !prim.current) return '';
  const c = prim.current;
  if (c.mode === 'apikey') return t('API key');
  if (c.mode !== 'chatgpt') return t('not logged in');
  return c.alias || c.email || '?';
}
function agoText(iso) {
  const ms = Date.now() - Date.parse(iso || ''); if (!isFinite(ms)) return '—';
  const d = Math.floor(ms / 86400000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000);
  return d >= 1 ? t('{n} days ago').replace('{n}', d) : h >= 1 ? t('{n} h ago').replace('{n}', h) : t('{n} min ago').replace('{n}', Math.max(1, m));
}
const whereText = w => w === 'primary' ? t('the primary account (~/.codex)') : w;
// One sentence per gate result (block or Codex's own "No saved session found").
function resumeText(g) {
  if (!g) return '';
  const id = g.id || '';
  if (g.code === 'RESUME_ELSEWHERE') return t('Session {id} is not in this account ({here}); it is in {where}. Change this role\'s account back, or change Continue conversation.').replace('{id}', id).replace('{here}', whereText(g.here || '')).replace('{where}', whereText(g.where || ''));
  if (g.code === 'RESUME_NOT_FOUND') return t('Session {id} was not found under the primary account or any separate account. Check the ID in Continue conversation.').replace('{id}', id);
  if (g.code === 'RESUME_NOT_FOUND_CLI') return t('Codex could not find session {id} (No saved session found) and exited. The session is not in this account\'s CODEX_HOME: switch back to the account that created it, or change Continue conversation.').replace('{id}', id || '?');
  return g.code || '';
}
const noteText = n => n ? t('This session was created by {owner}; continuing with {current}.').replace('{owner}', n.owner || '?').replace('{current}', n.current || '?') : '';
// "RESUME_BLOCKED:NAME(CODE owner=… where=… id=…); …" (raw or translated) -> [{ name, code, owner, where, id }]
function parseResumeBlocked(msg) {
  const out = []; const re = /([A-Z][A-Z0-9_]*)\((RESUME_[A-Z_]+)([^)]*)\)/g; let m;
  while ((m = re.exec(String(msg || '')))) {
    const g = { name: m[1], code: m[2] }; const rest = m[3];
    for (const k of ['owner', 'where', 'id']) { const x = new RegExp(`\\b${k}=(.*?)(?= (?:owner|where|id)=|$)`).exec(rest); if (x) g[k] = x[1].trim(); }
    out.push(g);
  }
  return out;
}
function setResumeBlocks(list) { for (const g of list) resumeBlock[g.name] = g; if (!status.running) renderPlaceholders(); else for (const g of list) { const r = (status.roles || []).find(x => x.name === g.name); if (r) updateTermBar(r); } }
function clearResumeBlock(name) { if (name) delete resumeBlock[name]; else for (const k of Object.keys(resumeBlock)) delete resumeBlock[k]; }

// Before Start: ask the server which roles may resume. Blocked (session not in that home) -> dialog, no start.
// A session created by another login is continued with the current primary login (note on the card).
async function resumePrecheck(c) {
  let res; try { res = await api('POST', '/api/resume-check', { workspace: c.workspace, roles: (c.roles || []).filter(r => r.enabled !== false) }); } catch (e) { if (e.outdated) return { ok: true, warns: [] }; throw e; }
  clearResumeBlock(); for (const k of Object.keys(resumeNote)) delete resumeNote[k];
  for (const [name, g] of Object.entries(res)) if (g.note) resumeNote[name] = g.note;
  const blocked = Object.entries(res).filter(([, g]) => g.block).map(([name, g]) => ({ name, ...g }));
  if (blocked.length) {
    setResumeBlocks(blocked);
    await dynSheet(t('These roles were not started: the session to continue is not in the account folder the role uses'),
      el('div', { class: 'rb-list' }, blocked.map(g => el('div', { class: 'rb-item' }, el('b', {}, g.name), el('div', {}, resumeText(g))))),
      [[t('Close'), null, 'btn']]);
    return null;
  }
  renderPlaceholders();
  return { ok: true, warns: [] };
}
function resumeWarnToast() { } // no start warnings any more (kept for app.js)

// ---------- account panel: primary section ----------
function renderPrimary(box) {
  const head = el('div', { class: 'row acli' }, el('span', { class: 'nm' }, `${t('Primary account')} · Codex`),
    el('button', { class: 'link', onclick: async () => { await loadPrimary(); renderAccounts(); if (popOpen) renderPop(); } }, '↻ ' + t('Refresh')));
  box.append(head);
  if (!prim) { box.append(el('div', { class: 'hint pnote' }, t('Primary account status is unavailable (older server?).'))); return; }
  for (const a of prim.accounts) {
    box.append(el('div', { class: 'row arow prow' + (a.active ? ' cur' : '') },
      el('div', { class: 'k' }, el('span', { class: 'dot ' + (a.active ? 'idle' : 'archive') }),
        el('div', { style: 'min-width:0' },
          el('div', { class: 'pn' }, el('span', { class: 'pname' }, primName(a)), a.active ? el('span', { class: 'pbadge' }, t('Current')) : ''),
          el('div', { class: 'v' }, [a.alias ? a.email : '', a.plan ? a.plan.toUpperCase() : '', `${t('refreshed')} ${a.lastRefresh ? agoText(a.lastRefresh) : '—'}`].filter(Boolean).join(' · ')))),
      el('div', { class: 'cliact' }, a.active ? '' : el('button', { class: 'btn sm plain', disabled: prim.toolOk ? undefined : '', onclick: () => askPrimarySwitch(a) }, t('Switch')))));
  }
  if (!prim.accounts.length) box.append(el('div', { class: 'hint pnote' }, t('No accounts in codex-auth yet. Add one in a terminal: codex-auth login')));
  if (prim.current && prim.current.mode === 'chatgpt' && !prim.current.known) box.append(el('div', { class: 'hint pnote warnc' }, t('The current login is not in the codex-auth list yet; it is added automatically before a switch.')));
  if (!prim.toolOk) box.append(el('div', { class: 'hint pnote warnc' }, `${t('codex-auth is not available, switching is disabled')} (${tErr(prim.toolError || '')})`));
  box.append(el('div', { class: 'hint pnote' }, t('Primary account = the login of Codex\'s own folder (~/.codex). Sessions and history stay there, so any role can continue any session. Add accounts with codex-auth login.')));
}
async function askPrimarySwitch(a) {
  let pc; try { pc = await api('POST', '/api/primary-precheck', { key: a.key }); } catch (e) { return toast(e.message, 'error'); }
  const cur = prim && prim.accounts.find(x => x.active);
  const blocked = pc.blocked || pc.desktopUnknown;
  const body = el('div', { class: 'pswitch' },
    el('div', { class: 'pfromto' }, el('span', {}, cur ? primLabel(cur) : primCurrentLabel() || '—'), el('span', { class: 'arr' }, '→'), el('b', {}, primLabel(a))),
    blocked ? el('div', { class: 'pblock', role: 'alert' }, el('b', {}, pc.desktopUnknown ? t('Could not check whether the Codex desktop app is running.') : t('The Codex desktop app is running.')),
      el('div', {}, t('It uses the same ~/.codex login and would break if the login changed under it. Quit the desktop app completely (also from the tray), then switch.')),
      pc.desktop && pc.desktop.length ? el('div', { class: 'v' }, pc.desktop.map(d => `${d.name} · PID ${d.pid}`).join('，')) : '') : '',
    pc.roles && pc.roles.length
      ? el('div', { class: 'proles' }, el('div', {}, t('These running roles keep the old login until you restart them yourself:')),
        el('div', { class: 'ask-list' }, pc.roles.map(r => el('span', { class: 'wchip' + (r.state === 'busy' ? ' busy' : '') }, `${r.name} · ${r.state === 'busy' ? t('working') : r.state === 'idle' ? t('idle') : stateText(r.state)}`))))
      : el('div', { class: 'hint' }, t('No running role uses the primary account.')),
    el('div', { class: 'hint' }, t('Nothing is restarted automatically. After a restart, roles continue their sessions in ~/.codex with the new login.')));
  const p = dynSheet(t('Switch the primary account?'), body, [[t('Switch'), 'ok', 'btn'], [t('Cancel'), null, 'btn plain']], 'pswitch-sheet');
  const okBtn = ([...document.querySelectorAll('.sheet-bg.dyn.pswitch-sheet')].pop() || document).querySelector('.ask-acts button');
  if (blocked && okBtn) { okBtn.disabled = true; okBtn.title = t('Quit the Codex desktop app first'); const c = okBtn.nextElementSibling; if (c) requestAnimationFrame(() => c.focus()); }
  if (await p !== 'ok') return;
  try {
    const r = await api('POST', '/api/primary-switch', { key: a.key });
    prim = r.list || await loadPrimary(); clearResumeBlock(); for (const k of Object.keys(resumeNote)) delete resumeNote[k]; renderAccounts(); if (popOpen) renderPop(); renderPlaceholders();
    const need = (r.roles || []).map(x => `${x.name}${x.state === 'busy' ? `（${t('working')}）` : ''}`);
    toast(r.unchanged ? t('Already the primary account.') : `${t('Primary account switched to')} ${r.to}.${need.length ? ' ' + t('Restart these roles yourself to use it:') + ' ' + need.join('、') : ''}`, 'ok');
  } catch (e) { toast(e.message, 'error'); }
}
function onPrimaryMsg(m) { if (m.type !== 'primary') return false; if (m.primary) prim = m.primary; renderAccounts(); if (popOpen) renderPop(); return true; }

// Account changed on a role that continues a session by ID: the user decides, nothing automatic.
async function askResumeAfterAccountChange(r) {
  const o = r.options || {}; if (r.adapter !== 'codex' || o.resume !== 'id' || !String(o.resumeId || '').trim()) return;
  let g = null; try { g = (await api('POST', '/api/resume-check', { workspace: typeof wsValue === 'string' ? wsValue.trim() : '', roles: [{ ...r, name: r.name || 'ROLE' }] }))[String(r.name || 'ROLE').toUpperCase()]; } catch { }
  const a = await dynSheet(t('Account changed. This role continues session {id} by ID').replace('{id}', o.resumeId),
    el('div', { class: 'pswitch' }, el('div', {}, t('Sessions are stored per account folder, so the ID may not exist under the new account.')), g && g.block ? el('div', { class: 'pblock' }, resumeText(g)) : g && g.ok ? el('div', { class: 'hint okc' }, t('The session was found for this account.')) : ''),
    [[t('Use Most recent'), 'last', 'btn'], [t('Clear the ID'), 'clear', 'btn plain'], [t('Keep'), 'keep', 'btn plain']]);
  if (a === 'last') { o.resume = 'last'; }
  else if (a === 'clear') { o.resumeId = ''; }
  delete resumeBlock[r.name];
  try { saveRoster(); } catch { }
}
