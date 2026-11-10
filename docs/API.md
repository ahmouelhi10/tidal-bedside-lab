# HTTP API

All responses are JSON. Errors: `{ "error": "..." }`.

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /api/health` | - | `{status, version, uptimeS, scenarios, node}` |
| `GET /api/scenarios` | - | Scenario list (id, title, difficulty, durationS, kind, summary, spec, learning). Scoring criteria are never sent to the client |
| `POST /api/sessions` | - | Body `{scenario?, spec?:{sex,age,heightCm,weightKg}, learner?}`. Ranges: age 18-100, height 140-210 cm, weight 35-250 kg, BMI 15-65. Returns `{id, seed, spec, ...}`; the **server issues the seed** |
| `GET /api/sessions/:id` | - | Public view (status, result if submitted) |
| `POST /api/sessions/:id/submit` | - | Body `{log:[{t,type,...}], until, hash}`. The server validates the log (event types, monotonic time, size limits), replays it in a worker, compares the hash and stores its own score. One submission per session (409 otherwise) |
| `GET /api/sessions` | Bearer `API_TOKEN` | Instructor list. `GET /api/sessions/:id?log=1` adds the event log |

Event types are listed in `EVENT_TYPES` (`src/engine/patient.js`), including the tracheal-tube and bronchoscopy events `airway.intubate {depthCm?}`, `airway.tube_adjust {cm}`, `bronch.insert`, `bronch.suction {where: trachea|R|L}` and `bronch.remove`, and the infectiology ward events `ward.advance {hours: 1-72}`, `ward.sample {kind: blood|urine|sputum|uag}`, `ward.rx.start {drug, route: iv|po, dose?: std|high}`, `ward.rx.stop {drug}` and `ward.order {what: labs|lactate|fluids30|remove_line|tte|renal_us|cxr}` (the ward has its own clock in hours, advanced only by `ward.advance`), and the laboratory event `lab.order {kind: abg|lactate|cbc}` (the sample freezes the values at that time; `Patient.labResults()` releases each result after its turnaround: 3 min for the blood gas and lactate, 45 min for the blood count); each event's nested payload is validated by the engine (`validateEventShape`), and a rejected event is still logged so a replay rejects it identically.
