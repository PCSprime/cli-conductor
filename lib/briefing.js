'use strict';
// Opening briefing (开场说明): optional per-role text sent once as the first message.
// Placeholders: {role} {peers} {workspace} {send}. Unknown {x} are left as-is.
function fillBriefing(text, vars) {
  return String(text || '').replace(/\{(role|peers|workspace|send)\}/g, (m, k) => vars[k] !== undefined ? String(vars[k]) : m);
}
module.exports = { fillBriefing };
