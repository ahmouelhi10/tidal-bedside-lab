// Line icons drawn for this app (24 x 24, stroke = currentColor): instruments, procedure actions and start-screen sections.
const svg = (d, size = 26) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

const P = {
  // instruments
  syringe: '<path d="M14.5 3.5l6 6M17.5 6.5l-9.5 9.5-3 1 1-3 9.5-9.5"/><path d="M11 9l4 4M8.5 11.5l2 2M4 20l2-2"/>',
  needle14G: '<path d="M4 20l9-9"/><path d="M13 11l4-4 3 3-4 4z" /><path d="M17 7l1.5-1.5M19 9l1.5-1.5"/><circle cx="16.2" cy="9.8" r=".6"/>',
  scalpel: '<path d="M3 21l8-8"/><path d="M11 13c2-5 6-8 10-9-1 4-4 8-9 10z"/>',
  bougie: '<path d="M4 20c4-1 7-4 9-8s3-6 6-8"/><path d="M19 4l2 1"/>',
  chestDrain: '<path d="M4 20l10-10"/><path d="M14 10c1.5-1.5 3.5-2.5 6-2.5"/><path d="M7.5 16.5l1 1M10 14l1 1"/><circle cx="20" cy="7.5" r="1"/>',
  forcepsGauze: '<path d="M3 21l6-6M6 21l5-5"/><rect x="11" y="4" width="9" height="8" rx="2" transform="rotate(-20 15.5 8)"/><path d="M13 7l5 2M12.5 9.5l5 2"/>',
  tourniquet: '<rect x="3" y="9" width="18" height="6" rx="3"/><path d="M15 9v6M18 9v6"/><circle cx="7.5" cy="12" r="1"/>',
  ivCannula: '<path d="M3 21l7-7"/><path d="M10 14l3-3 3 3-3 3z"/><path d="M13 11l2-5M16 14l5-2"/><path d="M14.5 12.5L19 8"/>',
  defibPadRight: '<rect x="4" y="5" width="9" height="12" rx="2.5"/><rect x="11" y="9" width="9" height="11" rx="2.5"/><path d="M8.5 9.5l-1 2.2h2l-1 2.2"/>',
  // actions
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  monitor: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M5 11h3l1.5-3 2.5 6 1.8-3H19M9 21h6M12 17v4"/>',
  drug: '<path d="M10.5 3.5l10 10a4.24 4.24 0 01-6 6l-10-10a4.24 4.24 0 016-6z"/><path d="M8 11l5-5"/>',
  vent: '<path d="M4 15c2 0 2-6 4-6s2 6 4 6 2-6 4-6 2 6 4 6"/><path d="M3 20h18"/>',
  airway: '<path d="M12 3v7"/><path d="M12 10c-3 0-6 3-6 7 0 2 1 4 3 4 2-1 3-3 3-6M12 10c3 0 6 3 6 7 0 2-1 4-3 4-2-1-3-3-3-6"/>',
  cpr: '<path d="M12 20s-7-4.4-7-10a4 4 0 017-2.6A4 4 0 0119 10c0 5.6-7 10-7 10z"/><path d="M9 11h2l1-2 1.5 4 1-2H16"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  oxygen: '<path d="M8 4h8l2 5c0 5-3 9-6 11-3-2-6-6-6-11z"/><path d="M10 11a2 2 0 104 0 2 2 0 10-4 0"/>',
  bed: '<path d="M3 18V7M3 14h18v4M21 14v-3a3 3 0 00-3-3h-7v6"/><circle cx="7" cy="11" r="2"/>',
  talk: '<path d="M4 5h16v10H9l-5 4z"/><path d="M8 9h8M8 12h5"/>',
  steth: '<path d="M6 3v6a4 4 0 008 0V3"/><path d="M10 13v3a4 4 0 008 0v-2"/><circle cx="18" cy="12" r="2"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  xray: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M12 6v12M8 9c2 0 2 2 4 2s2-2 4-2M8 13c2 0 2 2 4 2s2-2 4-2"/>',
  // sections
  flask: '<path d="M9 3h6M10 3v6L4.5 18.5A2 2 0 006.2 21.5h11.6a2 2 0 001.7-3L14 9V3"/><path d="M7 15h10"/>',
  hand: '<path d="M8 13V6a1.5 1.5 0 013 0v5M11 11V4.5a1.5 1.5 0 013 0V11M14 11V6a1.5 1.5 0 013 0v7c0 4-2.5 7-6 7-2.5 0-4-1-5.5-3L3.8 13.6a1.6 1.6 0 012.5-2L8 13"/>',
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 017-2.6A4 4 0 0119 10c0 5.6-7 10-7 10z"/><path d="M7 12h3l1.5-3 2 6 1.5-3H17"/>',
  back: '<path d="M14 6l-6 6 6 6"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
};
export const icon = (name, size) => svg(P[name] || P.check, size);

/** Icon of a guided step: its instrument for hands-on steps, otherwise guessed from the engine events it dispatches. */
export function stepIcon(step, events = []) {
  if (step.hand) return step.hand.tool;
  const ty = events.map(e => e.type);
  const has = (p) => ty.some(x => x.startsWith(p));
  if (has('defib')) return 'bolt';
  if (has('cpr')) return 'cpr';
  if (has('monitor')) return 'monitor';
  if (has('drug') || has('bicarb')) return 'drug';
  if (has('vent')) return 'vent';
  if (has('airway.intubate') || has('procedure.cricothyroidotomy')) return 'airway';
  if (has('o2') || has('apox')) return 'oxygen';
  if (has('position')) return 'bed';
  if (has('order')) return 'talk';
  if (has('exam')) return 'steth';
  if (has('procedure')) return 'scalpel';
  if (has('iv.access')) return 'ivCannula';
  return step.wait || step.ready ? 'clock' : 'check';
}
