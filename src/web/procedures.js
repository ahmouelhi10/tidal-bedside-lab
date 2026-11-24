// Guided procedures: each clinical gesture broken into the real steps of its démarche (preparation, checks, the act, confirmation).
// A step dispatches ordinary engine events (so the physiology reacts and replays stay deterministic) plus a `note` that records
// the step in the event log. Steps that have no engine event of their own play a generic hand gesture (Gestures.startStep).
//
// Step fields:
//   id, en/fr (label), why: {en, fr} (teaching point shown while the step is current),
//   cam: camera preset to frame, g: generic gesture kind ('touch' | 'swab' | 'scalpel' | 'mask' | 'pads') at site `at`,
//   run(ctx) -> engine events to dispatch (ctx: { p, b, prm }), wait: { after: stepId, s, en, fr } minimum simulated time,
//   check(ctx) -> null | { en, fr } warning shown when the step is performed in a poor state (it is still allowed),
//   ready(ctx) -> null | { en, fr } live condition (e.g. paralysis level); doing the step before it is met counts as early.

const r5 = (x) => Math.max(5, Math.round(x / 5) * 5);
/** live readiness: null when the relaxant has worked, otherwise what the monitor shows */
/** what the bronchoscope shows about the tube tip */
const tipText = (p) => {
  const d = p.tube.tipAboveCarina; if (d == null) return { en: 'No tracheal tube', fr: 'Pas de sonde trachéale' };
  if (p.tube.mainstem) return { en: `No carina: the tip is ${-d} cm past it, in the right main bronchus (tube at ${p.tube.depth} cm)`, fr: `Pas de carène : le bout est ${-d} cm au-delà, dans la bronche souche droite (sonde à ${p.tube.depth} cm)` };
  return { en: `Carina ${d} cm below the tip (tube at ${p.tube.depth} cm)${d > 6 ? ': too high' : d < 2 ? ': too close' : ''}`, fr: `Carène ${d} cm sous le bout (sonde à ${p.tube.depth} cm)${d > 6 ? ' : trop haut' : d < 2 ? ' : trop près' : ''}` };
};
const NOT_RELAXED =({ p }) => { if (p.arrest.arrested) return null; const n = p.drugs.effects({ inArrest: false }).nmb; return n > 0.9 ? null : { en: `Not fully paralysed yet (block ${Math.round(n * 100)} %)`, fr: `Curarisation incomplète (bloc ${Math.round(n * 100)} %)` }; };
const TUBE_GOING = ({ p }) => (p.airway.intubating ? { en: 'The tube is still going in: wait for the end of the attempt', fr: 'La sonde est en cours de passage : attendez la fin de la tentative' } : null);   // confirming during the attempt would read as a failed one

export const PROCEDURES = [
  {
    id: 'rsi', icon: 'airway', cam: 'head',
    en: 'Rapid-sequence intubation', fr: 'Intubation en séquence rapide',
    steps: [
      { id: 'prep', cam: 'head', g: 'touch', at: 'face', en: 'Prepare team, drugs and equipment (checklist)', fr: 'Préparer équipe, médicaments et matériel (check-list)',
        why: { en: 'Roles allocated, suction on, two laryngoscopes, tubes 7.0/7.5 with bougie, supraglottic device and front-of-neck kit ready. Say plan A, B, C out loud.', fr: "Rôles attribués, aspiration branchée, deux laryngoscopes, sondes 7,0/7,5 et bougie, dispositif supraglottique et kit d'abord du cou prêts. Annoncer à voix haute les plans A, B, C." } },
      { id: 'monitor', cam: 'chest', g: 'pads', at: 'chest', en: 'Monitoring: ECG, SpO2, NIBP, capnography', fr: 'Monitorage : ECG, SpO2, PNI, capnographie',
        why: { en: 'Full monitoring before induction; capnography is mandatory to confirm the tube.', fr: "Monitorage complet avant l'induction ; la capnographie est obligatoire pour confirmer la sonde." },
        run: () => [{ type: 'monitor.attach', items: { ecgLeads: true, spo2Probe: true, nibp: true, capnography: true } }, { type: 'nibp.cycle' }] },
      { id: 'iv', cam: 'arm', en: 'Secure IV access', fr: 'Poser une voie veineuse',
        why: { en: 'A working cannula (flushed) is required before any induction drug.', fr: "Un cathéter fonctionnel (rincé) est indispensable avant toute drogue d'induction." },
        run: () => [{ type: 'iv.access' }] },
      { id: 'position', cam: 'head', g: 'touch', at: 'face', en: 'Position: ramped, head-up 25-30°', fr: 'Position : rampe, proclive 25-30°',
        why: { en: 'Ear canal level with the sternal notch. Head-up prolongs safe apnoea time, above all in the obese.', fr: "Conduit auditif au niveau de la fourchette sternale. Le proclive allonge l'apnée tolérée, surtout chez l'obèse." },
        run: () => [{ type: 'position.set', headUp: true }] },
      { id: 'preox', cam: 'head', g: 'mask', at: 'face', en: 'Pre-oxygenate: tight mask, FiO2 1.0, 3 min', fr: 'Préoxygéner : masque étanche, FiO2 1,0, 3 min',
        why: { en: 'Tight seal, 15 L/min, 3 minutes of tidal breathing (or 8 vital-capacity breaths). Target FeO2 ≥ 0.9.', fr: 'Masque étanche, 15 L/min, 3 minutes en volume courant (ou 8 capacités vitales). Objectif FeO2 ≥ 0,9.' },
        run: () => [{ type: 'o2.mask', fio2: 1.0, seal: 0.97 }] },
      { id: 'apox', cam: 'head', g: 'touch', at: 'face', en: 'Apnoeic oxygenation: nasal cannula 15 L/min', fr: 'Oxygénation apnéique : lunettes 15 L/min',
        why: { en: 'Left on through laryngoscopy, it slows desaturation during apnoea.', fr: "Laissées en place pendant la laryngoscopie, elles ralentissent la désaturation pendant l'apnée." },
        run: () => [{ type: 'apox.set', on: true, fio2: 1, eff: 0.5 }] },
      { id: 'induce', cam: 'arm', en: 'Induction: ketamine 1.5 mg/kg (lean mass)', fr: 'Induction : kétamine 1,5 mg/kg (masse maigre)',
        why: { en: 'Haemodynamically stable hypnotic, dosed on lean body mass. Push fast, flush.', fr: 'Hypnotique stable sur le plan hémodynamique, dosé sur la masse maigre. Injection rapide, rinçage.' },
        wait: { after: 'preox', s: 180, en: 'Pre-oxygenation should last 3 min', fr: 'La préoxygénation doit durer 3 min' },
        check: ({ p }) => (p.flags.ivAccess ? null : { en: 'No IV access: the drug cannot be given', fr: 'Pas de voie veineuse : la drogue ne peut pas passer' }),
        run: ({ b }) => [{ type: 'drug.bolus', drug: 'ketamine', amount: r5(1.5 * b.lbm) }] },
      { id: 'nmb', cam: 'arm', en: 'Paralysis: rocuronium 1.2 mg/kg (ideal weight)', fr: 'Curarisation : rocuronium 1,2 mg/kg (poids idéal)',
        why: { en: 'High-dose rocuronium gives intubating conditions in about 60 s; sugammadex can reverse it.', fr: 'Le rocuronium à forte dose donne de bonnes conditions en 60 s environ ; le sugammadex peut le lever.' },
        run: ({ b }) => [{ type: 'drug.bolus', drug: 'rocuronium', amount: r5(1.2 * b.ibw) }] },
      { id: 'wait', cam: 'head', g: 'touch', at: 'face', en: 'Wait for full paralysis (train-of-four 0), no bagging', fr: 'Attendre la curarisation complète (TOF 0), sans ventiler',
        why: { en: 'Keep the mask sealed, do not bag unless SpO2 falls. Onset is slower with a low dose, in the elderly and in low cardiac output.', fr: "Garder le masque étanche, ne pas ventiler sauf si la SpO2 chute. L'installation est plus lente à faible dose, chez le sujet âgé et en bas débit." },
        ready: NOT_RELAXED },
      { id: 'laryngo', cam: 'head', en: 'Laryngoscopy and tube through the cords', fr: 'Laryngoscopie et passage de la sonde entre les cordes',
        why: { en: 'Best first attempt: blade in the vallecula, lift along the handle, bougie if needed, watch the tube pass the cords.', fr: "Meilleure première tentative : lame dans la vallécule, traction dans l'axe du manche, bougie si besoin, voir la sonde passer les cordes." },
        ready: NOT_RELAXED,
        run: () => [{ type: 'airway.intubate' }] },
      { id: 'confirm', cam: 'chest', en: 'Inflate cuff, confirm with EtCO2 waveform', fr: 'Gonfler le ballonnet, confirmer par la courbe de EtCO2',
        why: { en: 'Sustained capnography waveform on 6 breaths, bilateral chest rise and breath sounds. No trace = wrong place.', fr: "Courbe de capnographie persistante sur 6 cycles, soulèvement et murmure bilatéraux. Pas de trace = sonde mal placée." },
        ready: TUBE_GOING,
        check: ({ p }) => (p.airway.intubated || p.airway.intubating ? null : { en: 'The tube is not in the trachea yet', fr: "La sonde n'est pas encore dans la trachée" }),
        run: () => [{ type: 'monitor.attach', items: { capnography: true } }, { type: 'exam.chest' }] },
      { id: 'vent', cam: 'head', en: 'Ventilate: 6 mL/kg PBW, 14/min, PEEP 5', fr: 'Ventiler : 6 mL/kg poids prédit, 14/min, PEP 5',
        why: { en: 'Protective settings; then titrate FiO2 to SpO2 94-98 %.', fr: 'Réglages protecteurs ; puis adapter la FiO2 pour une SpO2 de 94-98 %.' },
        run: ({ b }) => [{ type: 'vent.set', settings: { mode: 'ctrl', rate: 14, vt: Math.round(6 * b.pbw), fio2: 1, peep: 5, seal: 0.97 } }] },
      { id: 'sedation', cam: 'arm', en: 'Secure tube, start sedation (propofol 3 mg/kg/h)', fr: 'Fixer la sonde, débuter la sédation (propofol 3 mg/kg/h)',
        why: { en: 'Note the depth at the teeth, tie the tube, chest X-ray, and never leave a paralysed patient awake.', fr: 'Noter le repère aux dents, fixer la sonde, radiographie, et ne jamais laisser un patient curarisé conscient.' },
        run: ({ b }) => [{ type: 'drug.infusion', drug: 'propofol', rate: (3 * b.weightKg) / 60 }] },
    ],
  },
  {
    id: 'defib', icon: 'cpr', cam: 'chest',
    en: 'Cardiac arrest: CPR and safe defibrillation', fr: 'Arrêt cardiaque : RCP et défibrillation en sécurité',
    steps: [
      { id: 'check', cam: 'neck', g: 'touch', at: 'neck', en: 'Check response, breathing and carotid pulse (≤ 10 s)', fr: 'Vérifier conscience, respiration et pouls carotidien (≤ 10 s)',
        why: { en: 'No more than 10 seconds. Agonal gasps are not breathing.', fr: "Pas plus de 10 secondes. Les gasps ne sont pas une respiration." },
        msg: ({ p }) => (p.pulse ? { en: 'Pulse present', fr: 'Pouls présent' } : { en: 'No pulse: cardiac arrest', fr: 'Pas de pouls : arrêt cardiaque' }) },
      { id: 'help', cam: 'default', en: 'Call for help and the crash cart', fr: "Appeler à l'aide et faire venir le chariot",
        run: () => [{ type: 'order', what: 'call_help' }] },
      { id: 'cpr', cam: 'chest', en: 'Start compressions 30:2 (100-120/min, 5-6 cm)', fr: 'Débuter les compressions 30:2 (100-120/min, 5-6 cm)',
        why: { en: 'Hard surface, full recoil, minimal pauses (compression fraction > 60 %).', fr: 'Plan dur, relâchement complet, pauses minimales (fraction de compression > 60 %).' },
        run: () => [{ type: 'cpr.start', mode: 'auto', opts: { rate: 110, depth: 5.5, ratio: '30:2' }, surface: 'hard' }] },
      { id: 'pads', cam: 'chest', g: 'pads', at: 'chest', en: 'Apply pads without stopping CPR', fr: 'Coller les électrodes sans interrompre la RCP',
        why: { en: 'Right pad below the right clavicle, left pad at the apex (mid-axillary line).', fr: "Électrode droite sous la clavicule droite, gauche à l'apex (ligne axillaire moyenne)." },
        run: () => [{ type: 'defib.pads' }, { type: 'monitor.attach', items: { ecgLeads: true } }] },
      { id: 'rhythm', cam: 'default', en: 'Pause ≤ 5 s: analyse the rhythm', fr: 'Pause ≤ 5 s : analyser le rythme',
        why: { en: 'VF or pulseless VT = shockable. PEA or asystole = not shockable (CPR + epinephrine, look for the cause).', fr: 'FV ou TV sans pouls = choquable. AESP ou asystolie = non choquable (RCP + adrénaline, chercher la cause).' },
        msg: ({ p }) => { const k = p.arrest.key, sh = ['VF', 'VT_PULSELESS', 'TORSADES'].includes(k); return { en: `Rhythm: ${k} - ${sh ? 'shockable' : 'not shockable'}`, fr: `Rythme : ${k} - ${sh ? 'choquable' : 'non choquable'}` }; } },
      { id: 'charge', cam: 'default', en: 'Resume CPR and charge 200 J', fr: 'Reprendre la RCP et charger à 200 J',
        why: { en: 'Charge while compressions continue: the hands-off time is only the shock itself.', fr: 'Charger pendant les compressions : la seule pause est le choc lui-même.' },
        run: () => [{ type: 'defib.setEnergy', energy: 200 }, { type: 'defib.charge' }] },
      { id: 'clear', cam: 'default', en: '"Stand clear, oxygen away" - check everyone', fr: '« Écartez-vous, oxygène retiré » - vérifier tout le monde',
        why: { en: 'Look from head to toe: nobody touching the patient or the bed, oxygen source 1 m away.', fr: "Regarder de la tête aux pieds : personne ne touche le patient ni le lit, oxygène à 1 m." },
        run: () => [{ type: 'cpr.stop' }] },
      { id: 'shock', cam: 'chest', en: 'Shock', fr: 'Choquer',
        check: ({ p }) => (p.defib.charged ? null : { en: 'The defibrillator is not charged yet', fr: "Le défibrillateur n'est pas encore chargé" }),
        ready: ({ p }) => (p.defib.charged ? null : p.defib.chargeAt !== null && p.defib.chargeAt > p.t ? { en: 'Charging... wait for the ready tone', fr: 'Charge en cours... attendez le signal' } : { en: 'Not charged: charge first', fr: "Non chargé : chargez d'abord" }),   // live: shocking before the charge is complete counts as early
        run: () => [{ type: 'defib.shock' }] },
      { id: 'resume', cam: 'chest', en: 'Resume CPR immediately for 2 min', fr: 'Reprendre immédiatement la RCP pendant 2 min',
        why: { en: 'Do not check the pulse after the shock: compress straight away.', fr: 'Ne pas chercher le pouls après le choc : comprimer tout de suite.' },
        run: () => [{ type: 'cpr.start', mode: 'auto', opts: { rate: 110, depth: 5.5, ratio: '30:2' }, surface: 'hard' }] },
      { id: 'access', cam: 'arm', en: 'IV access during CPR (intraosseous if it fails)', fr: 'Voie veineuse pendant la RCP (intra-osseuse en cas d’échec)',
        why: { en: 'Placed by a second rescuer without stopping compressions; go intraosseous if the vein is not in quickly.', fr: 'Posée par un second intervenant sans interrompre les compressions ; passer en intra-osseux si la veine ne vient pas vite.' },
        run: ({ p }) => (p.flags.ivAccess ? [] : [{ type: 'iv.access' }]) },
      { id: 'drugs', cam: 'arm', en: 'Epinephrine 1 mg IV (after the 2nd shock), every 3-5 min', fr: 'Adrénaline 1 mg IV (après le 2e choc), toutes les 3-5 min',
        why: { en: 'Amiodarone 300 mg after the 3rd shock. Treat reversible causes (4 H, 4 T).', fr: "Amiodarone 300 mg après le 3e choc. Traiter les causes réversibles (4 H, 4 T)." },
        check: ({ p }) => (p.flags.ivAccess ? null : { en: 'No IV access', fr: 'Pas de voie veineuse' }),
        run: () => [{ type: 'drug.bolus', drug: 'epinephrine', amount: 1000 }] },
    ],
  },
  {
    id: 'needle', icon: 'proc', cam: 'chest', params: ['side', 'site', 'needleMm'],
    en: 'Needle decompression (tension pneumothorax)', fr: 'Exsufflation à l\'aiguille (pneumothorax sous tension)',
    steps: [
      { id: 'exam', cam: 'chest', en: 'Examine the chest: movement, percussion, breath sounds', fr: 'Examiner le thorax : ampliation, percussion, auscultation',
        why: { en: 'Reduced movement, hyperresonance and absent breath sounds on one side, with falling BP and SpO2.', fr: "Ampliation diminuée, tympanisme et murmure aboli d'un côté, avec PA et SpO2 qui chutent." },
        run: () => [{ type: 'exam.chest' }] },
      { id: 'pocus', cam: 'chest', en: 'Lung ultrasound: look for lung sliding', fr: 'Échographie pleurale : chercher le glissement',
        why: { en: 'Absent sliding (barcode sign) supports the side; it also measures the chest-wall thickness.', fr: "L'absence de glissement (signe du code-barres) confirme le côté ; elle mesure aussi l'épaisseur de la paroi." },
        run: () => [{ type: 'exam.pocus' }] },
      { id: 'site', cam: 'chest', g: 'swab', at: 'chestSite', en: 'Locate the site and disinfect', fr: 'Repérer le site et désinfecter',
        why: { en: '5th intercostal space, anterior-to-mid axillary line, or 2nd space mid-clavicular. Stay above the rib.', fr: "5e espace intercostal, ligne axillaire antérieure à moyenne, ou 2e espace médio-claviculaire. Passer au bord supérieur de la côte." } },
      { id: 'insert', cam: 'chest', en: 'Insert the catheter, listen for the hiss', fr: "Introduire le cathéter, écouter le sifflement",
        why: { en: 'A 5 cm catheter fails in about one adult in three; prefer 7-8 cm, especially when BMI is high.', fr: "Un cathéter de 5 cm échoue chez environ un adulte sur trois ; préférer 7-8 cm, surtout si l'IMC est élevé." },
        run: ({ prm }) => [{ type: 'procedure.needle_decompression', side: prm.side, site: prm.site, needleMm: prm.needleMm }] },
      { id: 'reassess', cam: 'chest', en: 'Reassess: SpO2, BP, breath sounds', fr: 'Réévaluer : SpO2, PA, auscultation',
        run: () => [{ type: 'exam.chest' }] },
      { id: 'plan', cam: 'default', en: 'Plan a chest drain (the needle is only a bridge)', fr: "Prévoir un drain thoracique (l'aiguille n'est qu'un relais)",
        why: { en: 'A catheter can kink or block and the tension comes back.', fr: 'Un cathéter peut se couder ou se boucher et la tension revient.' } },
    ],
  },
  {
    id: 'drain', icon: 'proc', cam: 'chest', params: ['side', 'fr'],
    en: 'Chest drain (thoracostomy)', fr: 'Drain thoracique (thoracostomie)',
    steps: [
      { id: 'analgesia', cam: 'arm', en: 'Analgesia: fentanyl 1 mcg/kg, local anaesthetic', fr: 'Analgésie : fentanyl 1 µg/kg, anesthésie locale',
        why: { en: 'Infiltrate skin, periosteum and pleura (lidocaine up to 3 mg/kg).', fr: "Infiltrer la peau, le périoste et la plèvre (lidocaïne jusqu'à 3 mg/kg)." },
        check: ({ p }) => (p.flags.ivAccess ? null : { en: 'No IV access', fr: 'Pas de voie veineuse' }),
        run: ({ b }) => [{ type: 'drug.bolus', drug: 'fentanyl', amount: Math.max(25, Math.round(b.lbm / 25) * 25) }] },
      { id: 'position', cam: 'chest', g: 'touch', at: 'chestSite', en: 'Position: arm abducted behind the head', fr: 'Position : bras en abduction derrière la tête',
        why: { en: 'Opens the safe triangle.', fr: 'Ouvre le triangle de sécurité.' } },
      { id: 'site', cam: 'chest', g: 'swab', at: 'chestSite', en: 'Safe triangle, 5th space: disinfect and drape', fr: 'Triangle de sécurité, 5e espace : désinfecter et champer',
        why: { en: 'Bordered by pectoralis major, latissimus dorsi and the line of the nipple. Full asepsis.', fr: 'Limité par le grand pectoral, le grand dorsal et la ligne mamelonnaire. Asepsie complète.' } },
      { id: 'incise', cam: 'chest', g: 'scalpel', at: 'chestSite', en: 'Incise 3-4 cm, blunt dissection over the rib', fr: 'Inciser 3-4 cm, dissection mousse au bord supérieur de la côte',
        why: { en: 'Above the rib to spare the neurovascular bundle. Finger sweep into the pleura before the tube.', fr: 'Au bord supérieur de la côte pour épargner le paquet vasculo-nerveux. Exploration au doigt de la plèvre avant la sonde.' } },
      { id: 'insert', cam: 'chest', en: 'Insert the drain and direct it apically', fr: 'Introduire le drain et le diriger vers l\'apex',
        run: ({ prm }) => [{ type: 'procedure.chest_tube', side: prm.side, fr: prm.fr }] },
      { id: 'seal', cam: 'chest', g: 'touch', at: 'chestSite', en: 'Connect underwater seal: swinging and bubbling', fr: 'Raccorder au bocal sous eau : oscillation et bullage',
        why: { en: 'The fluid level should swing with breathing; bubbling means air is still leaving.', fr: "Le niveau doit osciller avec la respiration ; le bullage signifie que l'air s'évacue encore." } },
      { id: 'secure', cam: 'default', en: 'Suture, dressing, chest X-ray', fr: 'Suturer, pansement, radiographie de thorax',
        run: () => [{ type: 'exam.chest' }] },
    ],
  },
  {
    id: 'fona', icon: 'proc', cam: 'neck', params: ['technique', 'approach'],
    en: 'Front-of-neck access (scalpel-bougie-tube)', fr: 'Abord trachéal (bistouri-bougie-sonde)',
    steps: [
      { id: 'declare', cam: 'default', en: 'Declare "can\'t intubate, can\'t oxygenate"', fr: '« Ni intubation, ni oxygénation » : le déclarer',
        why: { en: 'Say it out loud, call for help, get the front-of-neck kit.', fr: "Le dire à voix haute, appeler à l'aide, prendre le kit d'abord du cou." },
        run: () => [{ type: 'order', what: 'declare_cico' }, { type: 'order', what: 'call_help' }] },
      { id: 'oxygen', cam: 'head', g: 'mask', at: 'face', en: 'Keep 100 % oxygen on the upper airway', fr: 'Maintenir l\'oxygène à 100 % par les voies hautes',
        run: () => [{ type: 'o2.mask', fio2: 1.0, seal: 0.97 }] },
      { id: 'extend', cam: 'neck', g: 'touch', at: 'neck', en: 'Extend the neck (flat, shoulder roll)', fr: 'Mettre le cou en extension (à plat, billot sous les épaules)',
        run: () => [{ type: 'position.set', headUp: false }] },
      { id: 'identify', cam: 'neck', en: 'Laryngeal handshake: find the cricothyroid membrane', fr: 'Repérer la membrane cricothyroïdienne (« poignée de main » laryngée)',
        why: { en: 'If it cannot be felt, make an 8-10 cm vertical midline incision and dissect bluntly.', fr: "Si elle n'est pas palpable, incision verticale médiane de 8-10 cm et dissection mousse." },
        run: () => [{ type: 'exam.neck', method: 'palpation' }] },
      { id: 'incise', cam: 'neck', g: 'scalpel', at: 'neck', en: 'Transverse stab incision, rotate the blade 90°', fr: 'Incision transversale, rotation de la lame de 90°',
        why: { en: 'Size 10 blade, sharp edge towards you, then turn it so the edge points caudally.', fr: 'Lame de 10, tranchant vers soi, puis rotation pour orienter le tranchant vers les pieds.' } },
      { id: 'tube', cam: 'neck', en: 'Bougie along the blade, then a 6.0 cuffed tube', fr: 'Bougie le long de la lame, puis sonde à ballonnet 6,0',
        run: ({ prm }) => [{ type: 'procedure.cricothyroidotomy', technique: prm.technique, approach: prm.approach }] },
      { id: 'confirm', cam: 'head', en: 'Ventilate and confirm with capnography', fr: 'Ventiler et confirmer par capnographie',
        ready: TUBE_GOING,
        run: ({ b }) => [{ type: 'monitor.attach', items: { capnography: true } }, { type: 'vent.set', settings: { mode: 'ctrl', rate: 12, vt: Math.round(6 * b.pbw), fio2: 1, peep: 5, seal: 0.97 } }] },
    ],
  },
  {
    id: 'bronch', icon: 'airway', cam: 'head',
    en: 'Bronchoscopy through the tube (tube check)', fr: 'Fibroscopie par la sonde (contrôle de sonde)',
    steps: [
      { id: 'fio2', cam: 'head', en: 'FiO2 1.0 on the ventilator first', fr: "FiO2 1,0 sur le respirateur d'abord",
        why: { en: 'A ventilated patient who desaturates: give oxygen before anything else. The scope will also take part of the tube lumen.', fr: "Patient ventilé qui désature : l'oxygène d'abord. Le fibroscope va aussi occuper une partie de la lumière de la sonde." },
        run: () => [{ type: 'vent.set', settings: { fio2: 1 } }] },
      { id: 'dope', cam: 'chest', en: 'DOPE: listen to both lungs', fr: 'DOPE : ausculter les deux poumons',
        why: { en: 'Displacement, Obstruction, Pneumothorax, Equipment. A silent left chest with a tube that slid in points to the right main bronchus.', fr: "Déplacement, Obstruction, Pneumothorax, Équipement. Un hémithorax gauche muet après un transfert évoque une sonde dans la bronche souche droite." },
        run: () => [{ type: 'exam.chest' }] },
      { id: 'capno', cam: 'chest', en: 'Capnography on, scope through the swivel connector', fr: 'Capnographie en place, fibroscope par le raccord annelé',
        why: { en: 'Keep ventilating and watching EtCO2 while the scope is in.', fr: "Continuer à ventiler et surveiller l'EtCO2 pendant que le fibroscope est en place." },
        run: () => [{ type: 'monitor.attach', items: { capnography: true } }] },
      { id: 'insert', cam: 'head', scope: 'open', en: 'Scope in: find the carina at the tube tip', fr: 'Introduire le fibroscope : chercher la carène au bout de la sonde',
        why: { en: 'Normal: the carina is seen 2-6 cm beyond the tube tip. Too deep: no carina, only one bronchus (usually the right, with its upper lobe opening).', fr: "Normal : la carène se voit 2 à 6 cm au-delà du bout de la sonde. Trop profond : pas de carène, une seule bronche (souvent la droite, avec l'orifice du lobe supérieur)." },
        run: () => [{ type: 'bronch.insert' }],
        msg: ({ p }) => tipText(p) },
      { id: 'pull', cam: 'head', en: 'Pull the tube back while looking (0.1 × height + 4 cm)', fr: 'Retirer la sonde sous contrôle de la vue (0,1 × taille + 4 cm)',
        why: { en: 'Deflate the cuff, pull the tube back over the scope until the carina comes into view 2-6 cm below the tip, re-inflate.', fr: "Dégonfler le ballonnet, retirer la sonde sur le fibroscope jusqu'à voir la carène 2 à 6 cm sous son extrémité, regonfler." },
        check: ({ p }) => (p.tube.scopeIn ? null : { en: 'The scope is out: move the tube only while looking', fr: 'Le fibroscope est retiré : ne déplacer la sonde que sous contrôle de la vue' }),
        run: ({ p }) => { const cm = Math.max(-5, Math.min(5, p.tube.optimalDepth - p.tube.depth)); return cm ? [{ type: 'airway.tube_adjust', cm }] : []; },
        msg: ({ p }) => tipText(p) },
      { id: 'suction', cam: 'head', en: 'Aspirate the secretions: right bronchi, then trachea', fr: 'Aspirer les sécrétions : bronches droites, puis trachée',
        why: { en: 'Short suction passes: each one de-recruits the lung a little.', fr: 'Aspirations brèves : chacune dérecrute un peu le poumon.' },
        check: ({ p }) => (p.tube.scopeIn ? null : { en: 'Suction needs the scope in the tube', fr: "L'aspiration se fait par le fibroscope" }),
        run: () => [{ type: 'bronch.suction', where: 'R' }, { type: 'bronch.suction', where: 'trachea' }] },
      { id: 'remove', cam: 'chest', scope: 'close', en: 'Scope out (under 3 min) and listen again', fr: 'Retirer le fibroscope (moins de 3 min) et réausculter',
        why: { en: 'Both sides should move and sound the same; SpO2 should climb within a minute or two.', fr: "Les deux côtés doivent se soulever et s'entendre de façon symétrique ; la SpO2 doit remonter en une à deux minutes." },
        run: () => [{ type: 'bronch.remove' }, { type: 'exam.chest' }] },
      { id: 'secure', cam: 'head', g: 'touch', at: 'face', en: 'Note the new depth at the teeth and secure the tube', fr: 'Noter le nouveau repère aux dents et fixer la sonde',
        why: { en: 'Write the depth in the chart and re-check it after every move of the patient. Then bring FiO2 down to an SpO2 of 94-98 %.', fr: "Noter le repère dans le dossier et le revérifier après chaque mobilisation. Puis baisser la FiO2 pour une SpO2 de 94 à 98 %." },
        msg: ({ p }) => ({ en: `Tube at ${p.tube.depth} cm at the teeth`, fr: `Sonde à ${p.tube.depth} cm aux dents` }) },
    ],
  },
  {
    id: 'bmv', icon: 'airway', cam: 'head',
    en: 'Bag-mask ventilation', fr: 'Ventilation au masque et au ballon',
    steps: [
      { id: 'help', cam: 'default', en: 'Call for help, oxygen 15 L/min on the bag', fr: "Appeler à l'aide, oxygène 15 L/min sur le ballon",
        why: { en: 'Bag-mask ventilation is a two-person job: one holds the mask with both hands, the other squeezes.', fr: "La ventilation au masque se fait à deux : l'un tient le masque à deux mains, l'autre presse le ballon." },
        run: () => [{ type: 'order', what: 'call_help' }] },
      { id: 'open', cam: 'head', g: 'touch', at: 'face', en: 'Open the airway: head tilt and chin lift', fr: 'Libérer les voies aériennes : bascule de la tête et élévation du menton',
        why: { en: 'Jaw thrust without head tilt if a neck injury is possible.', fr: 'Subluxation de la mâchoire sans bascule si une lésion du rachis cervical est possible.' },
        run: () => [{ type: 'airway.set', device: 'chin_lift' }] },
      { id: 'opa', cam: 'head', g: 'touch', at: 'face', en: 'Oropharyngeal airway, sized incisors to angle of the jaw', fr: "Canule oropharyngée, taille des incisives à l'angle de la mâchoire",
        why: { en: 'Insert it upside down and rotate 180°; stop if the patient gags (use a nasal airway instead).', fr: "L'introduire à l'envers puis la tourner de 180° ; arrêter si le patient a un réflexe nauséeux (canule nasale alors)." },
        run: () => [{ type: 'airway.set', device: 'opa' }] },
      { id: 'seal', cam: 'head', g: 'mask', at: 'face', en: 'Two-hand mask seal (V-E grip), FiO2 1.0', fr: 'Masque tenu à deux mains (prise en V-E), FiO2 1,0',
        why: { en: 'Thumbs and thenar eminences press the mask, the other fingers pull the jaw up into it.', fr: 'Les pouces et les éminences thénar appuient sur le masque, les autres doigts tirent la mâchoire vers lui.' },
        run: () => [{ type: 'o2.mask', fio2: 1, seal: 0.97 }] },
      { id: 'ventilate', cam: 'head', en: 'Gentle breaths over 1 s, one every 6 s', fr: 'Insufflations douces en 1 s, une toutes les 6 s',
        why: { en: 'Just enough to see the chest rise: large, fast breaths inflate the stomach and make the patient vomit.', fr: "Juste assez pour voir le thorax se soulever : des insufflations trop fortes ou trop rapides remplissent l'estomac et font vomir." },
        run: ({ b }) => [{ type: 'vent.set', settings: { mode: 'ctrl', rate: 10, vt: Math.round(6 * b.pbw), fio2: 1, peep: 5, seal: 0.85 } }] },
      { id: 'check', cam: 'chest', en: 'Check chest rise, capnography and SpO2', fr: 'Vérifier le soulèvement du thorax, la capnographie et la SpO2',
        why: { en: 'No chest rise or no EtCO2 trace: reposition the head, re-seat the mask, add a second operator, then consider a supraglottic device.', fr: "Pas de soulèvement ou pas de trace d'EtCO2 : repositionner la tête, replacer le masque, ajouter un second opérateur, puis envisager un dispositif supraglottique." },
        run: () => [{ type: 'monitor.attach', items: { capnography: true, spo2Probe: true } }, { type: 'exam.chest' }] },
    ],
  },
  {
    id: 'lma', icon: 'airway', cam: 'head',
    en: 'Supraglottic airway (laryngeal mask)', fr: 'Dispositif supraglottique (masque laryngé)',
    steps: [
      { id: 'iv', cam: 'arm', en: 'IV access and monitoring', fr: 'Voie veineuse et monitorage',
        run: () => [{ type: 'iv.access' }, { type: 'monitor.attach', items: { ecgLeads: true, spo2Probe: true, nibp: true, capnography: true } }] },
      { id: 'preox', cam: 'head', g: 'mask', at: 'face', en: 'Pre-oxygenate: FiO2 1.0, 3 min', fr: 'Préoxygéner : FiO2 1,0, 3 min',
        run: () => [{ type: 'o2.mask', fio2: 1, seal: 0.97 }] },
      { id: 'size', cam: 'head', en: 'Choose the size (women 3-4, men 4-5), check and lubricate the back', fr: 'Choisir la taille (femme 3-4, homme 4-5), vérifier et lubrifier la face postérieure',
        why: { en: 'Deflate the cuff fully into a smooth spoon shape so the tip does not fold back.', fr: "Dégonfler complètement le ballonnet en forme de cuillère lisse pour que l'extrémité ne se replie pas." } },
      { id: 'deep', cam: 'arm', en: 'Induce: propofol 2.5 mg/kg until the jaw is loose', fr: "Induire : propofol 2,5 mg/kg jusqu'à mâchoire relâchée",
        why: { en: 'Too light and the patient coughs or bites; laryngospasm is the classic complication.', fr: 'Trop léger, le patient tousse ou mord ; le laryngospasme est la complication classique.' },
        wait: { after: 'preox', s: 180, en: 'Pre-oxygenation should last 3 min', fr: 'La préoxygénation doit durer 3 min' },
        run: ({ b }) => [{ type: 'drug.bolus', drug: 'propofol', amount: r5(2.5 * b.lbm) }] },
      { id: 'insert', cam: 'head', g: 'touch', at: 'face', en: 'Slide it along the hard palate until you feel resistance', fr: "Le glisser le long du palais dur jusqu'à sentir une résistance",
        why: { en: 'Index finger at the junction of cuff and tube, pressing up against the palate, in one smooth movement.', fr: "Index à la jonction ballonnet-tube, en appuyant vers le palais, en un seul mouvement." },
        run: () => [{ type: 'airway.set', device: 'sga' }] },
      { id: 'inflate', cam: 'head', g: 'touch', at: 'face', en: 'Inflate the cuff (pressure at most 60 cmH2O)', fr: 'Gonfler le ballonnet (pression 60 cmH2O au plus)',
        why: { en: 'The tube rises slightly as the mask seats itself; over-inflation causes leaks and sore throat.', fr: "Le tube remonte légèrement quand le masque se met en place ; trop gonflé, il fuit et donne des maux de gorge." } },
      { id: 'confirm', cam: 'chest', en: 'Confirm: EtCO2 trace, chest rise, no leak', fr: 'Confirmer : trace EtCO2, soulèvement thoracique, pas de fuite',
        run: () => [{ type: 'monitor.attach', items: { capnography: true } }, { type: 'exam.chest' }] },
      { id: 'vent', cam: 'head', en: 'Gentle ventilation: 6 mL/kg, peak pressure under 20 cmH2O', fr: 'Ventilation douce : 6 mL/kg, pression de crête sous 20 cmH2O',
        why: { en: 'Higher pressures leak around the cuff and into the stomach.', fr: "Au-delà, l'air fuit autour du ballonnet et passe dans l'estomac." },
        run: ({ b }) => [{ type: 'vent.set', settings: { mode: 'ctrl', rate: 12, vt: Math.round(6 * b.pbw), fio2: 1, peep: 5, seal: 0.92 } }] },
    ],
  },
  {
    id: 'aline', icon: 'proc', cam: 'arm',
    en: 'Radial arterial line (ultrasound)', fr: 'Cathéter artériel radial (échoguidé)',
    steps: [
      { id: 'check', cam: 'arm', g: 'touch', at: 'arm', en: 'Choose the wrist: look at radial and ulnar arteries', fr: 'Choisir le poignet : regarder les artères radiale et ulnaire',
        why: { en: 'Non-dominant side if possible. The Allen test predicts ischaemia poorly; ultrasound shows both arteries.', fr: "Côté non dominant si possible. Le test d'Allen prédit mal l'ischémie ; l'échographie montre les deux artères." } },
      { id: 'position', cam: 'arm', g: 'touch', at: 'arm', en: 'Wrist extended 30-45° over a roll, taped', fr: 'Poignet en extension 30-45° sur un rouleau, scotché' },
      { id: 'clean', cam: 'arm', g: 'swab', at: 'arm', en: 'Disinfect, sterile gloves and drape, local anaesthetic', fr: 'Désinfecter, gants et champ stériles, anesthésie locale' },
      { id: 'insert', cam: 'arm', en: 'Puncture under ultrasound at 30-45°: flash, wire, cannula', fr: 'Ponction échoguidée à 30-45° : reflux, guide, cathéter',
        why: { en: 'Keep the needle tip in view all the way to the artery; with a pulsatile flash, flatten and pass the wire.', fr: "Garder la pointe visible jusqu'à l'artère ; au reflux pulsatile, abaisser l'aiguille et passer le guide." },
        run: () => [{ type: 'procedure.arterial_line', us: true }] },
      { id: 'zero', cam: 'arm', en: 'Connect, flush, level at the right atrium and zero the transducer', fr: "Raccorder, purger, mettre à niveau de l'oreillette droite et faire le zéro",
        why: { en: 'Transducer at the phlebostatic axis (4th intercostal space, mid-axillary line), open to air, press zero.', fr: "Capteur à l'axe phlébostatique (4e espace intercostal, ligne axillaire moyenne), ouvert à l'air, faire le zéro." },
        ready: ({ p }) => (p.flags.aline ? null : { en: 'The cannula is not in yet (about 2 min: speed up the clock)', fr: "Le cathéter n'est pas encore en place (environ 2 min : accélérez le temps)" }) },
      { id: 'confirm', cam: 'default', en: 'Compare with the cuff pressure, secure and label', fr: 'Comparer avec la pression au brassard, fixer et étiqueter',
        why: { en: 'A damped trace reads the systolic too low: check for bubbles, kinks and a clot.', fr: 'Une courbe amortie sous-estime la systolique : chercher bulles, coudures et caillot.' },
        run: () => [{ type: 'nibp.cycle' }] },
    ],
  },
  {
    id: 'cvc', icon: 'proc', cam: 'neck',
    en: 'Central venous line (internal jugular, ultrasound)', fr: 'Voie veineuse centrale (jugulaire interne, échoguidée)',
    steps: [
      { id: 'prep', cam: 'default', en: 'Check-list: indication, clotting, kit, assistant', fr: 'Check-list : indication, coagulation, matériel, aide',
        why: { en: 'Ultrasound, sterile cover for the probe, the kit opened and flushed, someone to watch the monitor.', fr: "Échographe, gaine stérile de sonde, kit ouvert et purgé, quelqu'un qui surveille le scope." } },
      { id: 'monitor', cam: 'chest', g: 'pads', at: 'chest', en: 'ECG and SpO2 on', fr: 'ECG et SpO2 en place',
        why: { en: 'The wire can trigger extrasystoles: you need to see the ECG.', fr: 'Le guide peut déclencher des extrasystoles : il faut voir l\'ECG.' },
        run: () => [{ type: 'monitor.attach', items: { ecgLeads: true, spo2Probe: true } }] },
      { id: 'position', cam: 'head', en: 'Head down 10-15°, head turned slightly away', fr: 'Tête basse 10-15°, tête légèrement tournée du côté opposé',
        why: { en: 'Fills the vein and prevents air embolism.', fr: "Remplit la veine et prévient l'embolie gazeuse." },
        run: () => [{ type: 'position.set', headUp: false }] },
      { id: 'asepsis', cam: 'neck', g: 'swab', at: 'neck', en: 'Full sterile barrier: cap, mask, gown, chlorhexidine, large drape', fr: 'Barrière stérile complète : calot, masque, casaque, chlorhexidine, grand champ' },
      { id: 'scan', cam: 'neck', g: 'touch', at: 'neck', en: 'Ultrasound: the jugular is compressible, lateral to the carotid', fr: 'Échographie : la jugulaire est compressible, en dehors de la carotide' },
      { id: 'insert', cam: 'neck', en: 'Needle under real-time ultrasound, wire, dilator, catheter', fr: 'Aiguille sous échographie en temps réel, guide, dilatateur, cathéter',
        why: { en: 'Never let go of the wire. Check the wire is in the vein (ultrasound) before dilating.', fr: "Ne jamais lâcher le guide. Vérifier le guide dans la veine (échographie) avant de dilater." },
        run: () => [{ type: 'procedure.central_line', site: 'ijv', us: true }] },
      { id: 'confirm', cam: 'chest', en: 'Aspirate and flush every lumen, chest X-ray', fr: 'Aspirer et rincer chaque voie, radiographie de thorax',
        why: { en: 'Tip at the cavo-atrial junction, no pneumothorax. Then suture and dressing.', fr: 'Extrémité à la jonction cave-oreillette, pas de pneumothorax. Puis suture et pansement.' },
        ready: ({ p }) => (p.flags.cvc ? null : { en: 'The line is not in yet (about 10 min: speed up the clock)', fr: "La voie n'est pas encore en place (environ 10 min : accélérez le temps)" }),
        run: () => [{ type: 'exam.chest' }] },
    ],
  },
  {
    id: 'ng', icon: 'proc', cam: 'head',
    en: 'Nasogastric tube', fr: 'Sonde nasogastrique',
    steps: [
      { id: 'explain', cam: 'head', en: 'Explain, sit the patient up', fr: 'Expliquer, installer le patient assis',
        run: () => [{ type: 'position.set', headUp: true }] },
      { id: 'measure', cam: 'head', g: 'touch', at: 'face', en: 'Measure nose - ear - xiphoid and mark the tube', fr: 'Mesurer nez - oreille - xiphoïde et marquer la sonde' },
      { id: 'insert', cam: 'head', g: 'touch', at: 'face', en: 'Lubricate, insert along the floor of the nose, ask to swallow', fr: 'Lubrifier, introduire le long du plancher du nez, faire déglutir',
        why: { en: 'Stop and pull back if the patient coughs, cannot speak or desaturates: the tube is in the airway.', fr: "S'arrêter et retirer si le patient tousse, ne peut plus parler ou désature : la sonde est dans les voies aériennes." },
        run: () => [{ type: 'procedure.ng_tube' }] },
      { id: 'confirm', cam: 'head', en: 'Confirm: aspirate pH 5.5 or less, otherwise chest X-ray', fr: 'Confirmer : pH de l’aspiration 5,5 ou moins, sinon radiographie',
        why: { en: 'Listening for air (the "whoosh" test) is not reliable and must not be used.', fr: "L'auscultation d'air insufflé n'est pas fiable et ne doit pas être utilisée." } },
      { id: 'secure', cam: 'head', g: 'touch', at: 'face', en: 'Secure to the nose and note the length at the nostril', fr: 'Fixer au nez et noter le repère à la narine' },
    ],
  },
  {
    id: 'uc', icon: 'proc', cam: 'groin',
    en: 'Urinary catheter', fr: 'Sonde urinaire',
    steps: [
      { id: 'prep', cam: 'groin', g: 'touch', at: 'groin', en: 'Explain, sterile kit, check the balloon', fr: 'Expliquer, kit stérile, vérifier le ballonnet' },
      { id: 'clean', cam: 'groin', g: 'swab', at: 'groin', en: 'Clean the meatus, drape, lidocaine gel', fr: 'Nettoyer le méat, champer, gel de lidocaïne',
        why: { en: 'Wait 3-5 minutes for the gel to work.', fr: "Attendre 3 à 5 minutes que le gel agisse." } },
      { id: 'insert', cam: 'groin', en: 'Insert until urine flows, then 2-3 cm further', fr: "Introduire jusqu'au reflux d'urine, puis 2 à 3 cm de plus",
        why: { en: 'Inflating before urine flows can tear the urethra.', fr: "Gonfler avant le reflux d'urine peut déchirer l'urètre." },
        run: () => [{ type: 'procedure.urinary_catheter' }] },
      { id: 'inflate', cam: 'groin', g: 'touch', at: 'groin', en: 'Inflate the balloon with 10 mL sterile water, pull back gently', fr: "Gonfler le ballonnet avec 10 mL d'eau stérile, retirer doucement" },
      { id: 'bag', cam: 'default', en: 'Closed drainage bag; hourly output (at least 0.5 mL/kg/h)', fr: 'Poche de recueil fermée ; diurèse horaire (au moins 0,5 mL/kg/h)',
        why: { en: 'In a man, pull the foreskin back over the glans afterwards.', fr: 'Chez l\'homme, recalotter le gland ensuite.' } },
    ],
  },
  {
    id: 'spinal', icon: 'proc', cam: 'default',
    en: 'Spinal anaesthesia', fr: 'Rachianesthésie',
    steps: [
      { id: 'prep', cam: 'arm', en: 'Check-list, IV access, ECG, SpO2, blood pressure', fr: 'Check-list, voie veineuse, ECG, SpO2, pression artérielle',
        why: { en: 'Check clotting, platelets and anticoagulant timing; vasopressor ready before the injection.', fr: 'Vérifier coagulation, plaquettes et délai des anticoagulants ; vasopresseur prêt avant l\'injection.' },
        run: () => [{ type: 'iv.access' }, { type: 'monitor.attach', items: { ecgLeads: true, spo2Probe: true, nibp: true } }, { type: 'nibp.cycle' }] },
      { id: 'coload', cam: 'arm', en: 'Co-load: crystalloid 500 mL', fr: 'Remplissage : cristalloïde 500 mL',
        run: () => [{ type: 'fluid.bolus', volumeL: 0.5, minutes: 10 }] },
      { id: 'sit', cam: 'default', en: 'Sitting, back flexed: find L3-L4 (line between the iliac crests)', fr: 'Assis, dos rond : repérer L3-L4 (ligne des crêtes iliaques)',
        why: { en: 'The spinal cord ends at L1-L2: stay below L3.', fr: 'La moelle se termine en L1-L2 : rester sous L3.' } },
      { id: 'asepsis', cam: 'default', en: 'Cap, mask, sterile gloves, chlorhexidine: let it dry', fr: 'Calot, masque, gants stériles, chlorhexidine : laisser sécher',
        why: { en: 'Chlorhexidine must be dry before the needle goes in: it is neurotoxic.', fr: "La chlorhexidine doit être sèche avant la ponction : elle est neurotoxique." } },
      { id: 'inject', cam: 'default', en: 'Pencil-point 25G needle, clear CSF, hyperbaric bupivacaine 12 mg', fr: 'Aiguille pointe crayon 25G, LCR clair, bupivacaïne hyperbare 12 mg',
        why: { en: 'Aspirate CSF before and after injecting; stop if there is pain or paraesthesia.', fr: "Aspirer du LCR avant et après l'injection ; arrêter en cas de douleur ou de paresthésie." },
        run: () => [{ type: 'neuraxial.spinal', amount: 12 }] },
      { id: 'supine', cam: 'default', en: 'Lie the patient flat straight away', fr: 'Allonger le patient tout de suite',
        why: { en: 'The hyperbaric solution spreads with gravity: head-up limits it, head-down spreads it higher.', fr: 'La solution hyperbare suit la gravité : la tête relevée limite son extension, la tête basse la fait monter.' },
        run: () => [{ type: 'position.set', headUp: false }] },
      { id: 'bp', cam: 'default', en: 'Blood pressure every 2 min, treat a fall over 20 %', fr: 'Pression artérielle toutes les 2 min, traiter une baisse de plus de 20 %',
        why: { en: 'Sympathetic block: vasodilatation and, if it rises to T4, bradycardia. Phenylephrine or ephedrine.', fr: 'Bloc sympathique : vasodilatation et, au-dessus de T4, bradycardie. Phényléphrine ou éphédrine.' },
        run: () => [{ type: 'nibp.cycle' }] },
      { id: 'assess', cam: 'default', en: 'At 5-10 min: test the level with cold, and leg movement', fr: 'À 5-10 min : tester le niveau au froid et la motricité des jambes',
        wait: { after: 'inject', s: 300, en: 'The block takes 5-10 min to settle', fr: 'Le bloc met 5 à 10 min à s\'installer' },
        run: () => [{ type: 'neuraxial.assess' }],
        msg: ({ p }) => ({ en: `Sensory level ${p.neuraxial.sensory}, Bromage ${p.neuraxial.bromage}`, fr: `Niveau sensitif ${p.neuraxial.sensory}, Bromage ${p.neuraxial.bromage}` }) },
    ],
  },
  {
    id: 'iv', icon: 'drugs', cam: 'arm',
    en: 'Peripheral IV cannula', fr: 'Cathéter veineux périphérique',
    steps: [
      { id: 'tourniquet', cam: 'arm', g: 'touch', at: 'arm', en: 'Tourniquet, choose a straight forearm vein', fr: "Garrot, choisir une veine droite de l'avant-bras",
        why: { en: '18G or larger in an emergency; avoid joints if possible.', fr: "18G ou plus en urgence ; éviter les plis si possible." } },
      { id: 'clean', cam: 'arm', g: 'swab', at: 'arm', en: 'Disinfect and let it dry', fr: 'Désinfecter et laisser sécher' },
      { id: 'insert', cam: 'arm', en: 'Insert at 15-30°, flashback, advance the cannula', fr: 'Ponctionner à 15-30°, reflux, avancer le cathéter',
        run: () => [{ type: 'iv.access' }] },
      { id: 'flush', cam: 'arm', g: 'touch', at: 'arm', en: 'Release tourniquet, flush, secure', fr: 'Retirer le garrot, rincer, fixer' },
    ],
  },
];

/** Skills training: the case each skill starts on ('' = a plain patient from the builder). */
export const SKILL_CASE = { iv: '', rsi: 'obese_rsi', defib: 'witnessed_vf', needle: 'tension_ptx', drain: 'tension_ptx', fona: 'cico', bronch: 'tube_desat', bmv: '', lma: '', aline: '', cvc: '', ng: '', uc: '', spinal: '' };

export const PARAMS = {
  side: { en: 'Side', fr: 'Côté', opts: [['R', { en: 'Right', fr: 'Droit' }], ['L', { en: 'Left', fr: 'Gauche' }]] },
  site: { en: 'Site', fr: 'Site', opts: [['mal5', { en: '5th ICS mid-axillary', fr: '5e EIC axillaire moyenne' }], ['aal5', { en: '5th ICS anterior axillary', fr: '5e EIC axillaire antérieure' }], ['mcl2', { en: '2nd ICS mid-clavicular', fr: '2e EIC médio-claviculaire' }]] },
  needleMm: { en: 'Catheter', fr: 'Cathéter', num: true, opts: [[80, { en: '80 mm', fr: '80 mm' }], [50, { en: '50 mm (14G)', fr: '50 mm (14G)' }], [100, { en: '100 mm', fr: '100 mm' }]] },
  fr: { en: 'Drain size', fr: 'Calibre', num: true, opts: [[28, { en: '28 Fr', fr: '28 Fr' }], [20, { en: '20 Fr', fr: '20 Fr' }], [32, { en: '32 Fr', fr: '32 Fr' }], [14, { en: '14 Fr', fr: '14 Fr' }]] },
  technique: { en: 'Technique', fr: 'Technique', opts: [['scalpel_bougie', { en: 'Scalpel-bougie-tube', fr: 'Bistouri-bougie-sonde' }], ['cannula', { en: 'Cannula', fr: 'Canule' }]] },
  approach: { en: 'Landmarks', fr: 'Repères', opts: [['palpate', { en: 'Palpable: transverse', fr: 'Palpables : transversale' }], ['vertical', { en: 'Impalpable: vertical incision', fr: 'Non palpables : incision verticale' }]] },
};

/** Runs one guided procedure: which step is current, what was done, early or skipped, and when (simulated time). */
export class Guide {
  constructor(proc, p) {
    this.proc = proc; this.i = 0; this.done = {}; this.status = proc.steps.map(() => 'todo'); this.notes = proc.steps.map(() => null);
    this.prm = Object.fromEntries((proc.params || []).map(k => [k, PARAMS[k].opts[0][0]]));
    if (this.prm.side && p?.chest?.side) this.prm.side = p.chest.side;
  }
  get step() { return this.proc.steps[this.i] || null; }
  get finished() { return this.i >= this.proc.steps.length; }
  /** seconds still to wait before the current step is on time (0 when ready) */
  remaining(p) { const w = this.step?.wait; if (!w || this.done[w.after] == null) return 0; return Math.max(0, w.s - (p.t - this.done[w.after])); }
  summary() {
    const n = this.status.length, c = (s) => this.status.filter(x => x === s).length;
    return { n, done: c('done'), early: c('early'), warn: c('warn'), skipped: c('skipped') };
  }
}

/**
 * Hands-on gestures (handson.js): the instrument, its target landmark (scene.world key, or 'chestSite' resolved from the
 * drop point), the tolerance radius, and the gesture with its limits. Steps without an entry keep the "Do this step" button.
 * Depth and length limits are teaching values, not clinical standards (REF design in docs/VALIDATION.md).
 */
const HANDS = {
  'rsi.iv': { tool: 'ivCannula', target: 'rightArmIV', radiusCm: 4, gesture: 'push', minCm: 1, maxCm: 3.5 },
  'rsi.induce': { tool: 'syringe', target: 'rightArmIV', radiusCm: 6, gesture: 'place' },
  'rsi.nmb': { tool: 'syringe', target: 'rightArmIV', radiusCm: 6, gesture: 'place' },
  'defib.pads': { tool: 'defibPadRight', target: 'padRight', radiusCm: 5, gesture: 'place' },
  'defib.drugs': { tool: 'syringe', target: 'rightArmIV', radiusCm: 6, gesture: 'place' },
  'needle.site': { tool: 'forcepsGauze', target: 'chestSite', radiusCm: 3, gesture: 'hold', holdS: 2 },
  'needle.insert': { tool: 'needle14G', target: 'chestSite', radiusCm: 2.5, gesture: 'push', minCm: 3, maxCm: 8, cmPerPx: 0.06 },
  'drain.site': { tool: 'forcepsGauze', target: 'chestSite', site: 'mal5', radiusCm: 3, gesture: 'hold', holdS: 2 },
  'drain.incise': { tool: 'scalpel', target: 'chestSite', site: 'mal5', radiusCm: 3, gesture: 'stroke', minCm: 2.5, maxCm: 5, axis: 'body' },
  'drain.insert': { tool: 'chestDrain', target: 'chestSite', site: 'mal5', radiusCm: 3, gesture: 'push', minCm: 6, maxCm: 14, cmPerPx: 0.1 },
  'fona.incise': { tool: 'scalpel', target: 'neck', radiusCm: 2, gesture: 'stroke', minCm: 1, maxCm: 10, axis: 'free', deriveApproach: true },
  'fona.tube': { tool: 'bougie', target: 'neck', radiusCm: 2, gesture: 'push', minCm: 4, maxCm: 12, cmPerPx: 0.08 },
  'iv.tourniquet': { tool: 'tourniquet', target: 'rightArmIV', radiusCm: 10, gesture: 'place' },
  'iv.clean': { tool: 'forcepsGauze', target: 'rightArmIV', radiusCm: 4, gesture: 'hold', holdS: 2 },
  'iv.insert': { tool: 'ivCannula', target: 'rightArmIV', radiusCm: 4, gesture: 'push', minCm: 1, maxCm: 3.5 },
  'iv.flush': { tool: 'syringe', target: 'rightArmIV', radiusCm: 6, gesture: 'place' },
};
for (const pr of PROCEDURES) for (const st of pr.steps) { const h = HANDS[`${pr.id}.${st.id}`]; if (h) st.hand = h; }

/**
 * 3D gesture (gestures.js startStep) for steps whose engine events draw nothing themselves: [kind, site].
 * Every step also gets an on-screen callout (ui._stepFx), so no step passes without something to see.
 */
const VIS = {
  'rsi.sedation': ['syringe', 'arm'], 'bronch.insert': ['scope', 'face'], 'bronch.pull': ['touch', 'face'], 'bronch.suction': ['scope', 'face'],
  'bmv.ventilate': ['mask', 'face'], 'aline.check': ['probe', 'arm'], 'aline.insert': ['needle', 'arm'], 'cvc.scan': ['probe', 'neck'], 'cvc.insert': ['needle', 'neck'],
  'ng.confirm': ['syringe', 'face'], 'uc.insert': ['touch', 'groin'], 'spinal.coload': ['syringe', 'arm'], 'spinal.assess': ['touch', 'chest'], 'iv.tourniquet': ['tourniquet', 'arm'],
};
for (const pr of PROCEDURES) for (const st of pr.steps) { const v = VIS[`${pr.id}.${st.id}`]; if (v) [st.g, st.at] = v; }
