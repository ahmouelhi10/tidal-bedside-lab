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
const NOT_RELAXED = ({ p }) => { if (p.arrest.arrested) return null; const n = p.drugs.effects({ inArrest: false }).nmb; return n > 0.9 ? null : { en: `Not fully paralysed yet (block ${Math.round(n * 100)} %)`, fr: `Curarisation incomplète (bloc ${Math.round(n * 100)} %)` }; };

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
        run: () => [{ type: 'o2.mask', fio2: 1.0, seal: 0.95 }] },
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
        check: ({ p }) => (p.airway.intubated ? null : { en: 'The tube is not in the trachea yet', fr: "La sonde n'est pas encore dans la trachée" }),
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
        msg: ({ p }) => { const k = p.arrest.key, sh = ['VF', 'VT'].includes(k); return { en: `Rhythm: ${k} - ${sh ? 'shockable' : 'not shockable'}`, fr: `Rythme : ${k} - ${sh ? 'choquable' : 'non choquable'}` }; } },
      { id: 'charge', cam: 'default', en: 'Resume CPR and charge 200 J', fr: 'Reprendre la RCP et charger à 200 J',
        why: { en: 'Charge while compressions continue: the hands-off time is only the shock itself.', fr: 'Charger pendant les compressions : la seule pause est le choc lui-même.' },
        run: () => [{ type: 'defib.setEnergy', energy: 200 }, { type: 'defib.charge' }] },
      { id: 'clear', cam: 'default', en: '"Stand clear, oxygen away" - check everyone', fr: '« Écartez-vous, oxygène retiré » - vérifier tout le monde',
        why: { en: 'Look from head to toe: nobody touching the patient or the bed, oxygen source 1 m away.', fr: "Regarder de la tête aux pieds : personne ne touche le patient ni le lit, oxygène à 1 m." },
        run: () => [{ type: 'cpr.stop' }] },
      { id: 'shock', cam: 'chest', en: 'Shock', fr: 'Choquer',
        check: ({ p }) => (p.defib.charged ? null : { en: 'The defibrillator is not charged yet', fr: "Le défibrillateur n'est pas encore chargé" }),
        run: () => [{ type: 'defib.shock' }] },
      { id: 'resume', cam: 'chest', en: 'Resume CPR immediately for 2 min', fr: 'Reprendre immédiatement la RCP pendant 2 min',
        why: { en: 'Do not check the pulse after the shock: compress straight away.', fr: 'Ne pas chercher le pouls après le choc : comprimer tout de suite.' },
        run: () => [{ type: 'cpr.start', mode: 'auto', opts: { rate: 110, depth: 5.5, ratio: '30:2' }, surface: 'hard' }] },
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
        run: () => [{ type: 'o2.mask', fio2: 1.0, seal: 0.95 }] },
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
        run: ({ b }) => [{ type: 'monitor.attach', items: { capnography: true } }, { type: 'vent.set', settings: { mode: 'ctrl', rate: 12, vt: Math.round(6 * b.pbw), fio2: 1, peep: 5, seal: 0.97 } }] },
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
