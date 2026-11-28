# Tidal Bedside Lab

A 3D emergency-room and anaesthesia patient simulator for residents and young doctors, built for clinics and medical universities. Original product (not a clone of any existing simulator).

> **Education tool - not a validated medical device.** Several physiological constants are design values that still need clinician review; they are listed in [docs/VALIDATION.md](docs/VALIDATION.md). Read [docs/INTENDED_USE.md](docs/INTENDED_USE.md) before deploying.

## What it does

- **Any body**: sex, age 18-100, height 140-210 cm, weight 35-250 kg, BMI 15-65 (the tested envelope; the server rejects anything outside it). Lean mass, ideal/predicted body weight, total body water, blood volume (Nadler / Lemmens), BSA and energy expenditure are derived per patient and drive every model. The 3D patient is generated procedurally from the same numbers, with six skin tones.
- **Real-time physiology** (fixed 0.1 s step, deterministic): 3-compartment + effect-site pharmacokinetics (propofol Eleveld/Marsh/Schnider, remifentanil Minto/Eleveld, others), Guyton/Starling circulation with baroreflex, alveolar gas exchange with oxygen/nitrogen pools, CO2 stores, atelectasis/shunt, fluid kinetics and haemorrhage, two-compartment thermoregulation, cardiac-arrest rhythms and a CPR-quality -> coronary-perfusion -> ROSC model, defibrillation, reversible causes (H's and T's).
- **Every intervention is live**: 57 drugs (bolus and infusion, per-kg dose presets on lean/ideal/total weight), fluids, blood products, haemorrhage control, bicarbonate, positioning, oxygen devices, airway manoeuvres/devices/intubation, ventilator, apnoeic oxygenation, CPR (auto and manual), pads/charge/shock, needle decompression, pericardiocentesis, PCI, thrombolysis, hyperkalaemia treatment, monitoring, 12-lead ECG, troponin, temperature management.
- **Realistic patient and hands-on procedures**: a MakeHuman-based supine patient (CC0, built in Blender, see `assets-src/`) that morphs with sex, age and BMI, and an instrument tray. Drag the swab, needle, scalpel, drain, bougie, cannula, syringe, pads or tourniquet onto the skin, then hold, push, cut or turn as the step requires. Where you drop decides the side and site.
- **Surgical gestures**: chest and neck examination, lung ultrasound, needle decompression (side, site and catheter length against a BMI-dependent chest wall), chest drain, and emergency front-of-neck access (scalpel-bougie-tube or cannula, palpation or ultrasound landmarks), all feeding back into the physiology.
- **Bronchoscopy through the tube**: a steerable fibre-optic view (bend the tip, rotate, advance and withdraw) of a tracheobronchial tree built to the patient's size, with a map, live vitals and labels. It shows where the tube tip lies (a tube taped too deep enters the right main bronchus and only one lung is ventilated), lets you pull the tube back, and aspirate secretions that build up in a long-intubated patient.
- **35 scored scenarios** (guideline-derived criteria with registry citations):
  - resuscitation and airway: STEMI -> VF, witnessed VF on a monitored bed, opioid overdose -> hypoxic PEA, rapid-sequence induction at BMI 45, haemorrhagic shock, tension pneumothorax in a ventilated trauma patient, can't intubate can't oxygenate (BMI 36), desaturation in an intubated patient whose tube slipped into the right main bronchus (bronchoscopy);
  - focused echocardiography: hypovolaemia, LV failure, tamponade, acute RV strain;
  - infectiology ward: pyelonephritis with bacteraemia, severe community-acquired pneumonia, central-line *S. aureus* bacteraemia, ESBL urosepsis with shock;
  - anaesthesia crises: anaphylaxis, malignant hyperthermia, local anaesthetic toxicity, complete heart block, torsades de pointes;
  - medical emergencies: DKA, status epilepticus, COPD exacerbation, SVT, hyperkalaemia, hypoglycaemia, Mobitz II bradycardia, hyponatraemia, pulmonary oedema, hypertensive emergency, variceal bleeding;
  - regional anaesthesia and recovery: hypotension after a spinal, high spinal, postoperative nausea and vomiting.
- **Server-side verification**: the server issues the random seed; the client records an event log; on submit the server replays the session in a worker thread with the same engine and compares a state hash, then stores its own score. *Verified* means the replay reproduced the hash the client sent and the log carries exactly the instructor changes the server delivered. It shows the result is consistent with the log; it does not prove the learner played every action by hand, since the engine is public and a learner could compute the hash of an edited log.
- English and French UI. Zero runtime dependencies (Node >= 20, any modern browser with WebGL2; the app degrades gracefully without WebGL2).

## Quick start

```bash
node src/server/server.js              # http://localhost:8080
npm test                               # over 550 automated tests (~2-5 min)
npm run verify                         # syntax check + tests
npm run smoke                          # play every case in headless Chrome (Node >= 22, Chrome or Chromium installed)
npm run build                          # self-contained dist/ with BUILD.json
npm run docs                           # regenerate docs/REFERENCES.md
```

Docker: `docker build -t tidal-bedside-lab . && docker run -p 8080:8080 -v tbl-data:/data -e API_TOKEN=change-me tidal-bedside-lab` (see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md); the `docker` job in `.github/workflows/ci.yml` builds the image and runs `scripts/docker-smoke.sh` against it on every push).

## Layout

```
src/engine/   pure ES-module physiology (no DOM/Node APIs): patient, pk, drugs, cardio, respiratory, fluids, thermal, rhythm, cpr, scenarios, references
src/server/   http server, replay worker pool, JSON session store
src/web/      WebGL2 renderer (gl/), Canvas2D monitor, DOM UI, i18n
tests/        unit, scenario, determinism, fuzz and server tests (node:test)
docs/         ADRs, REFERENCES (generated), VALIDATION, CLINICAL_REVIEW (23 items for clinician sign-off), DEPLOYMENT, INTENDED_USE, API
.github/      CI workflow: tests on Node 20 and 22, dist build, references freshness, Docker image smoke test
scripts/      build, syntax check, reference generator
```

## Controls

The simulator is played like a clinical game: the 3D resuscitation bay fills the window and every control floats over it.

- **Start screen:** pick a scenario card or build any patient (sex, age, height, weight, skin tone). The 3D patient on screen changes as you type, so a BMI 45 or a BMI 17 patient is visible before the case starts.
- **In the bay:** click the patient or the equipment. Chest = compression, head = airway panel, neck and lateral chest = procedures panel, right arm = IV access, left arm = NIBP, groin = bleeding/fluids panel, crash cart = CPR/defibrillator panel, IV pole = fluids, monitor = monitoring and orders, anaesthesia machine and wall oxygen = airway panel, medication cabinet = drugs. Floating markers show where to click (names appear for a few seconds at case start, then on hover; *Markers* in the settings menu hides them).
- **Dock (bottom):** Drugs, Fluids, Airway, CPR / Defib, Procedures, Monitor & orders. The panel closes with the cross or `Esc`.
- **Alarms:** the screen edge pulses red on cardiac arrest and amber when SpO2 falls below 88 % with the probe on.
- **Top bar:** clock, speed (pause to 30x), camera presets, briefing, *New case* (reopens the start screen, pauses the case), *Finish & score*, settings (sound, markers, teaching overlay, language).
- **Keys:** `C` compression, `Space` pause, `1-5` speed (1x-30x), `Esc` close panel/menu. The camera is locked to cinematic presets (Reset, Head, Chest, Arm, Side, Top, Foot) and re-frames itself when you open a panel; drag only leans the view slightly, the wheel never zooms. Every gesture (IV, syringe bolus, needle decompression, chest drain, cricothyroidotomy, POCUS, auscultation, intubation) is played as a hand animation on the patient. The *Teaching overlay* shows the hidden physiology (PaO2, CO, SVR, lactate, effect-site concentrations).
- **Phones and tablets:** panels become bottom sheets and the camera pulls back on portrait screens.

## Extending

Scenarios are data in `src/engine/scenarios.js` (initial state, scripted events, scoring criteria with `REF` ids). New engine constants must carry a `REF <id>` tag and an entry in `src/engine/references.js`; `tests/references.test.js` enforces it. Replace the procedural patient with a GLB model by loading it in `src/web/scene.js`; the engine and server are unaffected.
