// The patient's voice and what the stethoscope hears, read from the engine (pure, no DOM, display only).
//  - patientLine(): what the patient says now, from their state: nothing when they cannot speak (cardiac arrest, unconscious,
//    paralysed, a tube or a supraglottic device in the airway, a seizure, hardly breathing); confused words when drowsy;
//    gasped words when short of oxygen or breathing very fast; otherwise the complaint of the case while it is still unwell,
//    and relief once the vital signs are back to normal. Lines are short, written for this simulator (EN/FR).
//  - Speaker decides when: on a change of what they would say (at least GAP_S apart), else every REPEAT_S of simulated time.
//  - auscultation(): each lung's breath sounds from the chest findings (absent / reduced), wheeze from bronchospasm, crackles
//    from pulmonary oedema, and the heart sounds (none in cardiac arrest, muffled by a pericardial effusion).
// Thresholds are design values judged against the monitor (GCS 9-12 confused, SpO2 < 85 % or RR >= 30 breathless).
// sc: the engine's clinical scores (engine/clinical.js scores(p)), passed in so this file runs under node without the engine.

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const GAP_S = 8, REPEAT_S = 45, FIRST_S = 3;

const L = (en, fr) => ({ en, fr });
export const LINES = Object.freeze({
  confused: [L('Mmh... where am I?', 'Mmh... où je suis ?'), L('What... what is happening?', 'Quoi... qu\'est-ce qui se passe ?'), L('Ohh...', 'Ohh...')],
  breathless: [L('I... can\'t... breathe...', 'J\'arrive... pas... à respirer...'), L('Help me... no air...', 'Aidez-moi... pas d\'air...')],
  better: [L('That is a bit better... thank you.', 'Ça va un peu mieux... merci.'), L('I can breathe more easily now.', 'J\'arrive mieux à respirer maintenant.')],
  // the complaint of each case, while the patient is awake and still unwell
  stemi_vf: [L('My chest... it feels like a weight crushing me.', 'Ma poitrine... comme un poids qui m\'écrase.'), L('The pain is going into my left arm.', 'La douleur descend dans mon bras gauche.')],
  witnessed_vf: [L('I feel strange... my heart is jumping.', 'Je me sens bizarre... mon cœur saute.')],
  opioid_pea: [L('So... sleepy...', 'Tellement... sommeil...')],
  obese_rsi: [L('I am a bit nervous... will I wake up afterwards?', 'Je suis un peu stressé... je vais bien me réveiller ?')],
  cico: [L('I am nervous about the anaesthetic.', 'L\'anesthésie me fait un peu peur.')],
  hemorrhage: [L('My leg... I feel faint... so cold.', 'Ma jambe... je me sens partir... j\'ai si froid.'), L('Am I losing a lot of blood?', 'Je perds beaucoup de sang ?')],
  tension_ptx: [L('My chest hurts on one side... I can\'t get my breath.', 'J\'ai mal d\'un côté de la poitrine... je n\'arrive pas à respirer.')],
  echo_hypovolaemia: [L('I feel dizzy when I sit up.', 'J\'ai la tête qui tourne quand je m\'assois.')],
  echo_lv_failure: [L('I get so breathless... my hands are freezing.', 'Je suis tellement essoufflé... j\'ai les mains glacées.')],
  echo_tamponade: [L('My heart is racing and I feel so weak.', 'Mon cœur s\'emballe et je me sens si faible.')],
  echo_rv: [L('It came on suddenly... I can\'t catch my breath.', 'C\'est venu d\'un coup... je n\'arrive pas à reprendre mon souffle.')],
  inf_pyelo: [L('My back hurts on the side... and I keep shivering.', 'J\'ai mal dans le dos sur le côté... et je n\'arrête pas de grelotter.')],
  inf_cap: [L('I have been coughing for days... it hurts to breathe in.', 'Je tousse depuis des jours... ça fait mal quand j\'inspire.')],
  inf_sab: [L('I feel awful... the line in my neck is sore.', 'Je me sens très mal... le cathéter dans mon cou me fait mal.')],
  inf_esbl: [L('It burns when I pass water... I feel terrible.', 'Ça brûle quand j\'urine... je me sens très mal.')],
  anaphylaxis: [L('My throat feels tight... I am itching all over.', 'J\'ai la gorge qui serre... ça me gratte partout.')],
  last_block: [L('I have a metal taste... my lips are tingling.', 'J\'ai un goût de métal... mes lèvres fourmillent.'), L('My ears are ringing...', 'J\'ai les oreilles qui sifflent...')],
  heart_block: [L('I feel dizzy... like I am going to pass out.', 'J\'ai la tête qui tourne... comme si j\'allais tomber dans les pommes.')],
  mobitz_brady: [L('I keep feeling faint.', 'J\'ai l\'impression de m\'évanouir.')],
  torsades: [L('I feel faint... my heart is fluttering.', 'Je me sens mal... mon cœur papillonne.')],
  svt: [L('My heart is racing... it started all of a sudden.', 'Mon cœur bat à toute vitesse... c\'est venu d\'un coup.')],
  dka: [L('I am so thirsty... my stomach hurts.', 'J\'ai tellement soif... j\'ai mal au ventre.')],
  copd_exacerbation: [L('Can\'t... get my breath... worse than usual.', 'Je n\'arrive pas... à respirer... pire que d\'habitude.')],
  hyperkalaemia: [L('My legs feel so weak.', 'J\'ai les jambes toutes faibles.')],
  hypoglycaemia: [L('I feel shaky... and sweaty...', 'Je tremble... je transpire...')],
  hyponatraemia: [L('My head hurts... I feel sick.', 'J\'ai mal à la tête... j\'ai la nausée.')],
  pulmonary_oedema: [L('I feel like I am drowning... I can\'t lie flat.', 'J\'ai l\'impression de me noyer... je ne peux pas rester allongé.')],
  hypertensive_emergency: [L('Terrible headache... my vision is blurred.', 'Un mal de tête terrible... je vois flou.')],
  variceal_bleed: [L('I have been vomiting blood...', 'J\'ai vomi du sang...')],
  spinal_hypotension: [L('I feel sick... and dizzy.', 'J\'ai envie de vomir... et la tête qui tourne.')],
  high_spinal: [L('My hands are tingling... it is hard to breathe.', 'Mes mains fourmillent... j\'ai du mal à respirer.')],
  pacu_ponv: [L('I feel sick... and I am freezing.', 'J\'ai la nausée... et je suis gelé.')],
  mh_crisis: [L('So hot...', 'J\'ai si chaud...')],
  status_epilepticus: [L('What... happened?', 'Qu\'est-ce... qui s\'est passé ?')],
});

/** Cases whose words are not about being unwell (a patient waiting for the anaesthetic): said whatever the vital signs. */
const CALM = new Set(['obese_rsi', 'cico']);

/** What the patient would say now: { key, i, text: {en, fr} } or null when they cannot speak. n: how many lines said so far
 *  (picks among the variants in turn); sc: scores(p). */
export function patientLine(p, scenarioId, n = 0, sc = null) {
  if (!p || p.arrest?.arrested) return null;
  const aw = p.airway || {}; if (aw.intubated || aw.device === 'ett' || aw.device === 'sga') return null;
  if (p.crises?.seizure || p.crises?.se?.active) return null;
  if (!sc) return null;
  const gcs = sc.gcs; if (gcs == null || gcs <= 8) return null;           // paralysed (not assessable) or unconscious
  const rr = p.resp?.rr ?? 14, sat = (p.resp?.sao2 ?? 1) * 100;
  if (rr < 6) return null;
  const pick = (key) => { const l = LINES[key]; if (!l?.length) return null; const i = n % l.length; return { key, i, text: l[i] }; };
  if (gcs <= 12) return pick('confused');
  if (sat < 85 || rr >= 30) return pick('breathless');
  const m = p.monitor || {}, ok = (sc.news2 != null ? sc.news2 <= 2 : sat >= 94 && rr <= 20) && (m.sbp == null || m.sbp >= 100) && (m.hr == null || (m.hr >= 50 && m.hr <= 110));
  if (ok && !CALM.has(scenarioId)) return scenarioId && LINES[scenarioId] && n > 0 ? pick('better') : null;   // back to normal: relief, once something has been said
  return LINES[scenarioId] ? pick(scenarioId) : null;
}

/** When to speak: say() returns the line to say now, or null. Keeps its own state; reset at each case. */
export class Speaker {
  constructor() { this.reset(); }
  reset() { this.n = 0; this.key = null; this.lastT = -1e9; }
  say(p, scenarioId, sc) {
    if (!p || p.t < FIRST_S) return null;
    const l = patientLine(p, scenarioId, this.n, sc); if (!l) { this.key = null; return null; }
    const since = p.t - this.lastT, changed = l.key !== this.key;
    if ((changed && since >= GAP_S) || since >= REPEAT_S) { this.key = l.key; this.lastT = p.t; this.n++; return l; }
    return null;
  }
}

/** What the stethoscope hears over the chest: { breath: { R, L } (0..1 loudness of each lung), rr, ti (s of inspiration),
 *  wheeze (0..1), crackles (0..1), heart: { hr, amp (0..1) } | null }. findings: the engine's exam.chest result. */
export function auscultation(p, findings = []) {
  const f = new Set(findings), side = (s) => (f.has('breath_sounds_absent_' + s) ? 0 : f.has('breath_sounds_reduced_' + s) ? 0.35 : 1);
  const vented = p.vent?.mode === 'ctrl', rr = vented ? (p.vent.rate || 0) : (p.resp?.rr || 0);
  const moving = rr >= 1 && (vented || !p.arrest?.arrested);
  const T = rr > 0 ? 60 / rr : 0;
  const hr = p.monitor?.hr ?? p.circ?.hr ?? 0, perf = !p.arrest?.arrested && hr > 20;
  return {
    breath: moving ? { R: side('R'), L: side('L') } : { R: 0, L: 0 }, rr: moving ? rr : 0, ti: moving ? clamp(T * 0.38, 0.6, 2.2) : 0,
    wheeze: moving ? clamp(p.crises?.br ?? 0, 0, 1) : 0, crackles: moving ? clamp((p.oedema ?? 0) * 1.3, 0, 1) : 0,
    heart: perf ? { hr: clamp(hr, 20, 220), amp: clamp(1 - (p.peri?.volume ?? 0) / 500, 0.2, 1) } : null,
  };
}
