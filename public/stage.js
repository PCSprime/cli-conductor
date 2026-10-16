'use strict';
// Running layout: up to 2 terminals on the stage, every role in the bottom Dock, focus mode,
// swap animation, hidden-role notifications, single-CLI restart menu, resizable right panel,
// and account login terminals. Loaded before app.js; uses its globals at call time.
const GLYPH_STOP = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="3.5" fill="currentColor"/></svg>';
const GLYPH_PLAY = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M8 5.6v12.8c0 .9 1 1.5 1.8 1l10-6.4a1.2 1.2 0 0 0 0-2L9.8 4.6C9 4.1 8 4.7 8 5.6z" fill="currentColor"/></svg>';
const SPRING = 'cubic-bezier(.34,1.45,.5,1)', SWAP_MS = 320;
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
let stage = [], focusName = null, lastFocus = {}, unread = {}, dockCards = {}, glowT = {};
let muted = new Set((() => { try { return JSON.parse(localStorage.ccMuted || '[]'); } catch { return []; } })());
const saveMuted = () => { localStorage.ccMuted = JSON.stringify([...muted]); };
const agentNames = () => (status.roles || []).filter(r => r.type !== 'observer').map(r => r.name);
const roleByName = n => (status.roles || []).find(r => r.name === n);
const onStage = n => (focusName ? [focusName] : stage).includes(n);

// ---------- stage ----------
// Slot count: both side panels collapsed -> 3 (or the user's 2/3 override from the pill),
// otherwise 2; focus mode shows 1. In 3-slot mode the terminal font drops one step when that
// is what it takes to reach ~60 columns.
let maxSlots = 2, lastAct = {};
// Base terminal font follows the viewport: small laptops 12px, 1440–2399 12.5px, 2560-class 14px,
// 4K-at-100% 15px; 3-slot mode may drop one step (1px) to get closer to ~60 columns.
const TARGET_COLS = 60;
const baseFont = () => innerWidth >= 3200 ? 15 : innerWidth >= 2400 ? 14 : innerWidth < 1400 ? 12 : 12.5;
let termFont = baseFont();
function charW(fs = termFont) {
  charW.v = charW.v || {}; if (charW.v[fs]) return charW.v[fs];
  const sp = document.createElement('span'); sp.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${fs}px "SF Mono","Cascadia Mono",Consolas,monospace`;
  sp.textContent = 'x'.repeat(100); document.body.append(sp); const w = sp.getBoundingClientRect().width / 100 || fs * .6; sp.remove(); return (charW.v[fs] = w);
}
// Columns a terminal gets with n cards side by side (card padding 16px + xterm scrollbar ~14px).
function colsAt(n, fs = termFont) { const w = $('stage').clientWidth || $('stage').parentElement.clientWidth; return Math.floor(((w - 12 * (n - 1)) / n - 30) / charW(fs)); }
const bothCollapsed = () => { const L = $('layout'); return L.classList.contains('scollapsed') && L.classList.contains('pcollapsed'); };
function computeSlots() { return bothCollapsed() ? (localStorage.ccSlots === '2' ? 2 : 3) : 2; }
function applyFont() {
  const B = baseFont(), fs = maxSlots === 3 && !focusName && colsAt(3, B) < TARGET_COLS ? B - 1 : B;
  if (fs === termFont) return; termFont = fs;
  for (const tm of Object.values(terms)) tm.term.options.fontSize = fs;
}
function updatePill() {
  const p = $('slotPill'); if (!p) return;
  const n = focusName ? 1 : maxSlots, can = bothCollapsed() && !focusName;
  p.textContent = `${n} / 3 ${t('cols')}`; p.classList.toggle('can', can);
  p.title = can ? t('Click to switch between 2 and 3 terminals side by side.') : t('Collapse both side panels to show 3 terminals side by side.');
  if (!p.onclick) p.onclick = () => { if (!bothCollapsed() || focusName) return; localStorage.ccSlots = maxSlots === 3 ? '2' : '3'; relayout(); };
}
function initStage() {
  const names = agentNames();
  let saved = []; try { saved = JSON.parse(localStorage.ccStage || '[]'); } catch { }
  const lim = Math.min(maxSlots, names.length);
  stage = stage.filter(n => names.includes(n)).slice(0, lim);
  for (const n of saved) if (stage.length < lim && names.includes(n) && !stage.includes(n)) stage.push(n);
  for (const n of names) if (stage.length < lim && !stage.includes(n)) stage.push(n);
  if (focusName && !names.includes(focusName)) focusName = null;
  const sel = (status.roles[selIdx] || {}).name; if (stage.includes(sel) && !lastFocus[sel]) touch(sel);
}
const saveStage = () => { localStorage.ccStage = JSON.stringify(stage); };
function placeStage() {
  const st = $('stage'), park = $('parking');
  const want = focusName ? [focusName] : stage;
  for (const [n, tm] of Object.entries(terms)) if (!want.includes(n) && tm.card.parentElement !== park) park.append(tm.card);
  for (const x of [...st.children]) if (!x.dataset.role || !terms[x.dataset.role]) x.remove();
  want.forEach((n, i) => { const c = terms[n] && terms[n].card; if (!c) return; c.dataset.slot = i; if (st.children[i] !== c) st.insertBefore(c, st.children[i] || null); });
  st.classList.toggle('one', want.length === 1); st.classList.toggle('focus', !!focusName);
  for (const n of want) if (terms[n]) terms[n].focusBtn.textContent = focusName ? '⤡' : '⤢';
  refitAll();
  renderDock(); updatePill();
}
// Refit after every layout change (now, next frame, and after transitions settle).
function refitAll() { const f = () => { for (const n of (focusName ? [focusName] : stage)) terms[n] && terms[n].fit(); }; f(); requestAnimationFrame(f); setTimeout(f, SWAP_MS + 60); }
function touch(n) { lastFocus[n] = Date.now(); }
function selectByName(n) { const i = (status.roles || []).findIndex(r => r.name === n); if (i >= 0 && i !== selIdx) { selIdx = i; renderRoles(); highlightTerm(); } }
// Animation helpers (FLIP, shared element): the outgoing card shrinks into its Dock card while the
// incoming card grows out of its own Dock card, both at once, with an opacity crossfade. xterm
// refit / PTY resize is deferred until the motion ends (body.swapping) to avoid flicker.
const EASE = 'cubic-bezier(.2,.8,.2,1)', FLIP_MS = 300;
function makeGhost(card) {
  const from = card.getBoundingClientRect(), g = card.cloneNode(true); g.classList.add('ghost');
  Object.assign(g.style, { left: from.left + 'px', top: from.top + 'px', width: from.width + 'px', height: from.height + 'px' });
  document.body.append(g); return { g, from };
}
let swapT = 0;
function beginSwap() { document.body.classList.add('swapping'); clearTimeout(swapT); swapT = setTimeout(endSwap, FLIP_MS + 120); }
function endSwap() { clearTimeout(swapT); document.body.classList.remove('swapping'); refitAll(); }
function flyGhost({ g, from }, toEl) {
  if (!toEl) return g.remove();
  const b = toEl.getBoundingClientRect();
  const a = g.animate([{ transform: 'none', opacity: 1 }, { transform: `translate(${b.left - from.left}px,${b.top - from.top}px) scale(${b.width / from.width},${b.height / from.height})`, opacity: 0 }], { duration: FLIP_MS, easing: EASE, fill: 'forwards' });
  a.onfinish = a.oncancel = () => g.remove();
}
function expandFrom(card, fromEl) {
  if (!fromEl || !card) return;
  const s = card.getBoundingClientRect(), c = fromEl.getBoundingClientRect ? fromEl.getBoundingClientRect() : fromEl; if (!s.width) return;
  const a = card.animate([{ transformOrigin: '0 0', transform: `translate(${c.left - s.left}px,${c.top - s.top}px) scale(${c.width / s.width},${c.height / s.height})`, opacity: .2 }, { transformOrigin: '0 0', transform: 'none', opacity: 1 }], { duration: FLIP_MS, easing: EASE });
  a.onfinish = a.oncancel = endSwap;
}
const leastRecent = list => list.slice().sort((a, b) => (lastFocus[a] || 0) - (lastFocus[b] || 0))[0];
// Target slot for a Dock click: the selected stage terminal's slot, else the least recently focused.
function targetSlot() {
  const sel = (status.roles[selIdx] || {}).name, j = stage.indexOf(sel);
  return j >= 0 ? j : stage.indexOf(leastRecent(stage));
}
function swapIn(name, slot) {
  if (!terms[name]) return;
  unread[name] = 0;
  if (focusName) { touch(name); selectByName(name); focusName = name; placeStage(); return; }
  if (stage.includes(name) && slot == null) { touch(name); selectByName(name); placeStage(); return; }
  if (stage.includes(name)) { const j = stage.indexOf(name); touch(name); selectByName(name); if (j === slot) return; [stage[j], stage[slot]] = [stage[slot], stage[j]]; saveStage(); placeStage(); return; }
  const lim = Math.min(maxSlots, agentNames().length);
  if (slot == null) slot = stage.length < lim ? stage.length : targetSlot();
  const outName = stage[slot], outCard = outName && terms[outName] && terms[outName].card, inCard = terms[name].card;
  const anim = !reduced();
  const ghost = anim && outCard && outCard.parentElement === $('stage') ? makeGhost(outCard) : null;
  if (anim) beginSwap();
  const inRect = dockCards[name] && dockCards[name].el.getBoundingClientRect();
  stage[slot] = name; saveStage(); touch(name); selectByName(name); placeStage();
  if (!anim) return;
  const dOut = outName && dockCards[outName];
  if (inRect) expandFrom(inCard, inRect); else endSwap();
  if (ghost) flyGhost(ghost, (dOut || dIn || {}).el);
}
// Grow/shrink the stage to the current slot count (2 <-> 3), with Dock animations.
function resizeStage(animate = true) {
  if (!status.running) return;
  const names = agentNames(), lim = Math.min(maxSlots, names.length), anim = animate && !reduced() && !focusName;
  const ghosts = [], added = [];
  while (stage.length > lim) { const v = leastRecent(stage), c = terms[v] && terms[v].card; if (anim && c && c.parentElement === $('stage')) ghosts.push([makeGhost(c), v]); stage.splice(stage.indexOf(v), 1); }
  while (stage.length < lim) {
    const score = n => (unread[n] ? 1e15 : 0) + (lastAct[n] || 0);
    const cand = names.filter(n => !stage.includes(n)).sort((a, b) => score(b) - score(a))[0]; if (!cand) break;
    stage.push(cand); added.push(cand); unread[cand] = 0; touch(cand);
  }
  if (!ghosts.length && !added.length) { placeStage(); return; }
  if (anim) beginSwap();
  saveStage(); placeStage();
  for (const [g, v] of ghosts) flyGhost(g, dockCards[v] && dockCards[v].el);
  if (anim) for (const n of added) expandFrom(terms[n].card, dockCards[n] && dockCards[n].el);
}
function applySlots(animate = true) {
  const n = computeSlots(); maxSlots = n; applyFont(); updatePill();
  if (status.running) resizeStage(animate); else renderPlaceholders();
}
function relayout() { requestAnimationFrame(() => { applySlots(true); refitAll(); if (popOpen) positionPop(); }); }
function toggleFocus(name) {
  if (focusName === name || (!name && focusName)) { focusName = null; }
  else { if (!stage.includes(name)) swapIn(name); focusName = name; touch(name); }
  applyFont(); placeStage();
}

// ---------- dock ----------
// FLIP for Dock reorders: measure every card, mutate the DOM, then slide each card from its old spot.
function flipChildren(box, mutate) {
  const before = new Map(); if (!reduced()) for (const c of box.querySelectorAll('.dc')) before.set(c.dataset.role || c.dataset.i, c.getBoundingClientRect());
  mutate();
  if (reduced()) return;
  for (const c of box.querySelectorAll('.dc')) {
    const r0 = before.get(c.dataset.role || c.dataset.i); if (!r0) continue;
    const r1 = c.getBoundingClientRect(), dx = r0.left - r1.left; if (Math.abs(dx) < 1) continue;
    c.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: FLIP_MS, easing: EASE });
  }
}
// Dock order is derived from the stage: on-stage roles first, in stage slot order (with ①②③),
// then a divider, then the rest in base role order. Any stage change (swap, resize, a future
// drag-reorder) only needs to update `stage` and call placeStage() → renderDock().
const SLOT_MARK = ['①', '②', '③'];
function dockOrder(all, onStageList) { const on = onStageList.filter(n => all.includes(n)); return { on, rest: all.filter(n => !on.includes(n)) }; }
function lastLine(name) {
  const tm = terms[name]; if (!tm) return '';
  const b = tm.term.buffer.active, end = b.baseY + b.cursorY;
  for (let y = end; y >= Math.max(0, end - 40); y--) { const l = b.getLine(y); const s = l ? l.translateToString(true).trim() : ''; if (s) return s; }
  return '';
}
function stateLabel(r) { return r.type === 'observer' ? t('archive · inbox only') : r.state === 'offline' && r.stopped ? t('stopped') : stateText(r.state); }
function renderDock() {
  const box = $('dock'); if (!status.running) { box.innerHTML = ''; dockCards = {}; return; }
  if (!box.querySelector('.dlabel')) box.append(el('div', { class: 'dlabel' }, t('Role Dock')));
  if (!$('slotPill')) box.append(el('div', { class: 'slotpill', id: 'slotPill' }));
  if (!box.querySelector('.dsep')) box.insertBefore(el('div', { class: 'dsep' }), $('slotPill'));
  const roleList = status.roles;
  for (const n of Object.keys(dockCards)) if (!roleByName(n)) { dockCards[n].el.remove(); delete dockCards[n]; }
  roleList.forEach((r, i) => {
    let d = dockCards[r.name];
    if (!d) {
      const dot = el('span', { class: 'dot' }), sub = el('em', {}), line = el('div', { class: 'l' }), badge = el('div', { class: 'badge hidden' }), mute = el('span', { class: 'mute hidden', title: t('Muted') }, '🔕');
      const card = el('div', { class: 'dc' + (r.type === 'observer' ? ' arch' : ''), draggable: r.type === 'observer' ? 'false' : 'true', 'data-role': r.name, 'data-onstage': t('On stage') },
        el('div', { class: 'n' }, el('span', { class: 'slotb' }), dot, el('b', {}, r.name), mute, sub), line, badge, el('div', { class: 'key' }, i < 9 && r.type !== 'observer' ? `Ctrl+${i + 1}` : ''));
      card.addEventListener('click', () => { const i2 = status.roles.findIndex(x => x.name === r.name); if (popOpen && selIdx === i2) return closePop(); if (r.type === 'observer') { selIdx = i2; renderRoles(); return openPop(card); } swapIn(r.name); if (popOpen) openPop(card); });
      card.addEventListener('dblclick', () => r.type !== 'observer' && toggleFocus(r.name));
      card.addEventListener('contextmenu', e => { e.preventDefault(); if (r.type !== 'observer') openCtx(r.name, e.clientX, e.clientY); });
      card.addEventListener('dragstart', e => { e.dataTransfer.setData('text/cc-role', r.name); e.dataTransfer.effectAllowed = 'move'; document.body.classList.add('dragging'); });
      card.addEventListener('dragend', () => document.body.classList.remove('dragging'));
      box.insertBefore(card, $('slotPill'));
      d = dockCards[r.name] = { el: card, dot, sub, line, badge, mute };
    }
    const cur = roleByName(r.name);
    d.dot.className = 'dot ' + (cur.type === 'observer' ? 'archive' : cur.state);
    d.sub.textContent = cur.type === 'observer' ? t('archive only') : `${cur.label || cur.adapter} · ${stateLabel(cur)}`;
    d.line.textContent = cur.type === 'observer' ? `${(status.bridge.counts || {}).archived || 0} ${t('archived')}` : (cur.state === 'restarting' ? t('Restarting: exiting and relaunching with the same arguments…') : lastLine(r.name) || '—');
    d.el.title = `${r.name} · ${d.sub.textContent}\n${d.line.textContent}`;
    d.el.classList.toggle('onstage', onStage(r.name));
    d.el.classList.toggle('restarting', cur.state === 'restarting');
    const u = unread[r.name] || 0; d.badge.textContent = u > 9 ? '9+' : String(u); d.badge.classList.toggle('hidden', !u); d.badge.classList.toggle('muted', muted.has(r.name));
    d.mute.classList.toggle('hidden', !muted.has(r.name));
    const k = (focusName ? [focusName] : stage).indexOf(r.name); d.el.querySelector('.slotb').textContent = k >= 0 ? SLOT_MARK[k] || '' : '';
  });
  const { on, rest } = dockOrder(roleList.map(r => r.name), focusName ? [focusName] : stage);
  const want = [...on.map(n => dockCards[n].el), box.querySelector('.dsep'), ...rest.map(n => dockCards[n].el)];
  const cur = [...box.children].filter(x => x.classList.contains('dc') || x.classList.contains('dsep'));
  if (want.some((x, i) => cur[i] !== x)) flipChildren(box, () => { for (const x of want) box.insertBefore(x, $('slotPill')); });
  box.querySelector('.dsep').classList.toggle('hidden', !on.length || !rest.length);
}
function dockLineSoon(name) { lastAct[name] = Date.now(); const d = dockCards[name]; if (!d) return; clearTimeout(d.t); d.t = setTimeout(() => { const r = roleByName(name); if (r && r.state !== 'restarting') d.line.textContent = lastLine(name) || '—'; }, 250); }
// A hidden role got a message / started working / needs attention: glow + bounce + badge.
function notifyRole(name) {
  if (!status.running || !dockCards[name] || onStage(name)) return;
  unread[name] = (unread[name] || 0) + 1;
  if (!muted.has(name)) { const c = dockCards[name].el; c.classList.remove('glow'); void c.offsetWidth; c.classList.add('glow'); clearTimeout(glowT[name]); glowT[name] = setTimeout(() => c.classList.remove('glow'), 2600); }
  renderDock();
}

// ---------- context menu (Dock card) + restart / stop ----------
function closeCtx() { $('ctx').classList.remove('show'); }
function openCtx(name, x, y) {
  const m = $('ctx'); m.innerHTML = '';
  const item = (label, fn, cls = '') => el('button', { class: 'ci ' + cls, onclick: () => { closeCtx(); fn(); } }, label);
  m.append(el('div', { class: 'ch' }, name),
    item('↻ ' + t('Restart'), () => restartRole(name)),
    item('⊕ ' + t('View'), () => swapIn(name)),
    item((muted.has(name) ? '🔔 ' + t('Unmute') : '🔕 ' + t('Mute')), () => { muted.has(name) ? muted.delete(name) : muted.add(name); saveMuted(); renderDock(); }),
    el('hr'),
    item('■ ' + t('Stop this role'), () => stopRole(name), 'red'));
  m.classList.add('show');
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.min(x, innerWidth - w - 8) + 'px'; m.style.top = Math.max(8, Math.min(y, innerHeight - h - 8)) + 'px';
}
async function restartRole(name) {
  const r = roleByName(name); if (!r || r.state === 'restarting') return;
  try { await api('POST', '/api/restart-role', { role: name }); toast(`${name}: ${t('restarting…')}`); } catch (e) { toast(e.message); }
}
async function stopRole(name) {
  if (!confirm(`${t('Stop this role?')} ${name}\n${t('Messages to it are held until you restart it.')}`)) return;
  try { await api('POST', '/api/stop-role', { role: name }); refreshSoon(); } catch (e) { toast(e.message); }
}

// ---------- stage drop targets, shortcuts ----------
function wireStage() {
  const st = $('stage');
  st.addEventListener('dragover', e => { if (!e.dataTransfer.types.includes('text/cc-role') && !e.dataTransfer.types.includes('text/cc-pre')) return; e.preventDefault(); const c = e.target.closest('.term'); for (const x of st.children) x.classList.toggle('drop', x === c); });
  st.addEventListener('dragleave', e => { if (!st.contains(e.relatedTarget)) for (const x of st.children) x.classList.remove('drop'); });
  st.addEventListener('drop', e => {
    const pre = e.dataTransfer.getData('text/cc-pre');
    if (pre !== '' && !status.running) { e.preventDefault(); const c = e.target.closest('.term'); for (const x of st.children) x.classList.remove('drop'); preSwap(roles[Number(pre)], c && c.dataset.slot != null ? Number(c.dataset.slot) : undefined); return; }
    const n = e.dataTransfer.getData('text/cc-role'); if (!n) return; e.preventDefault();
    const c = e.target.closest('.term'); for (const x of st.children) x.classList.remove('drop');
    let slot = c ? Number(c.dataset.slot) : stage.length < 2 ? stage.length : 0; if (focusName) { focusName = null; }
    swapIn(n, slot);
  });
  document.addEventListener('keydown', e => {
    if (!status.running) { if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key) && !e.target.closest('input,textarea,select')) { const r = roles[Number(e.key) - 1]; if (r && r.enabled && r.type !== 'observer') { e.preventDefault(); preSwap(r); } } return; }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
      const r = (status.roles || [])[Number(e.key) - 1]; if (!r) return;
      e.preventDefault(); e.stopPropagation(); if (r.type !== 'observer') swapIn(r.name);
    }
    // Esc leaves focus mode unless the keystroke goes to a terminal (CLIs use Esc to interrupt).
    if (e.key === 'Escape' && focusName && !document.activeElement.closest('.xterm')) { focusName = null; placeStage(); }
  }, true);
  document.addEventListener('mousedown', e => { if (!e.target.closest('#ctx')) closeCtx(); });
  window.addEventListener('resize', () => { clearTimeout(relayout.t); relayout.t = setTimeout(() => { applySide(); applyPanel(); relayout(); }, 80); });
}

// ---------- right panel: drag handle resize + collapse to rail ----------
function applyPanel() {
  const L = $('layout'), w = Math.max(240, Math.min(560, Number(localStorage.ccPanelW) || Math.round(Math.max(256, Math.min(316, innerWidth * .21)))) * uiZoom());
  // Narrow windows (< 1280 CSS px, e.g. 1536x864 at 125%) start with the right panel collapsed.
  if (localStorage.ccPanelC == null && innerWidth < 1280) localStorage.ccPanelC = '1';
  L.style.setProperty('--pw', w + 'px'); L.classList.toggle('pcollapsed', localStorage.ccPanelC === '1');
  $('phandle').title = t(localStorage.ccPanelC === '1' ? 'Click to expand' : 'Drag to resize · click to collapse');
}
function wirePanel() {
  const h = $('phandle');
  h.addEventListener('pointerdown', e => {
    e.preventDefault(); h.setPointerCapture(e.pointerId);
    const x0 = e.clientX, w0 = $('panel').getBoundingClientRect().width; let moved = false;
    const mv = ev => { const dx = x0 - ev.clientX; if (Math.abs(dx) > 3) moved = true; if (!moved || localStorage.ccPanelC === '1') return; localStorage.ccPanelW = Math.round(Math.max(240, Math.min(560, w0 + dx))); applyPanel(); };
    const up = () => { h.removeEventListener('pointermove', mv); h.removeEventListener('pointerup', up); if (!moved) localStorage.ccPanelC = localStorage.ccPanelC === '1' ? '0' : '1'; applyPanel(); relayout(); };
    h.addEventListener('pointermove', mv); h.addEventListener('pointerup', up);
  });
  $('prail').addEventListener('click', () => { localStorage.ccPanelC = '0'; applyPanel(); relayout(); });
  applyPanel();
}
function renderPanelRail() {
  const box = $('prail'); box.innerHTML = '';
  const c = (status.bridge && status.bridge.counts) || {}, busy = (status.roles || []).filter(r => r.state === 'busy').length;
  const k = (v, label, cls = '') => el('div', { class: 'k ' + cls }, el('b', {}, v), label);
  if (status.running) box.append(k(c.delivered || 0, t('Deliv.')), k(busy, t('Work'), busy ? 'or' : ''), k(c.held || 0, t('Held'), c.held ? 'or' : ''), k(c.archived || 0, t('Arch.')));
  box.append(el('div', { class: 'vt' }, t('Status & activity'), ' ‹'));
}

// ---------- left sidebar: handle (drag to resize, click to collapse to an icon rail) ----------
// Wide screens at 100% scaling (2560-class, 4K): scale the chrome (header, side panels, Dock,
// popover) so it isn't tiny and sparse; terminals scale through their own font size instead.
const uiZoom = () => innerWidth >= 3200 ? 1.4 : innerWidth >= 2400 ? 1.15 : 1;
function applyZoom() {
  const z = uiZoom(); document.documentElement.style.setProperty('--uiz', z);
  for (const e of [document.querySelector('header'), document.querySelector('.side'), document.querySelector('.panel'), $('dock'), $('pop')]) if (e) e.style.zoom = z === 1 ? '' : z;
}
function applySide() {
  applyZoom();
  // Default width scales with the viewport until the user drags it (then the stored width wins).
  const L = $('layout'), w = Math.max(220, Math.min(480, Number(localStorage.ccSideW) || Math.round(Math.max(232, Math.min(300, innerWidth * .2)))) * uiZoom());
  L.style.setProperty('--sw', w + 'px'); L.classList.toggle('scollapsed', localStorage.ccSideC === '1');
  $('shandle').title = t(localStorage.ccSideC === '1' ? 'Click to expand' : 'Drag to resize · click to collapse');
}
function setSideCollapsed(c) { localStorage.ccSideC = c ? '1' : '0'; applySide(); renderSideRail(); relayout(); }
function wireSide() {
  const h = $('shandle');
  h.addEventListener('pointerdown', e => {
    e.preventDefault(); h.setPointerCapture(e.pointerId);
    const x0 = e.clientX, w0 = document.querySelector('.side').getBoundingClientRect().width; let moved = false;
    const mv = ev => { const dx = ev.clientX - x0; if (Math.abs(dx) > 3) moved = true; if (!moved || localStorage.ccSideC === '1') return; localStorage.ccSideW = Math.round(Math.max(240, Math.min(480, w0 + dx))); applySide(); if (popOpen) positionPop(); };
    const up = () => { h.removeEventListener('pointermove', mv); h.removeEventListener('pointerup', up); if (!moved) setSideCollapsed(localStorage.ccSideC !== '1'); else relayout(); };
    h.addEventListener('pointermove', mv); h.addEventListener('pointerup', up);
  });
  applySide();
}
function renderSideRail() {
  const box = $('srail'); if (!box) return; box.innerHTML = '';
  const running = status.running, list = running ? status.roles : roles;
  box.append(el('button', { class: 'ri', title: t('Show sidebar'), onclick: () => setSideCollapsed(false) }, '☰'));
  list.forEach((r, i) => {
    if (!running && !r.enabled) return;
    const st = r.type === 'observer' ? 'archive' : running ? r.state : 'offline';
    const b = el('button', { class: 'ri role' + (i === selIdx ? ' cur' : ''), 'data-i': i, style: `background:${roleColor(r, i)}`, title: `${r.name || '—'} · ${running ? stateLabel(r) : roleSub(r)}${i < 9 && r.type !== 'observer' ? ` · Ctrl+${i + 1}` : ''}` }, (r.name || '?')[0], el('span', { class: 'dot ' + st }));
    b.onclick = () => {
      if (running) { if (popOpen && selIdx === i) return closePop(); if (r.type !== 'observer') swapIn(r.name); else { selIdx = i; renderRoles(); } if (popOpen || r.type === 'observer') openPop(b); }
      else select(i, b);
    };
    box.append(b);
  });
  box.append(el('div', { class: 'sep' }),
    el('button', { class: 'ri', title: t('Rescan'), onclick: () => $('btnRescan').click() }, '⟳'),
    el('button', { class: 'ri', title: t('Accounts'), onclick: () => { setSideCollapsed(false); setTimeout(showAccounts, 60); } }, '👤'));
  if (running) box.append(el('button', { class: 'ri', title: t('New Message'), onclick: () => $('btnNew').click() }, '✉'));
  box.append(el('div', { class: 'sp' }));
  const start = $('btnStart'), why = $('startWhy').textContent;
  const go = running ? el('button', { class: 'ri go stop', title: t('Stop the bridge and exit all CLIs'), 'aria-label': t('Stop Conductor'), onclick: () => $('btnStop').click() })
    : el('button', { class: 'ri go', title: why || t('Start Conductor'), 'aria-label': t('Start Conductor'), ...(start.disabled ? { disabled: '' } : {}), onclick: () => $('btnStart').click() });
  go.innerHTML = running ? GLYPH_STOP : GLYPH_PLAY;
  box.append(go);
}

// ---------- accounts + login terminal ----------
let acct = { supported: {}, accounts: {} }, loginTerm = null, loginId = null, loginPoll = null;
async function loadAccounts() { try { acct = await api('GET', '/api/accounts'); } catch { acct = { supported: {}, accounts: {} }; } return acct; }
function accountRow(r, rerender) {
  const cap = acct.supported[r.adapter]; if (!cap) { delete r.account; return null; }
  const list = acct.accounts[r.adapter] || [];
  if (r.account && r.account !== 'default' && !list.some(a => a.name === r.account)) r.account = '';
  setTimeout(() => newBox.closest('.row') && newBox.closest('.row').classList.add('acctrow'));
  const newBox = el('div', { class: 'newacct hidden' });
  const sel = el('select', { class: 'field-sel', onchange: e => { if (e.target.value === '__new') { newBox.classList.remove('hidden'); if (stat) stat.classList.add('hidden'); newBox.querySelector('input').focus(); } else { newBox.classList.add('hidden'); if (stat) stat.classList.remove('hidden'); r.account = e.target.value; renderFoot(); } } },
    el('option', { value: '' }, t('Default')),
    list.map(a => el('option', { value: a.name, ...(r.account === a.name ? { selected: '' } : {}) }, `${a.name} · ${a.loggedIn ? t('logged in ✓') : t('not logged in')}`)),
    el('option', { value: '__new' }, t('New account…')));
  const name = el('input', { type: 'text', class: 'field mono', placeholder: t('account name, e.g. work') });
  const go = el('button', { class: 'btn sm', onclick: async () => {
    try { const n = name.value.trim().toLowerCase(); acct = await api('POST', '/api/accounts', { cli: r.adapter, name: n }); r.account = n; rerender(); renderAccounts(); openLogin(r.adapter, n); }
    catch (e) { toast(e.message); }
  } }, t('Create & log in'));
  newBox.append(name, go, el('div', { class: 'hint' }, `${t('Stored in')} ${acct.root || ''}${(acct.root || '').includes('\\') ? '\\' : '/'}${r.adapter}-<name> · ${cap.env}`));
  const cur = list.find(a => a.name === r.account);
  const stat = cur ? el('div', { class: 'hint' + (cur.loggedIn ? ' ok' : ' warn') }, cur.loggedIn ? t('Logged in') : t('Not logged in yet'), ' · ', el('button', { class: 'link', onclick: () => openLogin(r.adapter, cur.name) }, t('Log in…'))) : '';
  return optRow('Account', 'Which login this CLI uses. Second account: pick “New account…”, type a name, then “Create & log in”.', el('div', { class: 'ctl' }, sel, stat, newBox, el('button', { class: 'link', style: 'align-self:flex-start', onclick: () => { closePop(); showAccounts(); } }, t('Manage accounts') + ' ›')), true);
}
async function openLogin(cli, name) {
  let res; try { res = await api('POST', '/api/account-login', { cli, name }); } catch (e) { return toast(e.message); }
  loginId = res.id;
  $('loginTitle').textContent = `${t('Log in')} · ${cli} · ${name}`;
  $('loginCmd').textContent = `${cli} ${(acct.supported[cli] || {}).login || ''}`.trim() + `   (${(acct.supported[cli] || {}).env}=${acct.root}${(acct.root || '').includes('\\') ? '\\' : '/'}${cli}-${name})`;
  $('loginSheet').classList.add('show');
  const host = $('loginTermBox'); host.innerHTML = '';
  if (loginTerm) loginTerm.term.dispose();
  const term = new Terminal({ fontFamily: '"SF Mono","Cascadia Mono",Consolas,monospace', fontSize: 12.5, lineHeight: 1.15, theme: termTheme(), scrollback: 2000 });
  const fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open(host);
  term.onData(d => ws && ws.readyState === 1 && ws.send(JSON.stringify({ type: 'input', role: loginId, data: d })));
  loginTerm = { term, fit: () => { try { fit.fit(); ws && ws.readyState === 1 && ws.send(JSON.stringify({ type: 'resize', role: loginId, cols: term.cols, rows: term.rows })); } catch { } } };
  setTimeout(loginTerm.fit, 60); term.focus();
  const upd = async () => { await loadAccounts(); const a = (acct.accounts[cli] || []).find(x => x.name === name); const s = $('loginState'); s.textContent = a && a.loggedIn ? t('Logged in ✓ — you can close this.') : t('Waiting for login…'); s.className = 'lstate ' + (a && a.loggedIn ? 'ok' : ''); };
  clearInterval(loginPoll); loginPoll = setInterval(upd, 1500); upd();
}
async function closeLogin() {
  clearInterval(loginPoll); $('loginSheet').classList.remove('show');
  if (loginId) { try { await api('POST', '/api/account-login-stop', { id: loginId }); } catch { } }
  loginId = null; await loadAccounts(); renderAccounts(); if (popOpen) renderPop();
}
function onLoginMsg(m) {
  if (m.type === 'output' && m.role === loginId && loginTerm) { loginTerm.term.write(m.data); return true; }
  if (m.type === 'login' && m.id === loginId) { loadAccounts().then(() => { if (popOpen) renderPop(); }); return true; }
  return false;
}
// Same CLI + same account on two roles (both would share one login and its session state).
function duplicateAccounts(list) {
  const g = {};
  for (const r of list) { if (!r.enabled || r.type === 'observer' || !acct.supported[r.adapter]) continue; const k = `${r.adapter}/${r.account || 'default'}`; (g[k] = g[k] || []).push(r.name); }
  return Object.entries(g).filter(([, v]) => v.length > 1).map(([k, v]) => `${k}: ${v.join(', ')}`);
}

// ---------- sidebar: account management ----------
function showAccounts() { const s = $('acctSec'); if (!s) return; if (localStorage.ccSideC === '1') setSideCollapsed(false); s.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'center' }); s.classList.remove('flash'); void s.offsetWidth; s.classList.add('flash'); }
const acctOpen = {};
function renderAccounts() {
  const box = $('accounts'), sec = $('acctSec'); if (!box) return; box.innerHTML = '';
  const clis = Object.keys(acct.supported || {}).filter(c => (adapters.find(a => a.id === c) || {}).path || (acct.accounts[c] || []).length);
  sec.classList.toggle('hidden', !clis.length);
  for (const cli of clis) {
    const label = adapterLabel(cli), list = acct.accounts[cli] || [];
    const name = el('input', { type: 'text', class: 'field mono', placeholder: t('account name, e.g. work') });
    const create = async () => { try { const n = name.value.trim().toLowerCase(); acct = await api('POST', '/api/accounts', { cli, name: n }); acctOpen[cli] = false; renderAccounts(); if (popOpen) renderPop(); openLogin(cli, n); } catch (e) { toast(e.message); } };
    name.addEventListener('keydown', e => { if (e.key === 'Enter') create(); });
    const newRow = el('div', { class: 'row newrow' + (acctOpen[cli] ? '' : ' hidden') }, name, el('button', { class: 'btn sm', onclick: create }, t('Create')));
    box.append(el('div', { class: 'row acli' }, el('span', { class: 'nm' }, label), el('button', { class: 'link', onclick: () => { acctOpen[cli] = !acctOpen[cli]; newRow.classList.toggle('hidden'); if (acctOpen[cli]) name.focus(); } }, '＋ ' + t('New account'))));
    box.append(el('div', { class: 'row arow' }, el('div', { class: 'k' }, el('span', { class: 'dot archive' }), el('div', {}, el('div', {}, t('Default login')), el('div', { class: 'v' }, t("the CLI's own login"))))));
    for (const a of list) box.append(el('div', { class: 'row arow' },
      el('div', { class: 'k' }, el('span', { class: 'dot ' + (a.loggedIn ? 'idle' : 'busy') }), el('div', { style: 'min-width:0' }, el('div', { class: 'mono-in' }, a.name), el('div', { class: 'v' + (a.loggedIn ? ' okc' : ' warnc') }, a.loggedIn ? t('logged in ✓') : t('not logged in')))),
      el('div', { class: 'cliact' },
        el('button', { class: 'ibtn', title: a.loggedIn ? t('Re-login') : t('Log in'), 'aria-label': t('Re-login'), onclick: () => openLogin(cli, a.name) }, '↻'),
        el('button', { class: 'ibtn', title: t('Open folder'), 'aria-label': t('Open folder'), onclick: async () => { try { const r = await api('POST', '/api/open-account-folder', { cli, name: a.name }); toast(`${t('Opened')} ${r.dir}`); } catch (e) { toast(e.message); } } }, '📂'))));
    box.append(newRow);
  }
  $('acctFoot').textContent = `${t('To use an account for a role: click the role → Account → pick it.')} ${t('Only Codex, Claude Code and Gemini CLI support separate accounts.')}`;
}
