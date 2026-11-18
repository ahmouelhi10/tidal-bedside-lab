// Boot and render loop. Wires Sim (engine + server session), Monitor (2D), Scene (WebGL2) and the DOM UI.
import { Sim } from './sim.js';
import { Monitor, MonitorSound } from './monitor.js';
import { Scene } from './scene.js';
import { UI } from './ui.js';
import { initLang, t } from './i18n.js';
import { Bronchoscope } from './bronchoscope.js';
import { HandsOn } from './handson.js';
import { EchoLab } from './echo.js';
import { selfAssess } from './debrief-ui.js';
import { LiveLink } from './live.js';

initLang();
const root = document.getElementById('app');
const glCanvas = Object.assign(document.createElement('canvas'), { id: 'gl', tabIndex: 0 });
glCanvas.setAttribute('aria-label', '3D patient bedside view');
const monCanvas = Object.assign(document.createElement('canvas'), { id: 'monitor' });
monCanvas.setAttribute('aria-label', 'Patient monitor');

const sim = new Sim();
const sound = new MonitorSound();
const monitor = new Monitor(monCanvas);
monitor.setSound(sound);
let scene, noGl = false;
try { scene = new Scene(glCanvas, monCanvas); } catch (e) {
  noGl = true; console.warn('WebGL2 unavailable:', e && e.message);
  scene = { hover: null, tone: 2, auto: false, pins: [], setCamera() {}, setPatient() {}, draw() {}, project() { return null; }, onHotspot: null };
}
const ui = new UI(root, { sim, scene, monitor, sound, glCanvas, monCanvas });
ui.bronch = new Bronchoscope({ sim, scene, ui });
ui.echoLab = new EchoLab({ sim, scene, ui });
ui.liveLink = new LiveLink({ sim, ui });
scene.loadPatientAsset?.(); scene.loadInstruments?.();
if (!noGl) ui.handsOn = new HandsOn({ scene, ui });
scene.onAsset = () => { if (ui.panelOpen && ui.tab === 'tab_guide') ui.buildTabs(); };                          // realistic patient (assets/patient.glb); the procedural body stays until it is ready
window.__tbl = { sim, scene, monitor, ui };         // debugging / automated UI tests

monitor.onBeat = (spo2) => sound.beep(spo2);
scene.onHotspot = (h, e) => ui.hotspot(h, e);
glCanvas.addEventListener('pointermove', (e) => ui.trackMouse(e));
glCanvas.addEventListener('pointerleave', () => { ui._mouse = null; });

sim.addEventListener('note', (e) => ui.log(e.detail.text));
sim.addEventListener('engineEvent', (e) => {
  const x = e.detail;
  if (x.type === 'rhythm') {
    ui.log(`${x.from} → ${x.to}`);
    if (x.to === 'NSR' || x.to === 'SINUS') ui.toast(t('ev_rosc'));
    else if (['VF', 'VT_PULSELESS', 'TORSADES', 'PEA', 'ASYSTOLE'].includes(x.to)) ui.toast(t('ev_arrest') + ': ' + x.to, true);
  } else ui.log(x.type);
});
sim.addEventListener('action', (e) => { try { scene.gesture?.(e.detail.event, e.detail.result); } catch (err) { console.warn('gesture skipped:', err && err.message); }
   const d = ui.describe(e.detail.event); if (d) ui.log(d + (e.detail.result && e.detail.result.ok === false ? ' ✗' : '')); });
sim.addEventListener('speed', () => ui.refresh());

// the case menu shows the patient being built (a resting throw-away copy); closing it restores the live patient
ui.onPreview = (setup) => {
  const { age, heightCm, weightKg } = setup.spec;                // ignore half-typed values (empty field, 3 kg ...)
  if (!(age >= 18 && age <= 100 && heightCm >= 140 && heightCm <= 210 && weightKg >= 35 && weightKg <= 250)) return;
  try { sim.setPreview(setup.spec); scene.setPatient(setup.spec, setup.tone); scene.auto = true; } catch (e) { console.warn('preview skipped:', e && e.message); }
};
ui.onResume = () => { scene.setPatient(sim.session.spec, ui.liveTone); scene.setCamera('default'); ui.syncPins(); };
ui.onStart = async (setup) => {
  ui.bronch.stop(); ui.echoLab.stop(); ui.liveLink.stop();
  await sim.start({ scenarioId: setup.scenarioId, spec: setup.spec, learner: setup.learner });
  ui.liveTone = setup.tone;
  scene.setPatient(sim.session.spec, setup.tone);
  scene.setCamera('default');
  ui.onSessionStart();
  if (!sim.online) ui.toast(t('offline_note'));
  glCanvas.focus();
};
ui.onFinish = async () => {
  if (!sim.patient || sim.finished) return;
  ui.bronch.stop(); ui.echoLab.stop(); ui.liveLink.stop();
  sim.setSpeed(0);
  const [out, self] = await Promise.all([sim.finish(), selfAssess()]);   // the learner rates themselves before seeing the score
  if (self && out?.server && sim.session?.id) fetch(`/api/sessions/${sim.session.id}/self`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(self) }).catch(() => {});   // kept for validity studies
  ui.showDebrief(out, self);
};
ui.onLang = () => { if (noGl) ui.dom.noGl.hidden = false; };

// keyboard: C = one manual compression, Space = pause/resume, 1-5 = speed, Esc closes the debrief, the panel or the menu
window.addEventListener('keydown', (e) => {
  if (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(e.target.tagName) && e.key !== 'Escape') return;
  if (e.key === 'c' || e.key === 'C') { ui.manualCompress(); e.preventDefault(); }
  else if (e.key === ' ') { sim.setSpeed(sim.speed === 0 ? 1 : 0); e.preventDefault(); }
  else if (/^[1-5]$/.test(e.key)) sim.setSpeed([1, 2, 5, 10, 30][Number(e.key) - 1]);
  else if (e.key === 'Escape') { const m = document.querySelector('.modal'); if (m) m.remove(); else ui.escape(); }
});

let last = performance.now(), uiAcc = 0, alarmCheck = 0, insetAcc = 0;
function loop(now) {
  const dt = Math.min(0.25, (now - last) / 1000); last = now;
  const live = sim.patient;
  insetAcc += dt; if (insetAcc > 0.2) { insetAcc = 0; ui.updateInsets?.(); }
  try {
    if (ui.menuOpen) {                                          // case menu: slowly orbit the patient being built
      if (sim.previewPatient) { monitor.update(dt, sim.previewPatient); scene.draw(dt, sim.previewPatient); }
    } else if (live) {
      const p = live;
      sim.frame(dt);
      monitor.update(dt, p);
      scene.draw(dt, p);
      ui.updatePins();
      uiAcc += dt; if (uiAcc > 0.1) { uiAcc = 0; ui.refresh(); }
      alarmCheck += dt; if (alarmCheck > 1) { alarmCheck = 0; if (p.flags.ecgLeads && ['VF', 'VT_PULSELESS', 'TORSADES', 'ASYSTOLE'].includes(p.arrest.key) && sim.speed > 0) sound.alarm(now / 1000); }
    }
  } catch (err) { console.error(err); sim.setSpeed(0); ui.toast(String(err && err.message || err), true); }
  requestAnimationFrame(loop);
}

(async function boot() {
  await sim.probeServer();
  await ui.init();
  if (noGl) ui.dom.noGl.hidden = false;
  ui.queuePreview(true);                                        // first screen: case menu over a live 3D preview of the default patient
  requestAnimationFrame(loop);
})();
