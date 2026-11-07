# Asset licence

## Patient (`src/web/assets/patient.glb`, `src/web/assets/patient.json`)

The patient is generated from **MakeHuman** data through **MPFB** (MakeHuman Plugin For Blender):

- the MakeHuman base mesh, macro targets (gender, age, weight, muscle, proportions), default rig and skin weights,
  shipped inside MPFB 2.0.18;
- the MakeHuman **system assets pack** (`makehuman_system_assets_cc0.zip`): skin textures
  `young_lightskinned_male_diffuse.png` and `young_darkskinned_male_diffuse.png` (blended 50/50 for the neutral
  mid-tone albedo), eyes `low-poly` + `brown_eye.png`, eyebrows `eyebrow001`, hair `short02`.

The MakeHuman project released these assets under **CC0 1.0 Universal** (public domain dedication). The copyright
holders at the time of release were Data Collection AB, Joel Palmius and Jonas Hauquier (see the header of each
`.mhmat`/`.mhclo` file and http://www.makehumancommunity.org). Models exported from MakeHuman/MPFB are not encumbered
by the tool's licence.

Everything this repository adds (pose, shape-key extraction, baked albedo and normal maps, gown and sheet, COLOR_0
weights, landmark empties, `patient.json`) is also dedicated to the public domain under **CC0 1.0**.

## Instruments (`src/web/assets/instruments.glb`)

Modelled procedurally by `assets-src/build_instruments.py`, with no third-party assets. Dedicated to the public domain
under **CC0 1.0**.

## Build scripts

`assets-src/build_patient.py` and `assets-src/build_instruments.py` are part of this repository and fall under the
repository's own licence. MPFB itself is GPL-3.0-or-later. It is a build tool only: no MPFB code is shipped in the
exports or in `src/web/`.

CC0 1.0 legal code: https://creativecommons.org/publicdomain/zero/1.0/legalcode

The assets are for education and training. They are not anatomical reference data and not a validated medical device.
