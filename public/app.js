'use strict';
const $ = id => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v); } for (const c of kids.flat()) if (c !== null && c !== undefined && c !== '') e.append(c instanceof Node ? c : document.createTextNode(String(c))); return e; };
const COLORS = ['#5e5ce6', '#0a84ff', '#34c759', '#ff9500', '#af52de', '#ff2d55'];
const STATE_TEXT = { idle: 'idle', busy: 'working', starting: 'starting', offline: 'offline', attention: 'needs attention', archive: 'inbox only', restarting: 'restarting' };
const stateText = s => STATE_TEXT[s] ? t(STATE_TEXT[s]) : s;
let adapters = [], status = { running: false }, terms = {}, ws = null, events = [], selIdx = 0, popOpen = false;
let ui = { recentDirs: [], hiddenAdapters: [] };

async function api(method, url, body) {
  let r;
  try { r = await fetch(url, { method, headers: { 'content-type': 'application/json', 'x-cli-conductor': '1' }, body: body ? JSON.stringify(body) : undefined }); }
  catch { throw new Error(t('Cannot reach the server. Is npm start running?')); }
  const text = await r.text().catch(() => '');
  let j = null; try { j = text ? JSON.parse(text) : {}; } catch { j = null; }
  if (r.status === 404 || (j === null && url.startsWith('/api/'))) throw Object.assign(new Error(t('The server is an older version. Restart npm start.')), { outdated: true });
  if (!r.ok) throw new Error(tErr((j && j.error) || r.statusText || `HTTP ${r.status}`));
  return j;
}
function toast(msg) { const x = $('toast'); x.textContent = msg; x.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => x.classList.remove('show'), 3200); }
function sw(btn, on) { if (on !== undefined) btn.classList.toggle('on', !!on); return btn.classList.contains('on'); }
function seg(options, value, onchange, s = el('div', { class: 'seg' })) {
  s.innerHTML = '';
  for (const [v, label] of options) { const b = el('button', { type: 'button', class: String(v) === String(value) ? 'on' : '', onclick: () => { [...s.children].forEach(c => c.classList.remove('on')); b.classList.add('on'); s.dataset.value = v; onchange && onchange(v); } }, label); s.append(b); }
  s.dataset.value = value; return s;
}
const roleColor = (r, i) => r.type === 'observer' ? '#8e8e93' : COLORS[i % COLORS.length];
const adapterLabel = id => (adapters.find(a => a.id === id) || {}).label || id || '';

// ---------- ui state (recent folders, hidden CLIs) ----------
async function uiPatch(p) { try { ui = await api('POST', '/api/ui-state', p); } catch (e) { toast(e.message); } }
// Folder field: manual input + 浏览… (native picker on the server) + recent chips.
function folderField({ value, placeholder, onchange, recent = true }) {
  const input = el('input', { type: 'text', class: 'field mono', value: value || '', placeholder: placeholder || '', oninput: e => onchange(e.target.value) });
  const browse = el('button', { class: 'browse', type: 'button', onclick: async () => {
    browse.disabled = true;
    try { const r = await api('POST', '/api/pick-folder', { initial: input.value.trim() }); if (r.path) { input.value = r.path; onchange(r.path); ui = await api('GET', '/api/ui-state'); renderChips(); } }
    catch (e) { toast(e.message); } finally { browse.disabled = !!status.running; }
  } }, t('Browse…'));
  const chips = el('div', { class: 'recent' });
  function renderChips() {
    chips.innerHTML = ''; if (!recent || !ui.recentDirs.length) return;
    chips.append(el('span', { class: 'lbl' }, t('Recent:')));
    for (const d of ui.recentDirs.slice(0, 4)) chips.append(el('button', { class: 'chip', type: 'button', title: d, onclick: () => { input.value = d; onchange(d); } }, d.length > 34 ? '…' + d.slice(-32) : d));
  }
  renderChips();
  if (status.running) { input.disabled = true; browse.disabled = true; }
  return el('div', { class: 'folder' }, el('div', { class: 'fold' }, input, browse), chips);
}
let wsValue = '';
function renderWorkspace() { const r = $('wsRow'); r.innerHTML = ''; r.append(folderField({ value: wsValue, placeholder: 'C:\\path\\to\\project', onchange: v => { wsValue = v; renderFoot(); } })); renderFoot(); }
function renderFoot() {
  const sum = $('runSum'), why = $('startWhy'), start = $('btnStart');
  if (status.running) { const b = status.bridge || {}; sum.textContent = `${t('Running')} · ${roleCountText(status.roles)} · ${t('Workspace')} ${b.workspace || wsValue}`; sum.title = sum.textContent; why.textContent = ''; return; }
  const n = roles.filter(r => r.enabled).length, w = wsValue.trim();
  sum.textContent = `${n} ${t('roles enabled')} · ${t('Workspace')} ${w || '—'}`; sum.title = sum.textContent;
  const reason = !w ? t('Set a workspace folder first.') : n < 2 ? t('Enable at least two roles.') : '';
  start.disabled = !!reason; why.textContent = reason; why.classList.remove('warn');
  const dup = reason ? [] : duplicateAccounts(roles);
  if (dup.length) { why.textContent = `${t('Same CLI and same account:')} ${dup.join('; ')}`; why.classList.add('warn'); }
}

// ---------- roles (sidebar list + popover editor) ----------
let roles = [
  { enabled: true, name: 'CODER', type: 'agent', adapter: 'qodercn', delivery: 'immediate', cwd: '', args: '', briefing: '', briefOn: true, duty: '' },
  { enabled: true, name: 'REVIEWER', type: 'agent', adapter: 'codex', delivery: 'immediate', cwd: '', args: '', briefing: '', briefOn: true, duty: '' },
  { enabled: false, name: 'ARCHIVE', type: 'observer', adapter: '', delivery: 'archive_only', cwd: '', args: '', briefing: '', briefOn: true, duty: '' },
];
function roleSub(r) { return r.type === 'observer' ? t('archive · inbox only') : `${adapterLabel(r.adapter)} · ${r.delivery === 'after_turn' ? t('after turn') : t('immediate')}`; }
// Full left-list roster: always config roles (tbLast), overlaid with live status when running.
// Roles disabled at Start (or not yet spawned) stay listed as stopped/off so they can be powered on.
function rosterList() {
  if (!status.running) return roles.slice();
  const live = new Map((status.roles || []).map(r => [r.name, r]));
  const out = [], seen = new Set();
  for (const cfg of roles) {
    const name = cfg.name;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const L = live.get(name);
    if (L) out.push({ ...cfg, ...L, name: L.name || name });
    else out.push({
      ...cfg,
      name,
      state: cfg.type === 'observer' ? 'archive' : 'offline',
      stopped: cfg.type !== 'observer',
      pid: 0,
      label: cfg.label,
      notInRun: true,
    });
  }
  for (const L of (status.roles || [])) {
    if (seen.has(L.name)) continue;
    if (L.stopped && typeof hiddenRoles !== 'undefined' && hiddenRoles.has(L.name)) continue;
    seen.add(L.name);
    out.push({ ...L });
  }
  return out;
}
function rosterRole(i) { return rosterList()[i]; }
function rosterByName(n) { return rosterList().find(r => r.name === n); }

// open: true (anchor to the left list row) or the element that was clicked (Dock card, rail icon, placeholder).
// Clicking the role whose popover is already open closes it (toggle); another role switches it.
function select(i, open) {
  if (open && popOpen && i === selIdx) return closePop();
  selIdx = i;
  const r = status.running ? rosterRole(i) : roles[i];
  const anchor = open === true ? document.querySelector(`#roles .rrow[data-i="${i}"]`) : open;
  if (!status.running && r) { if (r.enabled && r.type !== 'observer') { preSwap(r); if (open) openPop(anchor); else if (popOpen) openPop(popAnchorFor(i)); return; } preLast.set(r, Date.now()); }
  renderRoles(); highlightTerm(); if (open) openPop(anchor); else if (popOpen) renderPop();
}
function renderRoles() {
  const side = document.querySelector('.side');
  const keepScroll = side ? side.scrollTop : 0;
  const box = $('roles'); box.innerHTML = '';
  const running = status.running;
  const list = rosterList();
  if (selIdx >= list.length) selIdx = Math.max(0, list.length - 1);
  list.forEach((r, i) => {
    const sel = i === selIdx;
    const live = running && (status.roles || []).some(x => x.name === r.name && !x.stopped);
    const stopped = !!(running && (r.stopped || r.notInRun || r.state === 'offline') && r.type !== 'observer');
    const check = running ? null : el('input', { type: 'checkbox', class: 'check', ...(r.enabled ? { checked: '' } : {}), onclick: e => { e.stopPropagation(); r.enabled = e.target.checked; const cfg = roles.find(x => x.name === r.name); if (cfg) cfg.enabled = r.enabled; renderRoles(); renderPlaceholders(); } });
    let power = null;
    if (running && r.type !== 'observer') {
      const on = live;
      const toggle = () => { if (on) stopRole(r.name); else startRole(r.name); };
      power = el('button', {
        class: 'switch sm role-power' + (on ? ' on' : ''),
        type: 'button',
        title: on ? t('Stop this role') : t('Start this role'),
        'aria-label': on ? t('Stop this role') : t('Start this role'),
        onpointerdown: e => { e.stopPropagation(); },
        onpointerup: e => { e.stopPropagation(); },
        onclick: e => { e.preventDefault(); e.stopPropagation(); toggle(); }
      });
    }
    const trail = running
      ? el('div', { class: 'k powerk' }, power || '', el('span', { class: 'dot ' + (r.type === 'observer' ? 'archive' : (stopped ? 'offline' : r.state)) }))
      : el('div', { class: 'k' }, el('span', { class: 'gear' }, '›'), el('span', { class: 'dot ' + (r.enabled ? 'idle' : 'offline') }));
    const sub = running
      ? (r.type === 'observer' ? t('archive · inbox only') : (stopped ? (r.notInRun ? t('not started') : t('stopped')) : `${r.label || r.adapter} · ${stateText(r.state)}`))
      : roleSub(r);
    box.append(el('div', { class: 'row rrow' + (sel ? ' sel' : '') + ((!running && !r.enabled) || stopped ? ' off' : ''), 'data-i': i, 'data-role': r.name || '', onclick: () => select(i, true) },
      el('div', { class: 'k' }, check, el('div', { class: 'icon', style: `background:${roleColor(r, i)}` }, (r.name || '?')[0]),
        el('div', { style: 'min-width:0' }, el('div', { class: 'nm' }, r.name || '—'), el('div', { class: 'v' }, sub))),
      trail));
  });
  // Always show add control (hot-add while running via /api/add-role).
  $('btnAddRole').classList.remove('hidden');
  $('btnAddRole').textContent = t('＋ Add Role');
  renderFoot(); renderSideRail();
  if (side) side.scrollTop = keepScroll;
}
// ---------- popover anchoring ----------
// The anchor kind is remembered; the element is looked up again on every reposition because
// lists and Dock cards are re-rendered.
let popKind = 'row';
const anchorKind = e => !e ? 'row' : e.closest('#dock') ? 'dock' : e.closest('#srail') ? 'rail' : e.closest('#stage') ? 'stage' : 'row';
const visible = e => !!(e && e.offsetParent !== null && e.getClientRects().length);
function popAnchorFor(i) { return findAnchor(popKind, i); }
function findAnchor(kind, i) {
  const name = status.running ? (rosterRole(i) || {}).name : null;
  const q = {
    dock: status.running ? `#dock .dc[data-role="${name}"]` : `#dock .dc[data-i="${i}"]`,
    rail: `#srail .ri.role[data-i="${i}"]`,
    stage: status.running ? `#stage .term[data-role="${name}"]` : `#stage .term[data-i="${i}"]`,
    row: `#roles .rrow[data-i="${i}"]`,
  };
  for (const k of [kind, 'row', 'rail', 'dock', 'stage']) { const e = document.querySelector(q[k]); if (visible(e)) return e; }
  return null;
}
function positionPop() {
  const pop = $('pop'); if (!popOpen) return;
  const Z = parseFloat(pop.style.zoom) || 1; // chrome zoom on wide screens: lengths are set in zoomed units
  const a = findAnchor(popKind, selIdx), w = pop.offsetWidth * Z, M = 8, TOP = 60;
  pop.classList.remove('above', 'noarrow'); pop.style.maxHeight = '';
  if (!a) { pop.classList.add('noarrow'); pop.style.left = (Math.max(M, (innerWidth - w) / 2)) / Z + 'px'; pop.style.top = (TOP) / Z + 'px'; return; }
  const r = a.getBoundingClientRect();
  if (anchorKind(a) === 'dock') {
    // Above the Dock card, arrow on the bottom edge pointing at the card.
    pop.classList.add('above');
    const room = r.top - 12 - TOP; pop.style.maxHeight = (Math.max(160, room)) / Z + 'px';
    const h = pop.offsetHeight * Z, left = Math.max(M, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - M));
    pop.style.left = (left) / Z + 'px'; pop.style.top = (Math.max(TOP, r.top - 12 - h)) / Z + 'px';
    pop.style.setProperty('--arrow-x', (Math.max(16, Math.min(w - 30, r.left + r.width / 2 - left - 7))) / Z + 'px');
    return;
  }
  // Beside the anchor (left list row, rail icon, stage card): to its right, or inside the card if no room.
  let left = r.right + 12;
  if (left + w > innerWidth - M) { left = Math.max(M, Math.min(r.left + 12, innerWidth - w - M)); pop.classList.add('noarrow'); }
  const h = pop.offsetHeight * Z, top = Math.max(TOP, Math.min(r.top - 20, innerHeight - h - 12));
  pop.style.left = (left) / Z + 'px'; pop.style.top = (top) / Z + 'px';
  pop.style.setProperty('--arrow', (Math.max(14, Math.min(h - 28, r.top + r.height / 2 - top - 7))) / Z + 'px');
}
let popRO = null;
function openPop(anchor, opts = {}) {
  if (anchor && anchor !== true && !visible(anchor)) anchor = null;
  if (anchor && anchor !== true) popKind = anchorKind(anchor); else { popKind = 'row'; anchor = document.querySelector(`#roles .rrow[data-i="${selIdx}"]`); }
  if (!opts.skipScroll && !opts.fromAdd && popKind === 'row' && anchor && visible(anchor)) anchor.scrollIntoView({ block: 'nearest' });
  popOpen = true; renderPop(); $('pop').classList.add('show');
  if (popRO) popRO.disconnect(); popRO = new ResizeObserver(() => positionPop()); popRO.observe($('pop')); if (anchor) popRO.observe(anchor);
  requestAnimationFrame(positionPop);
}
function closePop() { if (!popOpen) return; popOpen = false; $('pop').classList.remove('show'); if (popRO) { popRO.disconnect(); popRO = null; } }
function renderPop() {
  const box = $('popIn'); box.innerHTML = '';
  if (status.running) {
    const r = rosterRole(selIdx); if (!r) return closePop();
    const sess = (status.roles || []).find(x => x.name === r.name);
    const cfgI = roles.findIndex(x => x.name === r.name);
    if (cfgI >= 0 && (!sess || (sess.stopped && r.type !== 'observer'))) { renderRoleEditor(roles[cfgI], cfgI, box, true); requestAnimationFrame(positionPop); return; }
    const rows = [[t('Type'), r.type === 'observer' ? t('Archive') : t('Agent')]];
    if (r.type !== 'observer') rows.push([t('CLI'), r.label || r.adapter], [t('Delivery'), r.delivery === 'after_turn' ? t('After turn') : t('Immediate')], [t('Status'), stateText(r.state)], ['PID', r.pid || '—'], [t('Account'), acct.supported[r.adapter] ? (r.account || t('Default')) : '—'], [t('Working folder'), r.cwd || '—'], [t('Opening briefing'), runBriefText(r)], [t("This role's duty"), ((roles.find(x => x.name === r.name) || {}).duty || r.duty || '—')], [t('Final command'), [r.file || '', ...(r.args || [])].join(' ')]);
    box.append(el('div', { class: 'label' }, el('span', {}, `${r.name} · ${t('Role settings')}`)), el('div', { class: 'group' }, rows.map(([a, b]) => el('div', { class: 'row' }, el('span', {}, a), el('span', { class: 'v', title: String(b) }, b)))),
      el('div', { class: 'foot' }, t('Settings are read-only while the bridge runs.')),
      el('div', { style: 'margin-top:12px;display:flex;justify-content:space-between;align-items:center;gap:12px' }, el('button', { class: 'link red', onclick: async () => { if (!confirm(`${t('Stop and remove this role?')} ${r.name}`)) return; if (r.type !== 'observer' && !r.stopped) await stopRole(r.name, { ask: false }); removeRoleByName(r.name); } }, t('Stop & remove')),
        el('span', { style: 'flex:1' }), r.type !== 'observer' && !r.stopped ? el('button', { class: 'link', type: 'button', onclick: () => rebriefRole(r.name) }, t('Resend briefing')) : '', el('button', { class: 'btn sm', onclick: closePop }, t('Done'))));
    requestAnimationFrame(positionPop); return;
  }
  const r = roles[selIdx]; if (!r) return closePop();
  renderRoleEditor(r, selIdx, box, false);
  requestAnimationFrame(positionPop);
}
// One full role form for both states. Stopped: edit the roster. Running: edit a not-yet-started
// roster role, with an extra "Save & start" (hot-add via startRole -> /api/add-role with all params).
function renderRoleEditor(r, i, box, running) {
  const name = el('input', { type: 'text', class: 'field mono', style: 'flex:none;width:170px', value: r.name, ...(running && (status.roles || []).some(x => x.name === r.name) ? { disabled: '' } : {}), placeholder: 'ROLE_NAME', oninput: e => { r.name = e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''); e.target.value = r.name; renderRoles(); renderPlaceholders(); box.querySelector('.ttl').textContent = `${r.name || '—'} · ${t('Role settings')}`; } });
  const typeSeg = seg([['agent', t('Agent')], ['observer', t('Archive')]], r.type, v => { r.type = v; if (v === 'observer') r.delivery = 'archive_only'; else if (r.delivery === 'archive_only') r.delivery = 'immediate'; renderRoles(); renderPop(); renderPlaceholders(); });
  const en = el('button', { class: 'switch sm' + (r.enabled ? ' on' : ''), onclick: () => { r.enabled = !r.enabled; sw(en, r.enabled); renderRoles(); renderPlaceholders(); } });
  box.append(el('div', { class: 'label' }, el('span', { class: 'ttl' }, `${r.name || '—'} · ${t('Role settings')}`)),
    el('div', { class: 'group' },
      el('div', { class: 'row' }, el('span', {}, t('Name')), name),
      el('div', { class: 'row' }, el('span', {}, t('Enabled')), en),
      el('div', { class: 'row' }, el('span', {}, t('Type')), typeSeg)));
  if (r.type === 'observer') box.append(el('div', { class: 'foot' }, t('Archived to inbox; its messages wait for the target turn end')));
  else {
    const cli = el('select', { class: 'field-sel', onchange: e => { r.adapter = e.target.value; renderRoles(); renderPlaceholders(); renderPop(); } });
    for (const a of adapters.filter(a => a.path || a.id === r.adapter)) cli.append(el('option', { value: a.id, ...(a.id === r.adapter ? { selected: '' } : {}) }, `${a.label}${a.path ? '' : ' ' + t('(not found)')}`));
    // Opening briefing = global dispatch briefing + duty + extra notes; sent only for a new conversation.
    let resumes = null; // from /api/preview-args (final argv); null until the first preview
    const bstate = el('span', { class: 'bstate' });
    const drawState = () => { const k = cardBriefState(r, resumes); bstate.className = 'bstate ' + k; bstate.textContent = t(BSTATE_TEXT[k]); };
    const bsw = el('button', { class: 'switch sm' + (r.briefOn !== false ? ' on' : ''), type: 'button', onclick: () => { r.briefOn = r.briefOn === false; sw(bsw, r.briefOn); saveRoster(); drawState(); } });
    const duty = el('textarea', { class: 'duty-in', rows: '2', placeholder: t('e.g. writes the code and tests it, then hands it to REVIEWER'), oninput: e => { r.duty = e.target.value; saveRoster(); drawState(); } }); duty.value = r.duty || '';
    const ta = el('textarea', { class: 'briefing', placeholder: t('Only for this role, appended after the global briefing. Same placeholders.'), oninput: e => { r.briefing = e.target.value; saveRoster(); drawState(); } }); ta.value = r.briefing || '';
    drawState();
    box.append(el('div', { class: 'label' }, t('CLI & launch')),
      el('div', { class: 'group' },
        el('div', { class: 'row' }, el('span', {}, t('CLI')), cli),
        accountRow(r, renderPop),
        el('div', { class: 'row' }, el('span', {}, t('Delivery')), seg([['immediate', t('Immediate')], ['after_turn', t('After turn')]], r.delivery, v => { r.delivery = v; renderRoles(); renderPlaceholders(); })),
        el('div', { class: 'row stack' }, el('span', {}, t('Working folder')), folderField({ value: r.cwd, placeholder: t('workspace'), onchange: v => r.cwd = v }))),
      ...launchOptions(r, p => { resumes = !!p.resumes; drawState(); }),
      el('div', { class: 'label' }, el('span', {}, t('Opening briefing')), el('button', { class: 'link', type: 'button', onclick: () => openGb(r.name) }, t('Edit global dispatch briefing ›'))),
      el('div', { class: 'group' },
        el('div', { class: 'row' }, el('div', { class: 'opttext' }, el('div', {}, t('Send opening briefing')), el('div', { class: 'hint' }, t('Only when this role starts a new conversation: sent once when it is first idle, before any message.'))), bsw),
        el('div', { class: 'row stack' }, el('span', {}, t("This role's duty")), duty),
        el('div', { class: 'rc-hint' }, t("Opening briefing = global dispatch briefing + this role's duty. The duty also shows in the other roles' role list.")),
        el('div', { class: 'row' }, el('span', {}, t('At this start')), bstate),
        el('details', { class: 'more', style: 'margin:0', ...(r.briefing ? { open: '' } : {}) }, el('summary', { class: 'row' }, el('span', {}, t('Extra notes (optional)')), el('span', { class: 'chev' }, '›')), el('div', {}, el('div', { class: 'row stack' }, ta))),
        el('div', { class: 'row' }, el('span', {}, t('Preview the full text this role receives')), el('button', { class: 'link', type: 'button', onclick: () => openGb(r.name) }, t('Preview ›')))));
  }
  box.append(roleEditorFoot(r, i, running));
}
// While running: stopped sessions the user removed from the roster stay hidden.
const hiddenRoles = new Set();

// ---------- global dispatch briefing (全局调度说明) ----------
let gbCustom = null; // null = the default template (follows the UI language)
const bdef = { stateDir: '.tmp/cli_conductor', sendScript: 'tools/cli_conductor_send.ps1', tag: 'CLIConductor' }; // from /api/defaults
const gbText = () => gbCustom === null ? briefingTemplate() : gbCustom;
const BSTATE_TEXT = { send: 'Will be sent at this start', resume: 'Continuing a conversation, not sent', off: 'Off', empty: 'Nothing to send', old: 'The server is an older version. Restart npm start.' };
const RUN_BSTATE_TEXT = { sent: 'Sent', pending: 'Waiting to send (when idle)', resume: 'Continuing a conversation, not sent this run', off: 'Off' };
const runBriefText = r => t(RUN_BSTATE_TEXT[r.briefingState] || (r.briefing ? 'On' : 'Off'));
// /briefing.js comes from the server; an older server (not restarted yet) does not serve it.
const OLD_SERVER = 'The server is an older version. Restart npm start.';
const hasBriefing = () => typeof Briefing === 'object' && !!Briefing && typeof Briefing.composeBriefing === 'function';
const escHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// Old configs: switch defaults on, no duty; a role holding an untouched copy of the old per-role template drops it
// (the global briefing now carries that text).
function migrateBriefing(list) {
  const legacy = Object.values(typeof LEGACY_BRIEFING_TEMPLATES === 'object' ? LEGACY_BRIEFING_TEMPLATES : {}).map(x => x.trim());
  for (const r of list || []) { if (r.briefOn === undefined) r.briefOn = true; if (r.duty === undefined) r.duty = ''; if (r.briefing && legacy.includes(String(r.briefing).trim())) r.briefing = ''; }
  return list;
}
function briefPaths() {
  const ws = (status.running && status.bridge && status.bridge.workspace) || wsValue.trim() || '<workspace>';
  const sep = ws.includes('/') && !ws.includes('\\') ? '/' : '\\';
  const sd = ws.replace(/[\\/]+$/, '') + sep + bdef.stateDir.replace(/[\\/]+/g, sep);
  return { workspace: ws, send: `pwsh -File "${bdef.sendScript}" -ConfigPath "${sd}${sep}app.config.json"`, briefingFile: `${sd}${sep}BRIEFING.md` };
}
function briefRoles() {
  const src = status.running ? (status.roles || []).filter(r => !r.stopped) : roles.filter(r => r.enabled);
  return src.map(r => ({ name: r.name, type: r.type, duty: (roles.find(x => x.name === r.name) || r).duty || '' }));
}
const briefCtxUI = global => ({ global: global === undefined ? gbText() : global, lang: LANG, ...briefPaths(), roles: briefRoles() });
function cardBriefState(r, resumes) {
  if (r.briefOn === false) return 'off';
  if (!hasBriefing()) return 'old';
  if (!Briefing.composeBriefing(briefCtxUI(), { name: r.name, duty: r.duty, extra: r.briefing })) return 'empty';
  if (resumes === null) resumes = !!(r.options && (r.options.resume === 'last' || (r.options.resume === 'id' && String(r.options.resumeId || '').trim())));
  return resumes ? 'resume' : 'send';
}
function previewHtml(name, global) {
  if (!hasBriefing()) return escHtml(t(OLD_SERVER));
  const cfg = roles.find(x => x.name === name) || {};
  const raw = Briefing.composeBriefing(briefCtxUI(global), { name, duty: cfg.duty, extra: cfg.briefing }, (k, v) => `\u0001${k}\u0002${v}\u0003`);
  return escHtml(raw).replace(/\u0001(\w+)\u0002([^\u0003]*)\u0003/g, (m, k, v) => `<mark class="${k === 'duty' ? 'duty' : ''}">${v}</mark>`);
}
function renderGbRow() {
  const b = $('gbBadge'); if (!b) return;
  const on = !!gbText().trim();
  b.textContent = t(on ? (gbCustom === null ? '● On' : '● On · customized') : '○ Empty'); b.classList.toggle('empty', !on);
}
function openGb(pick) {
  const sh = $('gbSheet'), box = $('gbIn'); box.innerHTML = '';
  const ta = el('textarea', { class: 'gb-ta', spellcheck: 'false' }); ta.value = gbText();
  const agents = briefRoles().filter(r => r.type !== 'observer' && r.name);
  if (pick && !agents.some(r => r.name === pick)) { const c = roles.find(x => x.name === pick); if (c) agents.push({ name: c.name, type: c.type, duty: c.duty || '' }); }
  let cur = pick && agents.some(r => r.name === pick) ? pick : (agents[0] || {}).name;
  const prev = el('div', { class: 'gb-prev' });
  const draw = () => { prev.innerHTML = cur ? previewHtml(cur, ta.value) : escHtml(t('Add a role to preview.')); };
  ta.addEventListener('input', () => { clearTimeout(draw.t); draw.t = setTimeout(draw, 120); });
  const insert = k => { ta.focus(); ta.setRangeText(`{${k}}`, ta.selectionStart, ta.selectionEnd, 'end'); draw(); };
  const chips = el('div', { class: 'gb-chips' }, el('span', { class: 'lbl' }, t('Placeholders (click to insert):')),
    (hasBriefing() ? Briefing.KEYS : ['role', 'duty', 'peers', 'workspace', 'send', 'briefingFile']).map(k => el('button', { class: 'chip' + (k === 'duty' || k === 'briefingFile' ? ' new' : ''), type: 'button', onclick: () => insert(k) }, `{${k}}`)));
  const close = () => sh.classList.remove('show');
  const save = () => { gbCustom = ta.value === briefingTemplate() ? null : ta.value; saveRoster(); renderGbRow(); if (popOpen) renderPop(); close(); toast(t('Global dispatch briefing saved')); };
  const reset = () => { if (ta.value.trim() && ta.value !== briefingTemplate() && !confirm(t('Replace the text with the default template?'))) return; ta.value = briefingTemplate(); draw(); };
  const file = briefPaths().briefingFile;
  box.append(el('h2', {}, el('span', {}, t('Global dispatch briefing')), el('span', { class: 'gb-acts' }, el('button', { class: 'link', type: 'button', onclick: reset }, t('Restore default')), el('button', { class: 'link', type: 'button', onclick: close }, t('Cancel')), el('button', { class: 'btn sm', type: 'button', onclick: save }, t('Save')))),
    el('div', { class: 'gb-cols' },
      el('div', {}, el('div', { class: 'group' }, chips, el('div', { class: 'row stack' }, ta)),
        el('div', { class: 'group', style: 'margin-top:10px' }, el('div', { class: 'gb-note' }, 'ⓘ', el('div', {}, el('b', {}, t('Applies to all roles. At start it is also written to {file}, so roles can reread it.').replace('{file}', file)), el('br'),
          t('What a role receives = this text + the duty from its role card (filled in at {duty}). Only roles that start a new conversation get it; roles continuing a conversation, or with the switch off, do not.'),
          status.running ? el('br') : '', status.running ? t('Changes apply to roles that start or join later. For a running role use Resend briefing.') : '')))),
      el('div', {}, el('div', { class: 'label', style: 'margin-top:0' }, el('span', {}, t('Preview')), agents.length ? seg(agents.map(r => [r.name, r.name]), cur, v => { cur = v; draw(); }) : ''), prev,
        el('div', { class: 'foot' }, t("Blue = filled placeholder, green = this role's duty (from its role card).")))));
  draw(); sh.classList.add('show'); setTimeout(() => ta.focus(), 50);
}
function saveRoster() { try { localStorage.tbLast = JSON.stringify(launchConfig()); } catch { } }
function removeRoleByName(name) {
  const k = roles.findIndex(x => x.name === name); if (k >= 0) roles.splice(k, 1);
  if (status.running && (status.roles || []).some(x => x.name === name)) hiddenRoles.add(name);
  selIdx = Math.max(0, Math.min(selIdx, rosterList().length - 1));
  closePop(); saveRoster(); renderRoles(); renderPlaceholders();
  if (status.running && typeof renderDock === 'function') renderDock();
}
function roleEditorFoot(r, i, running) {
  const del = el('button', { class: 'link red', onclick: () => { if (!confirm(`${t('Remove Role')} ${r.name}?`)) return; if (running) removeRoleByName(r.name); else { roles.splice(i, 1); selIdx = Math.max(0, Math.min(selIdx, roles.length - 1)); closePop(); saveRoster(); renderRoles(); renderPlaceholders(); } } }, t('Remove Role'));
  const right = running
    ? el('div', { style: 'display:flex;gap:8px' },
      el('button', { class: 'btn sm', onclick: () => { saveRoster(); closePop(); renderRoles(); toast(`${t('Saved')} ${r.name}`); } }, t('Save')),
      el('button', { class: 'btn sm primary', onclick: async (e) => {
        const btn = e.currentTarget; if (btn.disabled) return;
        const n = String(r.name || '').trim(); if (!n) return toast(t('Enter a role name'));
        if (r.type !== 'observer' && !r.adapter) return toast(t('Pick a CLI'));
        btn.disabled = true;
        try { hiddenRoles.delete(n); saveRoster(); closePop(); await startRole(n); }
        catch (err) { toast(err.message || String(err)); }
      } }, t('Save & start')))
    : el('button', { class: 'btn sm', onclick: closePop }, t('Done'));
  return el('div', { style: 'margin-top:12px;display:flex;justify-content:space-between;align-items:center' }, del, right);
}

// ---------- per-CLI launch options (lib/cliflags.js capabilities) ----------
let cliCaps = {};
const PERM_LABEL = { readonly: 'Read-only', edit: 'Auto-edit files', auto: 'Full auto' };
// Unified label plus the CLI's own name for it, dimmed: 全自动（auto） / Full auto (auto).
// Label of the highest effort tier: decorative aurora blobs + 5 meteors behind the text (styled in app.css).
const effortTopLabel = label => [
  el('span', { class: 'fx-aur', 'aria-hidden': 'true' }, el('i', { class: 'fx-a1' }), el('i', { class: 'fx-a2' }), el('i', { class: 'fx-a3' })),
  el('span', { class: 'fx-met', 'aria-hidden': 'true' }, [1, 2, 3, 4, 5].map(n => el('i', { class: 'fx-m' + n }))),
  el('span', { class: 'fx-lbl' }, label)];
const withNative = (label, nat) => nat ? el('span', {}, label, el('span', { class: 'native' }, LANG === 'zh' ? `（${nat}）` : ` (${nat})`)) : label;
function optRow(title, hint, control, stack) {
  return el('div', { class: 'row orow' + (stack ? ' stack' : '') }, el('div', { class: 'opttext' }, el('div', {}, typeof title === 'string' ? t(title) : title), el('div', { class: 'hint' }, t(hint))), control);
}
function launchOptions(r, onPreview) {
  const caps = cliCaps[r.adapter];
  const o = r.options = Object.assign({ model: '', effort: '', resume: 'off', resumeId: '', perm: '', skipAll: false, addDirs: [] }, r.options || {});
  const out = [];
  const preview = el('div', { class: 'cmdprev mono-in' }, '…');
  const upd = () => { clearTimeout(upd.t); upd.t = setTimeout(async () => {
    try { const p = await api('POST', '/api/preview-args', { adapter: r.adapter, options: o, args: r.args }); preview.textContent = [p.command, ...p.args.map(a => /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)].join(' '); preview.classList.remove('err'); if (onPreview) onPreview(p); }
    catch (e) { preview.textContent = e.message; preview.classList.add('err'); }
  }, 120); };
  const rows = [];
  if (caps) {
    // Saved choices this CLI doesn't offer fall back to Default (buildArgs ignores them too).
    if (o.perm && !(caps.perm || []).includes(o.perm)) o.perm = '';
    if (o.skipAll && !caps.skipAll) o.skipAll = false;
    if (o.effort && !(caps.effort ? caps.effort.values : []).includes(o.effort)) o.effort = '';
    if (caps.model) {
      const vals = caps.model.values || [];
      const custom = el('input', { type: 'text', class: 'field mono', style: 'width:100%', placeholder: caps.model.placeholder || t('model name'), value: o.model, oninput: e => { o.model = e.target.value.trim(); upd(); } });
      const known = vals.includes(o.model);
      const sel = el('select', { class: 'field-sel', onchange: e => { const v = e.target.value; custom.classList.toggle('hidden', v !== '__custom'); if (v !== '__custom') { o.model = v; custom.value = v; } else { custom.focus(); } upd(); } },
        el('option', { value: '' }, t('Default')), vals.map(v => el('option', { value: v, ...(o.model === v ? { selected: '' } : {}) }, v)), el('option', { value: '__custom', ...(!known && o.model ? { selected: '' } : {}) }, t('Custom…')));
      custom.classList.toggle('hidden', known || !o.model);
      if (!vals.length) { sel.classList.add('hidden'); custom.classList.remove('hidden'); }
      rows.push(optRow('Model', 'Which model this CLI uses. Leave on default to use its own setting.', el('div', { class: 'ctl' }, sel, custom), true));
    }
    if (caps.effort) {
      // Highest tier (last value) gets the aurora + meteor effect (app.css .effort-top); on/off-style lists don't.
      const ev = caps.effort.values, top = ev.length > 2 && !['off', 'on', 'none'].includes(ev[ev.length - 1]) ? ev[ev.length - 1] : null;
      const es = seg([['', t('Default')], ...ev.map(v => [v, v === top ? effortTopLabel(t(v)) : t(v)])], o.effort, v => { o.effort = v; upd(); });
      if (top) es.lastChild.classList.add('effort-top');
      rows.push(optRow('Thinking effort', 'How hard the model thinks before answering. Higher is slower but more careful.', es, ev.length > 3));
    }
    if (caps.resume) {
      const opts = [['off', t('Off')]]; if (caps.resume.last) opts.push(['last', t('Most recent')]); if (caps.resume.id) opts.push(['id', t('By ID')]);
      if (!opts.some(x => x[0] === o.resume)) o.resume = 'off';
      const idIn = el('input', { type: 'text', class: 'field mono', style: 'width:100%', placeholder: caps.resume.idHint === 'index' ? t('session index (e.g. 3)') : t('session ID'), value: o.resumeId, oninput: e => { o.resumeId = e.target.value.trim(); upd(); } });
      idIn.classList.toggle('hidden', o.resume !== 'id');
      rows.push(optRow('Continue conversation', 'Pick up an earlier session instead of starting fresh. An empty ID sends nothing, so no picker opens.', el('div', { class: 'ctl' }, seg(opts, o.resume, v => { o.resume = v; idIn.classList.toggle('hidden', v !== 'id'); if (v === 'id') idIn.focus(); upd(); }), idIn), true));
    }
    if (caps.perm) rows.push(optRow('Permission level', 'What the CLI may do without asking you.', seg([['', t('Default')], ...caps.perm.map(k => [k, withNative(t(PERM_LABEL[k]), (caps.permNative || {})[k])])], o.perm, v => { o.perm = v; upd(); }), caps.perm.length > 1));
    if (caps.skipAll) {
      const swb = el('button', { class: 'switch sm danger' + (o.skipAll ? ' on' : ''), onclick: () => { if (!o.skipAll && !confirm(t('Skip ALL confirmations? The CLI will run commands and edit files without asking. Use only in an isolated environment.'))) return; o.skipAll = !o.skipAll; sw(swb, o.skipAll); upd(); } });
      rows.push(optRow(withNative(t('Skip all confirmations'), caps.skipAllNative), 'Dangerous: never asks before running commands or editing files.', swb));
    }
    if (caps.addDir) {
      const list = el('div', { class: 'dirs' });
      const draw = () => { list.innerHTML = ''; o.addDirs.forEach((d, i) => list.append(el('div', { class: 'dirrow' }, folderField({ value: d, placeholder: 'D:\\path', recent: false, onchange: v => { o.addDirs[i] = v; upd(); } }), el('button', { class: 'ibtn danger', title: t('Remove'), onclick: () => { o.addDirs.splice(i, 1); draw(); upd(); } }, '−')))); list.append(el('button', { class: 'link', onclick: () => { o.addDirs.push(''); draw(); } }, t('＋ Add folder'))); };
      draw();
      rows.push(optRow('Extra folders', 'Let the CLI read and write folders outside its working folder.', list, true));
    }
  }
  out.push(el('div', { class: 'label' }, t('Launch options')));
  if (rows.length) out.push(el('div', { class: 'group' }, rows));
  else out.push(el('div', { class: 'foot' }, caps === undefined && !Object.keys(cliCaps).length ? t('The server is an older version. Restart npm start.') : t('This CLI has no switchable options here; use Advanced.')));
  const raw = el('input', { type: 'text', class: 'field mono', style: 'width:100%', value: r.args || '', placeholder: t('extra arguments, appended last'), oninput: e => { r.args = e.target.value; upd(); } });
  out.push(el('details', { class: 'group more adv', ...(r.args ? { open: '' } : {}) }, el('summary', { class: 'row' }, el('span', {}, t('Advanced')), el('span', { class: 'chev' }, '›')),
    el('div', {}, el('div', { class: 'row stack' }, el('div', { class: 'opttext' }, el('div', {}, t('Raw arguments')), el('div', { class: 'hint' }, t('Appended after the options above.'))), raw))));
  out.push(el('div', { class: 'label' }, t('Final command')), el('div', { class: 'group' }, el('div', { class: 'row' }, preview)));
  upd();
  return out;
}

// ---------- CLIs ----------
function cliRow(a, mode) {
  const hidden = mode === 'hidden';
  return el('div', { class: 'row clirow' },
    el('span', { class: 'dot ' + (a.path ? 'idle' : 'offline') }),
    el('div', { class: 'clitext' }, el('div', { class: 'cliname' }, el('span', { class: 'nm' }, a.label), a.custom ? el('span', { class: 'tag' }, t('Manual')) : ''), el('div', { class: 'v', title: a.path || '' }, a.path || `${t('not found')} (${(a.commands || []).join(', ')})`)),
    el('div', { class: 'cliact' },
      mode === 'detected' && !status.running ? el('button', { class: 'ibtn add', title: t('Add Role'), 'aria-label': t('Add Role'), onclick: () => addRole(a.id) }, '+') : '',
      a.custom ? el('button', { class: 'ibtn danger', title: t('Remove'), 'aria-label': t('Remove'), onclick: async () => { adapters = await api('DELETE', '/api/adapters', { id: a.id }); if (ui.hiddenAdapters.includes(a.id)) await uiPatch({ unhide: a.id }); renderAdapters(); } }, '−') : '',
      hidden ? el('button', { class: 'ibtn', title: t('Show'), 'aria-label': t('Show'), onclick: async () => { await uiPatch({ unhide: a.id }); renderAdapters(); } }, '↺')
        : el('button', { class: 'ibtn', title: t('Hide'), 'aria-label': t('Hide'), onclick: async () => { await uiPatch({ hide: a.id }); renderAdapters(); } }, '⊘')));
}
function renderAdapters() {
  const hid = new Set(ui.hiddenAdapters);
  const det = adapters.filter(a => a.path && !hid.has(a.id)), other = adapters.filter(a => !a.path && !hid.has(a.id)), hidden = adapters.filter(a => hid.has(a.id));
  const box = $('adapters'); box.innerHTML = '';
  for (const a of det) box.append(cliRow(a, 'detected'));
  if (!det.length) box.append(el('div', { class: 'row' }, el('span', { class: 'v' }, t('No CLI detected on PATH'))));
  $('otherTitle').textContent = `${t('Other supported CLIs')} (${other.length})`; $('otherList').innerHTML = ''; for (const a of other) $('otherList').append(cliRow(a, 'other'));
  $('otherClis').classList.toggle('hidden', !other.length);
  $('hiddenTitle').textContent = `${t('Hidden')} ${hidden.length}`; $('hiddenList').innerHTML = ''; for (const a of hidden) $('hiddenList').append(cliRow(a, 'hidden'));
  $('hiddenClis').classList.toggle('hidden', !hidden.length);
  renderAccounts();
}
function addRole(adapterId) {
  const base = adapterId ? adapterId.toUpperCase().replace(/[^A-Z0-9_]/g, '_') : 'AGENT';
  let n = roles.length + 1, name = `${base}_${n}`; while (roles.some(r => r.name === name) || (status.roles || []).some(r => r.name === name)) name = `${base}_${++n}`;
  roles.push({ enabled: true, name, type: 'agent', adapter: adapterId || (adapters.find(a => a.path) || adapters[0] || {}).id, delivery: 'immediate', cwd: '', args: '', briefing: '', briefOn: true, duty: '', account: '', options: {} });
  saveRoster();
  const i = status.running ? Math.max(0, rosterList().findIndex(r => r.name === name)) : roles.length - 1;
  selIdx = i;
  renderRoles();
  renderPlaceholders();
  if (!status.running) {
    const r = roles[i];
    if (r && r.enabled && r.type !== 'observer') preSwap(r);
  }
  openPop(document.querySelector(`#roles .rrow[data-i="${i}"]`), { fromAdd: true });
  requestAnimationFrame(() => { const inp = $('popIn') && $('popIn').querySelector('input.field.mono'); if (inp) { inp.focus(); inp.select(); } });
}
let idleMs = 3000;
function renderIdle() { seg([[2000, '2 s'], [3000, '3 s'], [5000, '5 s']], idleMs, v => idleMs = Number(v), $('optIdle')); }
function launchConfig() { return { workspace: wsValue.trim(), roles: JSON.parse(JSON.stringify(roles)), waitTurnEnd: sw($('optWait')), idleMs, globalBriefing: gbCustom }; }
function applyConfig(c) { wsValue = c.workspace || ''; roles = migrateBriefing(c.roles || roles); gbCustom = typeof c.globalBriefing === 'string' ? c.globalBriefing : null; renderGbRow(); selIdx = 0; sw($('optWait'), c.waitTurnEnd); idleMs = Number(c.idleMs || 3000); renderWorkspace(); renderIdle(); renderRoles(); renderPlaceholders(); if (popOpen) renderPop(); localStorage.tbLast = JSON.stringify(c); }
async function loadPresets() { const p = await api('GET', '/api/presets'); const s = $('presetSel'); s.innerHTML = `<option value="">${t('Choose a preset...')}</option>`; for (const k of Object.keys(p)) s.append(el('option', { value: k }, k)); loadPresets.data = p; }

// ---------- center ----------
// Before start: the same stage (max 2 side by side) + Dock as running mode, with placeholder cards.
let preStage = [], preLast = new Map();
const preAgents = () => roles.filter(r => r.enabled && r.type !== 'observer');
const cmdLine = r => `$ ${((adapters.find(a => a.id === r.adapter) || {}).commands || [r.adapter])[0] || ''} ${r.args || ''}`.trim();
function renderPlaceholders() {
  if (status.running) return;
  $('terms').classList.add('hidden'); $('stage').classList.remove('hidden'); $('dock').classList.remove('hidden');
  const list = preAgents();
  preStage = preStage.filter(r => list.includes(r));
  const lim = Math.min(maxSlots, list.length);
  while (preStage.length > lim) preStage.splice(preStage.indexOf(preStage.slice().sort((a, b) => (preLast.get(a) || 0) - (preLast.get(b) || 0))[0]), 1);
  for (const r of list) if (preStage.length < lim && !preStage.includes(r)) preStage.push(r);
  const st = $('stage'); st.innerHTML = ''; st.classList.remove('focus');
  preStage.forEach((r, slot) => { const i = roles.indexOf(r); st.append(el('div', { class: 'term placeholder' + (i === selIdx ? ' sel' : ''), 'data-slot': slot, 'data-i': i, onclick: e => select(i, popOpen ? e.currentTarget : undefined) },
    el('div', { class: 'tbar' }, el('div', { class: 't' }, el('span', { class: 'dot offline' }), r.name || '—', el('span', { class: 's' }, `${adapterLabel(r.adapter)}${r.account ? ' · ' + r.account : ''} · ${t('Not running')}`))),
    el('div', { class: 'tbody' }, el('div', { class: 'big' }, cmdLine(r)), el('div', {}, t('Press Start Conductor to launch this CLI here.'))))); });
  if (!list.length) st.append(el('div', { class: 'term placeholder' }, el('div', { class: 'tbody' }, t('Enable at least two roles in the sidebar.'))));
  st.classList.toggle('one', st.children.length === 1);
  renderPreDock(); updatePill();
}
function renderPreDock() {
  const box = $('dock'); flipChildren(box, () => buildPreDock(box));
}
function buildPreDock(box) {
  box.innerHTML = ''; box.dataset.mode = 'pre'; dockCards = {};
  box.append(el('div', { class: 'dlabel' }, t('Role Dock')));
  const en = roles.filter(r => r.enabled), on = preStage.filter(r => en.includes(r)), rest = en.filter(r => !on.includes(r));
  [...on, null, ...rest].forEach(r => {
    if (r === null) { if (on.length && rest.length) box.append(el('div', { class: 'dsep' })); return; }
    const i = roles.indexOf(r), k = on.indexOf(r);
    const arch = r.type === 'observer', isOn = k >= 0;
    const c = el('div', { class: 'dc' + (arch ? ' arch' : '') + (isOn ? ' onstage' : '') + (i === selIdx ? ' cur' : ''), draggable: arch ? 'false' : 'true', 'data-onstage': t('On stage'), 'data-i': i,
      onclick: e => { const c = e.currentTarget; if (arch) return select(i, c); if (popOpen && selIdx === i) return closePop(); const was = popOpen; preSwap(r); if (was) { selIdx = i; openPop(document.querySelector(`#dock .dc[data-i="${i}"]`)); } }, ondragstart: e => { e.dataTransfer.setData('text/tb-pre', String(i)); document.body.classList.add('dragging'); }, ondragend: () => document.body.classList.remove('dragging') },
      el('div', { class: 'n' }, el('span', { class: 'slotb' }, k >= 0 ? SLOT_MARK[k] : ''), el('span', { class: 'dot ' + (arch ? 'archive' : 'offline') }), el('b', {}, r.name || '—'), el('em', {}, arch ? t('archive only') : `${adapterLabel(r.adapter)} · ${r.delivery === 'after_turn' ? t('after turn') : t('immediate')}`)),
      el('div', { class: 'l' }, arch ? t('archive · inbox only') : cmdLine(r)), el('div', { class: 'key' }, i < 9 && !arch ? `Ctrl+${i + 1}` : ''));
    box.append(c);
  });
  box.append(el('div', { class: 'slotpill', id: 'slotPill' }));
}
// Same rule as running mode: replace the less recently focused stage card.
function preSwap(r, slot) {
  const i = roles.indexOf(r); if (i < 0 || r.type === 'observer') return;
  preLast.set(r, Date.now());
  if (!preStage.includes(r)) {
    // Target: the selected stage card's slot (replace in place), else the least recently focused.
    const selOn = preStage.indexOf(roles[selIdx]);
    if (slot == null) slot = preStage.length < Math.min(maxSlots, preAgents().length) ? preStage.length : selOn >= 0 ? selOn : preStage.indexOf(preStage.slice().sort((a, b) => (preLast.get(a) || 0) - (preLast.get(b) || 0))[0]);
    const from = document.querySelector(`#dock .dc[data-i="${i}"]`), outR = preStage[slot], outCard = $('stage').children[slot];
    const ghost = !reduced() && outR && outCard ? makeGhost(outCard) : null;
    preStage[slot] = r; selIdx = i; renderRoles(); renderPlaceholders(); if (popOpen) renderPop();
    const card = $('stage').children[slot];
    if (!reduced()) { if (from) expandFrom(card, document.querySelector(`#dock .dc[data-i="${i}"]`)); if (ghost) flyGhost(ghost, document.querySelector(`#dock .dc[data-i="${roles.indexOf(outR)}"]`)); }
  } else if (slot != null && preStage.indexOf(r) !== slot) { const j = preStage.indexOf(r); [preStage[j], preStage[slot]] = [preStage[slot], preStage[j]]; renderPlaceholders(); }
  else { selIdx = i; renderRoles(); renderPlaceholders(); }
}
function highlightTerm() {
  if (!status.running) { renderPlaceholders(); return; }
  const n = ((status.running ? rosterRole(selIdx) : status.roles[selIdx]) || {}).name;
  for (const [k, v] of Object.entries(terms)) v.card.classList.toggle('sel', k === n);
}

// ---------- dashboard ----------
function fmtTime(ts) { try { return new Date(ts).toLocaleTimeString([], { hour12: false }); } catch { return ''; } }
function eventText(e) {
  const route = e.from && e.to ? `${e.from} → ${e.to}` : (e.from || e.to || '');
  const d = e.detail || {};
  const extra = (e.kind === 'BRIEFING_SKIPPED' ? t(d.reason === 'resume' ? 'continuing a conversation' : 'switched off') : '') || (d.reason && t(d.reason)) || (d.manual ? t('manual') : '') || d.prompt || (e.kind === 'TURN_END' ? `${t('turn')} ${d.turns}` : '') || (e.kind === 'ROLE_STARTED' ? `pid ${d.pid}` : '');
  return [route, extra].filter(Boolean).join(' · ');
}
function renderFeed() {
  const box = $('feed'); box.innerHTML = '';
  const shown = events.filter(e => e.kind !== 'UNCERTAIN').slice(-80).reverse();
  if (!shown.length) box.append(el('div', { class: 'row' }, el('span', { class: 'v' }, t('No activity yet'))));
  for (const e of shown) box.append(el('div', { class: 'row' }, el('div', { class: 'ev' }, el('span', { class: 'time' }, fmtTime(e.ts)), el('span', { class: 'tag2 ' + e.kind }, t(e.kind.replace(/_/g, ' ').toLowerCase())), el('span', { class: 'txt', title: eventText(e) }, eventText(e)))));
}
function setRunningLock(running) {
  for (const e of document.querySelectorAll('.side input, .side select, .side .switch, #btnAddCli, #optIdle button')) {
    if (e.id === 'presetName' || e.id === 'presetSel') continue;
    if (e.classList.contains('role-power')) continue; // per-role start/stop must stay clickable
    e.disabled = running;
  }
}
function renderStatus() {
  const running = status.running;
  for (const id of ['btnStop', 'btnNew', 'pauseWrap', 'runInfo']) $(id).classList.toggle('hidden', !running);
  $('btnStart').classList.toggle('hidden', running);
  if (!running) {
    $('pill').innerHTML = '<span class="dot offline"></span>' + t('Not running');
    for (const n of Object.keys(terms)) { terms[n].card.remove(); terms[n].term.dispose(); delete terms[n]; }
    $('layout').classList.remove('running'); for (const id of ['stage', 'dock']) $(id).classList.add('hidden'); $('terms').classList.remove('hidden'); $('stage').innerHTML = ''; focusName = null; unread = {}; renderDock(); renderPanelRail();
    renderWorkspace(); renderRoles(); renderAdapters(); renderPlaceholders(); renderFeed(); setRunningLock(false); if (popOpen) renderPop(); return;
  }
  const b = status.bridge, roleList = status.roles;
  if (selIdx >= rosterList().length) selIdx = 0; // selIdx indexes rosterList(), not status.roles
  const busy = roleList.filter(r => r.state === 'busy').length;
  $('pill').innerHTML = `<span class="dot ${b.paused ? 'busy' : 'idle'}"></span>${b.paused ? t('Paused') : t('Bridge running')} · ${roleCountText(roleList)} · ${b.counts.held} ${t('held')}${busy ? ` · ${busy} ${t('working')}` : ''} · ${b.waitTurnEnd ? t('wait for turn end: all roles') : t('wait for turn end: per role')}`;
  renderRoles(); renderAdapters(); if (!renderStatus.ws) { renderWorkspace(); renderStatus.ws = 1; }
  sw($('swPause'), b.paused);
  const sl = $('statusList'); sl.innerHTML = '';
  for (const [k, v] of Object.entries(b.counts)) sl.append(el('div', { class: 'stat' }, el('b', {}, v), el('span', {}, LANG === 'zh' && ZH[k] ? ZH[k] : k[0].toUpperCase() + k.slice(1))));
  for (const h of b.held.slice(0, 5)) sl.append(el('div', { class: 'row' }, el('span', { class: 'v' }, `${t('held')} → ${h.to}`), el('span', { class: 'v' }, t(h.reason))));
  const rr = $('roleRun'); rr.innerHTML = '';
  for (const r of roleList) rr.append(el('div', { class: 'row' }, el('div', { class: 'k' }, el('span', { class: 'dot ' + r.state }), r.name), el('span', { class: 'v' }, r.type === 'observer' ? t('inbox only') : `${stateText(r.state)} · PID ${r.pid || '—'} · ${t('turn')} ${r.turns || 0}`)));
  $('cfgInfo').textContent = `${t('Agents reply with')} tools/cli_conductor_send.ps1 -ConfigPath ${b.configPath}`;
  if ($('dock').dataset.mode !== 'run') { $('dock').innerHTML = ''; $('dock').dataset.mode = 'run'; dockCards = {}; $('stage').innerHTML = ''; }
  $('layout').classList.add('running'); $('terms').innerHTML = ''; $('terms').classList.add('hidden'); for (const id of ['stage', 'dock']) $(id).classList.remove('hidden');
  for (const r of roleList) if (r.type !== 'observer') ensureTerm(r); else if (terms[r.name]) { terms[r.name].card.remove(); delete terms[r.name]; }
  for (const n of Object.keys(terms)) if (!roleList.some(r => r.name === n)) { terms[n].card.remove(); terms[n].term.dispose(); delete terms[n]; }
  for (const r of roleList) updateTermBar(r);
  maxSlots = computeSlots(); initStage(); placeStage(); renderSideRail(); renderPanelRail();
  highlightTerm(); setRunningLock(true);
  if (popOpen) renderPop();
  const opts = roleList.map(r => `<option>${r.name}</option>`).join('');
  if ($('sFrom').dataset.roles !== opts) { $('sFrom').innerHTML = opts; $('sTo').innerHTML = opts; $('sFrom').dataset.roles = opts; if (roleList[1]) $('sTo').value = roleList[1].name; }
  renderFeed();
}
function termTheme() { const dark = matchMedia('(prefers-color-scheme: dark)').matches; return dark ? { background: '#121214', foreground: '#e5e5ea', cursor: '#0a84ff', selectionBackground: 'rgba(10,132,255,.35)' } : { background: '#fbfbfd', foreground: '#1d1d1f', cursor: '#007aff', selectionBackground: 'rgba(0,122,255,.25)' }; }
function ensureTerm(r) {
  if (terms[r.name]) return terms[r.name];
  // The padding lives on .tbody and xterm opens in the unpadded .xwrap: FitAddon measures the
  // parent's computed size, and with border-box padding it proposed more columns than visible.
  const wrap = el('div', { class: 'xwrap' }), body = el('div', { class: 'tbody' }, wrap);
  const dot = el('span', { class: 'dot ' + r.state }), sub = el('span', { class: 's' }), banner = el('div', { class: 'banner hidden' });
  const idx = () => rosterList().findIndex(x => x.name === r.name); // selIdx indexes the left list (rosterList)
  const rst = el('button', { class: 'tact rst', title: t('Restart this CLI (same arguments)'), onclick: e => { e.stopPropagation(); restartRole(r.name); } }, '↻');
  const focusBtn = el('button', { class: 'tact', title: t('Focus mode (double-click the title bar) · Esc to exit'), onclick: e => { e.stopPropagation(); toggleFocus(r.name); } }, '⤢');
  const card = el('div', { class: 'term', 'data-role': r.name }, el('div', { class: 'tbar', onclick: () => { select(idx()); touch(r.name); }, ondblclick: () => toggleFocus(r.name) }, el('div', { class: 't' }, dot, r.name, sub), el('div', { class: 'tacts' }, rst, focusBtn)), banner, body);
  $('parking').append(card);
  const term = new Terminal({ fontFamily: '"SF Mono","Cascadia Mono",Consolas,monospace', fontSize: termFont, lineHeight: 1.15, cursorBlink: true, theme: termTheme(), scrollback: 3000, allowProposedApi: true });
  const fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open(wrap);
  term.onData(d => ws && ws.readyState === 1 && ws.send(JSON.stringify({ type: 'input', role: r.name, data: d })));
  body.addEventListener('mousedown', () => { touch(r.name); const i = idx(); if (i !== selIdx) select(i); });
  // Refit on every size change and tell the PTY (cols/rows) so the CLI redraws for the visible size.
  const doFit = () => { if (document.body.classList.contains('swapping') || !card.isConnected || card.parentElement === $('parking') || !wrap.clientWidth) return; try { const d = fit.proposeDimensions(); if (!d || !isFinite(d.cols)) return; if (d.cols !== term.cols || d.rows !== term.rows) term.resize(d.cols, d.rows); const k = `${term.cols}x${term.rows}`; if (ws && ws.readyState === 1 && (doFit.sent !== k || doFit.ws !== ws)) { ws.send(JSON.stringify({ type: 'resize', role: r.name, cols: term.cols, rows: term.rows })); doFit.sent = k; doFit.ws = ws; } } catch { } };
  new ResizeObserver(() => { clearTimeout(doFit.t); doFit.t = setTimeout(doFit, 60); }).observe(wrap);
  terms[r.name] = { term, card, dot, sub, banner, fit: doFit, focusBtn };
  setTimeout(doFit, 50);
  return terms[r.name];
}
function updateTermBar(r) {
  const tm = terms[r.name]; if (!tm) return;
  tm.dot.className = 'dot ' + r.state; tm.sub.textContent = `${r.label || r.adapter}${r.account ? ' · ' + r.account : ''} · ${r.delivery === 'after_turn' ? t('after turn') : t('immediate')} · ${stateLabel(r)}`;
  tm.card.classList.toggle('restarting', r.state === 'restarting');
  tm.banner.classList.toggle('hidden', r.state !== 'attention');
  tm.banner.textContent = r.state !== 'attention' ? '' : r.attention === 'SUBMIT_UNCONFIRMED' ? t('The message was pasted but the CLI did not start (Enter seems ignored). Click this terminal and press Enter to submit it. Deliveries are held.') : `${t('Waiting for you:')} "${r.attention}" ${t('— answer it in this terminal. Deliveries are held.')}`;
}

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (onLoginMsg(m)) return;
    if (m.type === 'reset') { const tm = terms[m.role]; if (tm) tm.term.reset(); return; }
    if (m.type === 'status') { status = m.status; if (status.running) events = status.events || []; renderStatus(); }
    else if (m.type === 'snapshot') { const tm = terms[m.role]; if (tm) { tm.term.reset(); tm.term.write(m.data); } else setTimeout(() => terms[m.role] && terms[m.role].term.write(m.data), 100); }
    else if (m.type === 'output') { const tm = terms[m.role]; if (tm) { tm.term.write(m.data); dockLineSoon(m.role); } }
    else if (m.type === 'role') { if (status.running) { const i = status.roles.findIndex(r => r.name === m.role.name); if (i >= 0) { const prev = status.roles[i].state; status.roles[i] = { ...status.roles[i], ...m.role }; if (prev !== m.role.state && (m.role.state === 'busy' || m.role.state === 'attention')) notifyRole(m.role.name); renderStatus(); } } }
    else if (m.type === 'event') { events.push(m.event); if (events.length > 300) events.shift(); const e = m.event; if (['DELIVERED', 'BRIEFED', 'SUBMIT_UNCONFIRMED'].includes(e.kind) && e.to) notifyRole(e.to); refreshSoon(); }
  };
  ws.onclose = () => setTimeout(connect, 1500);
}
function refreshSoon() { clearTimeout(refreshSoon.t); refreshSoon.t = setTimeout(async () => { try { status = await api('GET', '/api/status'); renderStatus(); } catch { } }, 250); }

// ---------- wiring ----------
async function init() {
  const rerender = () => { const sel = $('presetSel').value; if (loadPresets.data) loadPresets().then(() => $('presetSel').value = sel); renderWorkspace(); renderStatus(); renderGbRow(); };
  setLang(LANG);
  $('btnLang').onclick = () => setLang(LANG === 'zh' ? 'en' : 'zh', rerender);
  wireSide(); wirePanel(); wireStage();
  $('loginClose').onclick = closeLogin;
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeCtx(); if ($('gbSheet').classList.contains('show')) $('gbSheet').classList.remove('show'); else if ($('sheet').classList.contains('show')) $('sheet').classList.remove('show'); else closePop(); } });
  // Outside click closes the popover, except on its anchors (role list, Dock, rail, placeholders,
  // title bars), dialogs, and any scrollbar (pointer outside the element's client area).
  const onScrollbar = e => { const x = e.target; if (!(x instanceof Element) || x === document.documentElement) return false; return (x.clientWidth && e.offsetX > x.clientWidth) || (x.clientHeight && e.offsetY > x.clientHeight); };
  document.addEventListener('pointerdown', e => { if (!popOpen || onScrollbar(e)) return; if (e.target.closest('#pop, #roles, #btnAddRole, .side .link, #dock, #srail, #stage .placeholder, #stage .tbar, #ctx, #sheet, #gbSheet, #loginSheet, #shandle, #phandle')) return; closePop(); }, true);
  window.addEventListener('resize', () => popOpen && positionPop());
  document.addEventListener('scroll', () => popOpen && positionPop(), true);
  [adapters, ui, cliCaps] = await Promise.all([api('GET', '/api/adapters'), api('GET', '/api/ui-state').catch(() => ui), api('GET', '/api/cliflags').catch(() => ({})), loadAccounts()]);
  const def = await api('GET', '/api/defaults');
  if (def.briefing) Object.assign(bdef, def.briefing);
  $('btnGb').onclick = e => { e.stopPropagation(); openGb(); }; $('gbRow').onclick = () => openGb(); renderGbRow();
  try { applyConfig(JSON.parse(localStorage.tbLast)); } catch { wsValue = def.workspace; renderWorkspace(); renderIdle(); }
  renderRoles(); renderAdapters(); renderPlaceholders(); renderFeed(); loadPresets();
  relayout();
  $('optWait').onclick = () => sw($('optWait'), !sw($('optWait')));
  $('btnAddRole').onclick = () => {
    addRole(); // same full form in both states; running adds "Save & start"
  };
  $('btnRescan').onclick = async () => { adapters = await api('GET', '/api/adapters'); renderAdapters(); renderRoles(); toast(t('Rescanned PATH')); };
  $('btnAddCli').onclick = async () => { try { adapters = await api('POST', '/api/adapters', { label: $('mLabel').value, command: $('mCmd').value, args: $('mArgs').value, busy: $('mBusy').value ? [$('mBusy').value] : [], exit: $('mExit').value }); renderAdapters(); toast(t('CLI added')); $('manualCli').open = false; } catch (e) { toast(e.message); } };
  $('btnSavePreset').onclick = async () => { const n = $('presetName').value.trim(); if (!n) return toast(t('Enter a preset name')); await api('POST', '/api/presets', { name: n, config: launchConfig() }); await loadPresets(); toast(`${t('Saved')} "${n}"`); };
  $('btnLoadPreset').onclick = () => { const p = (loadPresets.data || {})[$('presetSel').value]; if (p) { applyConfig(p); toast(t('Preset loaded')); } };
  $('btnDelPreset').onclick = async () => { const n = $('presetSel').value; if (!n) return; await api('DELETE', '/api/presets', { name: n }); await loadPresets(); toast(t('Preset deleted')); };
  $('btnStart').onclick = async () => { const c = launchConfig(); localStorage.tbLast = JSON.stringify(c); $('btnStart').disabled = true;
    const dup = duplicateAccounts(c.roles);
    if (dup.length) { if (!confirm(`${t('These roles use the same CLI with the same account and will share one login and session state:')}\n${dup.join('\n')}\n\n${t('Start anyway?')}`)) { renderFoot(); return; } c.allowDuplicateAccounts = true; }
    try { status = await api('POST', '/api/start', { ...c, globalBriefing: gbText(), lang: LANG }); events = status.events || []; selIdx = 0; closePop(); ui = await api('GET', '/api/ui-state').catch(() => ui); renderStatus(); } catch (e) { toast(e.message); } finally { renderFoot(); } };
  $('btnStop').onclick = async () => { if (!confirm(t('Stop the bridge and exit all CLIs?'))) return; $('btnStop').disabled = true; try { await api('POST', '/api/stop'); } finally { $('btnStop').disabled = false; } for (const n of Object.keys(terms)) { terms[n].card.remove(); terms[n].term.dispose(); delete terms[n]; } status = { running: false }; selIdx = 0; closePop(); renderStatus(); };
  $('swPause').onclick = async () => { status = await api('POST', '/api/pause', { paused: !sw($('swPause')) }); renderStatus(); };
  $('btnNew').onclick = () => { $('sheet').classList.add('show'); $('sMsg').focus(); };
  $('btnCancel').onclick = () => $('sheet').classList.remove('show');
  $('sheet').onclick = e => { if (e.target === $('sheet')) $('sheet').classList.remove('show'); };
  $('sReply').onclick = () => sw($('sReply'), !sw($('sReply')));
  $('btnSend').onclick = async () => { try { const r = await api('POST', '/api/send', { from: $('sFrom').value, to: $('sTo').value, message: $('sMsg').value, reply_required: sw($('sReply')), refs: $('sRefs').value.split(',').map(s => s.trim()).filter(Boolean) }); $('sheet').classList.remove('show'); $('sMsg').value = ''; toast(r.status === 'QUEUED' ? t('Message queued') : tErr(r.status)); } catch (e) { toast(e.message); } };
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { for (const x of Object.values(terms)) x.term.options.theme = termTheme(); });
  try { status = await api('GET', '/api/status'); if (status.running) events = status.events || []; renderStatus(); } catch { }
  connect();
}
init().catch(e => toast(e.message));

// Running count = live roles (not user-stopped / exited); total shown only when they differ.
function roleCountText(list) {
  list = list || [];
  const live = list.filter(r => r && !r.stopped && !r.userStopped && !['exited', 'offline', 'stopped'].includes(r.state)).length;
  const total = Math.max(list.length, typeof rosterList === 'function' ? (rosterList() || []).length : 0);
  return live === total ? `${live} ${t('roles')}` : `${live} ${t('roles running')} / ${total} ${t('roles')}`;
}
