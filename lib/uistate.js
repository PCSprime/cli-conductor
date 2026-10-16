'use strict';
// Small persisted UI state: recent folders and hidden CLI ids (data/ui.json).
const fs = require('fs');
const path = require('path');
const MAX_RECENT = 8;
function clean(s) {
  const recentDirs = [...new Set([].concat(s.recentDirs || []).filter(d => typeof d === 'string' && d.trim()).map(d => d.trim()))].slice(0, MAX_RECENT);
  const hiddenAdapters = [...new Set([].concat(s.hiddenAdapters || []).filter(d => typeof d === 'string' && /^[a-z0-9_-]{1,32}$/.test(d)))];
  return { recentDirs, hiddenAdapters };
}
function load(file) { try { return clean(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return clean({}); } }
function save(file, s) { const c = clean(s); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(c, null, 2)); return c; }
// patch: { addRecent?: string, hide?: id, unhide?: id }
function apply(file, patch = {}) {
  const s = load(file);
  if (patch.addRecent) s.recentDirs = [String(patch.addRecent).trim(), ...s.recentDirs.filter(d => d.toLowerCase() !== String(patch.addRecent).trim().toLowerCase())];
  if (patch.removeRecent) s.recentDirs = s.recentDirs.filter(d => d !== patch.removeRecent);
  if (patch.hide) s.hiddenAdapters.push(String(patch.hide));
  if (patch.unhide) s.hiddenAdapters = s.hiddenAdapters.filter(d => d !== patch.unhide);
  return save(file, s);
}
module.exports = { load, save, apply, clean, MAX_RECENT };
