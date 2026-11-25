// Cardiac rhythm catalogue and simple rhythm state. Waveforms are synthesised by the monitor from these parameters.
export const RHYTHMS = {
  NSR:        { key: 'NSR',        perfusing: true,  shockable: false, label: 'Normal sinus rhythm' },
  SINUS_BRADY:{ key: 'SINUS_BRADY',perfusing: true,  shockable: false, label: 'Sinus bradycardia' },
  SINUS_TACH: { key: 'SINUS_TACH', perfusing: true,  shockable: false, label: 'Sinus tachycardia' },
  AF:         { key: 'AF',         perfusing: true,  shockable: false, label: 'Atrial fibrillation' },
  SVT:        { key: 'SVT',        perfusing: true,  shockable: false, label: 'Supraventricular tachycardia' },
  FLUTTER:    { key: 'FLUTTER',    perfusing: true,  shockable: false, label: 'Atrial flutter' },
  AV_BLOCK1:  { key: 'AV_BLOCK1',  perfusing: true,  shockable: false, label: 'First-degree AV block' },
  AV_BLOCK2W: { key: 'AV_BLOCK2W', perfusing: true,  shockable: false, label: 'Second-degree AV block, Mobitz I (Wenckebach)' },
  AV_BLOCK2:  { key: 'AV_BLOCK2',  perfusing: true,  shockable: false, label: 'Second-degree AV block, Mobitz II (2:1)' },
  VT_PULSE:   { key: 'VT_PULSE',   perfusing: true,  shockable: false, label: 'Ventricular tachycardia with pulse' },
  AV_BLOCK3:  { key: 'AV_BLOCK3',  perfusing: true,  shockable: false, label: 'Complete heart block' },
  VT_PULSELESS:{ key: 'VT_PULSELESS', perfusing: false, shockable: true, label: 'Pulseless ventricular tachycardia' },
  TORSADES:   { key: 'TORSADES',   perfusing: false, shockable: true,  label: 'Torsades de pointes (polymorphic VT)' },   // treated as pulseless: defibrillate (REF erc2025)
  VF:         { key: 'VF',         perfusing: false, shockable: true,  label: 'Ventricular fibrillation' },
  PEA:        { key: 'PEA',        perfusing: false, shockable: false, label: 'Pulseless electrical activity' },
  ASYSTOLE:   { key: 'ASYSTOLE',   perfusing: false, shockable: false, label: 'Asystole' },
};
export const isPerfusing = k => RHYTHMS[k].perfusing;
export const isShockable = k => RHYTHMS[k].shockable;
