// Extra panel sections: vascular access and invasive monitoring, pacing, 12-lead ECG, clinical scores, massive transfusion.
// They only dispatch engine events through ui.act and read engine state.
import { t } from './i18n.js';
import { ecg12, scores, riskScores, trainOfFour, curb65 } from '/engine/clinical.js';
import { paceThreshold } from '/engine/crises.js';
import { isPerfusing } from '/engine/rhythm.js';

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}
const chk = (label) => { const i = el('input', { type: 'checkbox' }); return { i, node: el('label', { class: 'chk' }, i, ' ' + label) }; };

/** Procedures tab: intraosseous access, arterial line, central line, NG tube, urinary catheter. */
export function procExtra(ui, P) {
  const usA = chk(t('px_us')), usC = chk(t('px_us'));
  const site = el('select', { 'aria-label': t('px_site') }, ...['ijv', 'scv', 'fem'].map(s => el('option', { value: s, text: t('px_site_' + s) })));
  P.append(el('details', { open: true }, el('summary', { text: t('px_title') }),
    el('div', { class: 'stack' },
      ui.btn(t('px_io'), () => ui.act({ type: 'io.access' }, t('px_io')), 'act'),
      el('div', { class: 'row2' }, ui.btn(t('px_vagal_mod'), () => ui.act({ type: 'procedure.vagal', technique: 'modified' }, t('px_vagal_mod')), 'act', { title: t('px_vagal_t') }), ui.btn(t('px_vagal_std'), () => ui.act({ type: 'procedure.vagal', technique: 'standard' }, t('px_vagal_std')), 'act')),
      el('div', { class: 'row2' }, ui.btn(t('px_aline'), () => ui.act({ type: 'procedure.arterial_line', us: usA.i.checked }, t('px_aline')), 'act'), usA.node),
      el('div', { class: 'row2' }, ui.btn(t('px_cvc'), () => ui.act({ type: 'procedure.central_line', site: site.value, us: usC.i.checked }, t('px_cvc')), 'act'), el('div', {}, site, usC.node)),
      ui.btn(t('px_ng'), () => ui.act({ type: 'procedure.ng_tube' }, t('px_ng')), 'act'),
      ui.btn(t('px_uc'), () => ui.act({ type: 'procedure.urinary_catheter' }, t('px_uc')), 'act'))));
}

/** CPR / defibrillator tab: transcutaneous pacing. */
export function pacingExtra(ui, P) {
  const p = ui.sim.patient, pc = p?.crises?.pace || { rate: 70, mA: 0 };
  const rate = el('input', { type: 'number', min: 30, max: 180, step: 5, value: pc.rate, 'aria-label': t('pc_rate') });
  const ma = el('input', { type: 'number', min: 0, max: 200, step: 5, value: pc.mA || 60, 'aria-label': 'mA' });
  const st = el('p', { class: 'small muted pc-status' });
  ui._paceStatus = () => { const q = ui.sim.patient; if (!q || !st.isConnected) return; st.textContent = !q.crises.pace.on ? t('pc_off') : q.crises.captured ? t('pc_capture', { r: q.crises.pace.rate }) : t('pc_nocapture'); st.className = 'small pc-status ' + (q.crises.captured ? 'good' : q.crises.pace.on ? 'warn' : 'muted'); };
  P.append(el('details', { open: true }, el('summary', { text: t('pc_title') }), el('p', { class: 'muted small', text: t('pc_help', { th: Math.round(paceThreshold(p?.body?.bmi ?? 25) / 10) * 10 }) }),
    el('div', { class: 'row2' }, el('label', { class: 'f' }, el('span', { text: t('pc_rate') }), rate), el('label', { class: 'f' }, el('span', { text: t('pc_ma') }), ma)),
    el('div', { class: 'row2' }, ui.btn('▶ ' + t('pc_start'), () => { ui.act({ type: 'pacing.set', on: true, rate: Number(rate.value), mA: Number(ma.value) }, t('pc_title')); ui._paceStatus(); }, 'act'),
      ui.btn('■ ' + t('stop'), () => { ui.act({ type: 'pacing.set', on: false }, t('pc_title') + ' - ' + t('stop')); ui._paceStatus(); }, 'ghost')), st));
  ui._paceStatus();
}

/** Airway tab: non-invasive ventilation (CPAP / BiPAP) and high-flow nasal oxygen for a spontaneously breathing patient. */
export function nivExtra(ui, P) {
  const mode = el('select', { 'aria-label': t('niv_mode') }, ...['bipap', 'cpap', 'hfno'].map(m => el('option', { value: m, text: t('niv_' + m) })));
  const num = (v, min, max, step, l) => el('input', { type: 'number', value: v, min, max, step, 'aria-label': l });
  const fio2 = num(0.4, 0.21, 1, 0.05, 'FiO2'), epap = num(5, 0, 20, 1, 'EPAP'), ipap = num(15, 0, 30, 1, 'IPAP'), flow = num(50, 10, 70, 5, t('niv_flow'));
  const f = (l, i) => el('label', { class: 'f' }, el('span', { text: l }), i);
  P.append(el('h4', { text: t('niv_title') }), el('p', { class: 'muted small', text: t('niv_help') }),
    el('div', { class: 'row2' }, f(t('niv_mode'), mode), f('FiO2', fio2)), el('div', { class: 'row3' }, f('EPAP / CPAP', epap), f('IPAP', ipap), f(t('niv_flow'), flow)),
    el('div', { class: 'row2' }, ui.btn(t('niv_start'), () => ui.act({ type: 'niv.set', mode: mode.value, fio2: Number(fio2.value), epap: Number(epap.value), ipap: Math.max(Number(ipap.value), Number(epap.value)), flow: Number(flow.value) }, t('niv_' + mode.value)), 'act primary'),
      ui.btn(t('niv_off'), () => ui.act({ type: 'niv.set', mode: 'off' }, t('niv_off')), 'act')));
}

/** A visible clinical sign over the scene: a generalised seizure (hidden by neuromuscular block, as at the bedside). */
export function signsTick(ui) {
  const p = ui.sim.patient; if (!p) return;
  let b = document.getElementById('signsBanner');
  if (!b) { b = el('div', { id: 'signsBanner', class: 'signs', role: 'status', 'aria-live': 'polite' }); document.body.append(b); }
  const seizing = p.crises?.seizure && !p.drugs.effects({ inArrest: p.arrest.arrested }).paralyzed;
  const txt = seizing ? t('sg_seizure') : '';
  if (b.textContent !== txt) { b.textContent = txt; b.hidden = !txt; }
}

/** Airway tab: sevoflurane vaporiser and the anaesthetic gas read-out (FI, end-tidal, MAC multiple). */
export function vaporizerExtra(ui, P) {
  const dial = el('input', { type: 'number', min: 0, max: 18, step: 0.5, value: ui.sim.patient?.volatile?.dial || 2, 'aria-label': t('va_dial') });
  const agent = el('select', { 'aria-label': t('va_agent') }, ...['sevoflurane', 'isoflurane', 'desflurane'].map(a => el('option', { value: a, text: t('va_' + a), selected: ui.sim.patient?.volatile?.agent === a })));
  const n2o = el('input', { type: 'number', min: 0, max: 70, step: 10, value: 0, 'aria-label': t('va_n2o') });
  ui.dom.volBox = el('p', { class: 'small vol-read' });
  P.append(el('h4', { text: t('va_title') }), el('p', { class: 'muted small', text: t('va_help') }),
    el('div', { class: 'row2' }, el('label', { class: 'f' }, el('span', { text: t('va_dial') }), dial), ui.btn(t('va_set'), () => ui.act({ type: 'vaporizer.set', agent: agent.value, percent: Number(dial.value) }, t('va_' + agent.value) + ' ' + dial.value + ' %'), 'act primary')), el('label', { class: 'f' }, el('span', { text: t('va_agent') }), agent),
    el('div', { class: 'row2' }, el('label', { class: 'f' }, el('span', { text: t('va_n2o') }), n2o), ui.btn(t('va_n2o_set'), () => ui.act({ type: 'n2o.set', percent: Number(n2o.value) }, t('va_n2o') + ' ' + n2o.value + ' %'), 'act')),
    el('div', { class: 'row2' }, ui.btn(t('va_off'), () => ui.act({ type: 'vaporizer.set', agent: agent.value, percent: 0 }, t('va_off')), 'act'), ui.btn(t('va_mask'), () => ui.act({ type: 'o2.mask', fio2: 1, seal: 0.97 }, t('va_mask')), 'act')), ui.dom.volBox);
  volTick(ui);
}
export function volTick(ui) {
  const box = ui.dom?.volBox, p = ui.sim.patient; if (!box || !box.isConnected || !p) return;
  const v = p.volatile, txt = t('va_' + v.agent) + ': ' + t('va_read', { fi: v.fi.toFixed(1), et: v.fa.toFixed(1), mac: v.totalEtMac.toFixed(2), age: v.mac.toFixed(1) }) + (v.st.n2o.on ? ` · N₂O ${v.n2oFi.toFixed(0)} / ${v.st.n2o.fa.toFixed(0)} %` : '');
  if (box.textContent !== txt) box.textContent = txt;
}

/** Orders tab: 12-lead ECG, scores, invasive readings. */
export function ordersExtra(ui, P) {
  ui.dom.scoreBox = el('div', { class: 'score-box small' });
  const pe = chk(t('sc_pe_likely')); pe.i.checked = !!ui._peLikely; pe.i.addEventListener('change', () => { ui._peLikely = pe.i.checked; scoresTick(ui); });
  ui.dom.riskBox = el('div', { class: 'score-box small' });
  P.append(el('h4', { text: t('sc_title') }), ui.dom.scoreBox, el('h4', { text: t('sc_risk') }), pe.node, ui.dom.riskBox, el('p', { class: 'muted small', text: t('sc_risk_help') }));
  scoresTick(ui);
}
export function scoresTick(ui) {
  const box = ui.dom?.scoreBox, p = ui.sim.patient; if (!box || !box.isConnected || !p) return;
  const s = scores(p), f = (v) => (v == null ? '—' : v);
  const uo = p.flags.urineCath && p.t > (p.urineT0 ?? 0) + 60 ? Math.round((p.vol.urine + p.vol.urineBasal - (p.urine0 ?? 0)) * 1000 / ((p.t - p.urineT0) / 3600) / p.body.weightKg * 10) / 10 : null;
  const rows = [['GCS', f(s.gcs)], ['NEWS2', f(s.news2)], ['qSOFA', f(s.qsofa)], [t('sc_si'), f(s.shockIndex)], ['PVC / CVP', p.flags.cvc ? Math.round(p.circ.rap) + ' mmHg' : '—'], [t('sc_uo'), uo == null ? '—' : uo + ' mL/kg/h']];
  const tof = trainOfFour(p); rows.push([t('sc_tof'), tof.count + '/4' + (tof.ratio != null && !tof.depolarising ? ' · ' + Math.round(tof.ratio * 100) + ' %' : '')]);
  const sig = rows.map(r => r[1]).join('|'); if (box.dataset.sig === sig) return; box.dataset.sig = sig;
  box.replaceChildren(el('div', { class: 'score-grid' }, ...rows.map(([k, v]) => el('div', {}, el('i', { text: k }), el('b', { text: String(v) })))));
  riskTick(ui);
}
function riskTick(ui) {
  const box = ui.dom?.riskBox, p = ui.sim.patient; if (!box || !box.isConnected || !p) return;
  const r = riskScores(p, { peLikely: !!ui._peLikely });
  const rows = [
    ['Wells', r.wells == null ? '—' : r.wells, r.wells == null ? '' : t(r.wellsLikely ? 'sc_wells_likely' : 'sc_wells_unlikely')],
    ['PERC', r.perc == null ? '—' : r.percNegative ? t('sc_perc_neg') : r.perc + '/8', r.percPositive.map(k => t('sc_perc_' + k)).join(', ')],
    ['CRB-65 / CURB-65', (c => c.crb65 == null ? '—' : c.crb65 + ' / ' + (c.curb65 ?? '—'))(curb65(p)), t('sc_curb_t')],
    ['CHA₂DS₂-VA', r.cha2ds2va, t(r.cha2ds2va >= 2 ? 'sc_va_hi' : r.cha2ds2va === 1 ? 'sc_va_mid' : 'sc_va_lo')],
  ];
  const sig = JSON.stringify(rows); if (box.dataset.sig === sig) return; box.dataset.sig = sig;
  box.replaceChildren(el('div', { class: 'score-grid' }, ...rows.map(([k, v, note]) => el('div', { title: note }, el('i', { text: k }), el('b', { text: String(v) }), note ? el('small', { class: 'muted', text: note }) : null))));
}

/** Fluids tab: massive transfusion pack (1:1:1). */
export function fluidsExtra(ui, P) {
  P.append(el('div', { class: 'stack' }, ui.btn(t('fl_mtp'), () => { for (const k of ['prbc', 'ffp', 'platelets']) ui.act({ type: 'blood.transfuse', kind: k }); ui.toast(t('fl_mtp')); }, 'act', { title: t('fl_mtp_t') })));
}

/** 12-lead ECG sheet (25 mm/s, 10 mm/mV): 3 x 4 layout plus a lead II rhythm strip. */
export function showEcg12(ui) {
  const p = ui.sim.patient; if (!p) return;
  const e = ecg12(p), W = 1100, H = 560, cv = el('canvas', { width: W, height: H, class: 'ecg12' }), g = cv.getContext('2d');
  g.fillStyle = '#fff6f6'; g.fillRect(0, 0, W, H);
  for (let x = 0; x < W; x += 5) { g.fillStyle = x % 25 ? 'rgba(240,120,120,.18)' : 'rgba(220,80,80,.45)'; g.fillRect(x, 0, 1, H); }
  for (let y = 0; y < H; y += 5) { g.fillStyle = y % 25 ? 'rgba(240,120,120,.18)' : 'rgba(220,80,80,.45)'; g.fillRect(0, y, W, 1); }
  const mm = 5, gauss = (x, c, w) => Math.exp(-((x - c) ** 2) / (2 * w * w));
  const AXIS = { I: 0.8, II: 1.0, III: 0.5, aVR: -0.9, aVL: 0.3, aVF: 0.75, V1: -0.6, V2: -0.3, V3: 0.4, V4: 1.1, V5: 1.0, V6: 0.8 };
  const rr = 60 / Math.max(25, e.rate || 60), M = e.morph, qw = 1 + (M.qrsWide || 0), arrest = !isPerfusing(e.rhythm);
  const beat = (lead, tau, abs = tau, noP = false) => {                                       // mV at time tau (s) after the R wave
    const a = AXIS[lead], st = e.st[lead] / 10;
    if (arrest) return e.rhythm === 'VF' ? 0.3 * Math.sin(tau * 31) * Math.sin(tau * 7.3) : e.rhythm === 'TORSADES' ? 1.1 * Math.sin(abs * 26.4) * Math.sin(abs * 2.86) * Math.sign(a || 1) : 0;
    let qrs = a / Math.sqrt(qw) * gauss(tau, 0, 0.011 * qw) - 0.15 * Math.abs(a) * gauss(tau, 0.03 * qw, 0.01 * qw);
    let tDir = Math.sign(a || 1);                                       // T direction: normally with the QRS
    if (e.bbb === 'L') {                                                // broad notched R in I, aVL, V5-V6; QS in V1-V3; ST-T discordant (REF surawicz2009)
      const left = ['I', 'aVL', 'V5', 'V6'].includes(lead), right = ['V1', 'V2', 'V3'].includes(lead);
      qrs = left ? 0.75 * (gauss(tau, 0.015, 0.022) + gauss(tau, 0.075, 0.025)) : right ? -1.1 * gauss(tau, 0.05, 0.035) : 0.5 * a * (gauss(tau, 0.02, 0.025) + gauss(tau, 0.07, 0.025));
      if (left) tDir = -1; else if (right) tDir = 1;
    } else if (e.bbb === 'R') {                                         // rsR' in V1-V2, wide slurred S in I, aVL, V5-V6; T inverted in V1-V3
      if (['V1', 'V2'].includes(lead)) { qrs = 0.3 * gauss(tau, 0, 0.012) - 0.35 * gauss(tau, 0.04, 0.012) + 0.85 * gauss(tau, 0.095, 0.02); tDir = -1; }
      else if (['I', 'aVL', 'V5', 'V6'].includes(lead)) qrs = Math.abs(a) * gauss(tau, 0, 0.011) - 0.4 * gauss(tau, 0.075, 0.03);
      else if (lead === 'V3') tDir = -1;
    }
    const stSeg = st * (tau > 0.05 * qw && tau < 0.32 * M.qt ? 1 : tau > 0.32 * M.qt && tau < 0.4 * M.qt ? (0.4 * M.qt - tau) / (0.08 * M.qt) : 0);
    const tw = 0.28 * (M.tAmp ?? 1) * tDir * Math.min(1, Math.abs(a) + 0.3) * gauss(tau, Math.min(0.26, rr * 0.38) * M.qt, 0.045 * (1 - 0.45 * (M.tNarrow || 0)));
    if (e.rhythm === 'FLUTTER') { const ph = (abs * 5) % 1, saw = ph < 0.75 ? ph / 0.75 : (1 - ph) / 0.25, fl = ['II', 'III', 'aVF'].includes(lead) ? -0.18 : lead === 'V1' ? 0.1 : -0.05; return qrs + stSeg + tw + fl * (saw - 0.5); }
    if (noP) return qrs + stSeg + tw;
    const blockedP = e.rhythm === 'AV_BLOCK2' ? 0.12 * Math.sign(a || 1) * gauss(tau, rr / 2 - 0.08, 0.025) : 0;
    const pw = blockedP + (e.rhythm === 'AF' ? 0.03 * Math.sin(tau * 45) : e.rhythm === 'SVT' ? 0 : 0.12 * (M.pAmp ?? 1) * Math.sign(a || 1) * gauss(tau, -0.16 - (M.prS || 0), 0.025));
    const sine = M.sine ? M.sine * 0.6 * Math.sin(2 * Math.PI * tau / rr) : 0;
    return (1 - (M.sine || 0)) * (qrs + stSeg + tw + pw) + sine;
  };
  // Wenckebach 4:3: sum the beats around time s (PR 160 -> 260 -> 340 ms, fourth P blocked)
  const wenck = (lead, s) => { const pp = 0.75 * rr, cyc = 4 * pp, PR = [0.16, 0.26, 0.34], c0 = Math.floor(s / cyc) * cyc, a = AXIS[lead]; let v = 0;
    for (const base of [c0 - cyc, c0]) for (let i = 0; i < 4; i++) { const tp = base + i * pp; v += 0.12 * Math.sign(a || 1) * gauss(s - tp, 0, 0.025); if (i < 3) { const tau = s - tp - PR[i]; if (tau > -0.1 && tau < 0.6) v += beat(lead, tau, s, true); } }
    return v; };
  const trace = (lead, x0, y0, secs) => {
    g.strokeStyle = '#111'; g.lineWidth = 1.3; g.beginPath();
    for (let i = 0; i <= secs * 25 * mm; i++) { const s = i / (25 * mm), ph = ((s + 0.35) % rr) - (rr > 0.6 ? 0.25 : rr * 0.4), y = y0 - (e.rhythm === 'AV_BLOCK2W' ? wenck(lead, s) : beat(lead, ph, s)) * 10 * mm; i ? g.lineTo(x0 + i, y) : g.moveTo(x0 + i, y); }
    g.stroke(); g.fillStyle = '#111'; g.font = '600 13px system-ui'; g.fillText(lead, x0 + 4, y0 - 40);
  };
  const order = [['I', 'aVR', 'V1', 'V4'], ['II', 'aVL', 'V2', 'V5'], ['III', 'aVF', 'V3', 'V6']];
  order.forEach((row, r) => row.forEach((lead, c) => trace(lead, 20 + c * 265, 90 + r * 125, 2.5)));
  g.font = '12px system-ui'; g.fillStyle = '#111'; g.fillText('II', 24, 430); trace('II', 20, 480, 10.4);
  const ov = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('od_ecg12') });
  const read = el('details', { class: 'small' }, el('summary', { text: t('e12_reading') }), el('p', { text: `${t('e12_rate')} ${e.rate}/min · QRS ${e.qrs} ms · QTc ${e.qtc} ms · ${e.findings.length ? e.findings.map(f => t('e12_' + f) || f).join(', ') : t('e12_normal')}` }));
  ov.append(el('div', { class: 'box ecg12-box' }, el('div', { class: 'phead' }, el('h2', { text: t('od_ecg12') }), el('button', { class: 'x', 'aria-label': t('close'), onclick: () => ov.remove(), text: '×' })),
    el('p', { class: 'muted small', text: t('e12_help') }), el('div', { class: 'ecg12-wrap' }, cv), read));
  ov.addEventListener('click', ev => { if (ev.target === ov) ov.remove(); });
  document.body.append(ov);
}
