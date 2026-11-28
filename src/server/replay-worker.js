// Runs one session replay in a worker thread so the HTTP event loop is never blocked by CPU-bound simulation.
import { parentPort, workerData } from 'node:worker_threads';
import { replay } from '../engine/patient.js';
import { SCENARIOS, scoreSession } from '../engine/scenarios.js';
import { keyActionTimes } from '../engine/timeline.js';

try {
  const { spec, seed, scenario, log, until } = workerData;
  const p = replay({ spec, seed, scenario, log, until }, SCENARIOS);
  // key action times from this replay, counting only what the engine accepted (the same rule as the learner's debrief)
  const keyTimes = keyActionTimes(p.log.map(e => ({ t: e.t, type: e.type, ok: e.ok, ev: e })));
  parentPort.postMessage({ ok: true, hash: p.stateHash(), t: p.t, snapshot: p.snapshot(), score: scenario ? scoreSession(p) : null, keyTimes, arrests: p.arrest.arrestStarts?.length ?? 0, roscCount: p.arrest.roscCount ?? 0 });
} catch (e) {
  parentPort.postMessage({ ok: false, error: String(e && e.message || e) });
}
