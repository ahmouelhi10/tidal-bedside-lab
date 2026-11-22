"""Tidal Bedside Lab - reproducible build of the realistic patient asset.

Builds src/web/assets/patient.glb (+ patient.json sidecar) from MakeHuman / MPFB (CC0 assets)
and writes check renders. See assets-src/README.md for every convention (axes, shape keys,
COLOR_0 encoding, landmark empties).

Requirements (tested): Blender 4.2 LTS, MPFB 2.0.18 extension, MakeHuman system assets pack (CC0)
installed into MPFB's user data folder.

Run from the repository root:
    blender -b --python assets-src/build_patient.py
    blender -b --python assets-src/build_patient.py -- --no-renders --no-blend

Everything is deterministic: no random numbers, fixed macro values, fixed pose angles.
"""
import bpy
import bmesh
import importlib
import json
import math
import os
import sys
import time

import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

T0 = time.time()
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT_GLB = os.path.join(REPO, 'src', 'web', 'assets', 'patient.glb')
OUT_JSON = os.path.join(REPO, 'src', 'web', 'assets', 'patient.json')
OUT_ALBEDO_F = os.path.join(REPO, 'src', 'web', 'assets', 'patient_albedo_female.jpg')
OUT_BLEND = os.path.join(HERE, 'patient.blend')
RENDER_DIR = os.path.join(HERE, 'renders')
TMP = os.path.join(HERE, 'build-tmp')


def log(*a):
    print('[patient %6.1fs]' % (time.time() - T0), *a, flush=True)


# ----------------------------------------------------------------------------- MPFB access
def _mpfb_base():
    for k in list(sys.modules):
        if k.endswith('.mpfb') and k.startswith('bl_ext.'):
            return k
    return 'bl_ext.user_default.mpfb'


MPFB = _mpfb_base()
HS = importlib.import_module(MPFB + '.services.humanservice').HumanService
TS = importlib.import_module(MPFB + '.services.targetservice').TargetService
LS = importlib.import_module(MPFB + '.services.locationservice').LocationService
UD = LS.get_user_data('')

# ----------------------------------------------------------------------------- configuration
# Basis = adult male, 25 years, average weight/muscle, mixed ancestry (MakeHuman macro values).
BASE_MACRO = dict(gender=1.0, age=0.5, muscle=0.5, weight=0.5, proportions=0.5, height=0.5,
                  cupsize=0.5, firmness=0.5, race=dict(asian=1 / 3, caucasian=1 / 3, african=1 / 3))
# MakeHuman macro: gender 0 = female, 1 = male; age 0.5 = 25 y, 1.0 = 90 y (linear between).
VARIANTS = {
    'B': {},
    'F': {'gender': 0.0},
    'O': {'age': 1.0},
    'H': {'weight': 1.0, 'muscle': 0.0},     # MakeHuman "heavy, low muscle" = adipose body
    'T': {'weight': 0.0, 'muscle': 0.0},     # MakeHuman "light, low muscle" = cachectic body
    'FH': {'gender': 0.0, 'weight': 1.0, 'muscle': 0.0},
    'FT': {'gender': 0.0, 'weight': 0.0, 'muscle': 0.0},
    'FO': {'gender': 0.0, 'age': 1.0},
}
SHAPE_KEYS = ['female', 'heavy', 'thin', 'old', 'female_heavy', 'female_thin', 'female_old']
# Face shape keys, posed with the MakeHuman default rig's face bones on the basis variant and stored as deltas on the body and the
# head assets. The app blends them every frame (blink, slack jaw, pain grimace, horizontal gaze; gaze is signed: +1 = to the patient's left).
FACE_KEYS = ['face_blink', 'face_jaw', 'face_pain', 'face_gaze']
DENSITY = 1.01            # kg/L whole-body density used to turn mesh volume into mass (design value)
BMI_HEAVY = 50.0          # heavy = 1 on the male basis reaches this BMI (at reference height)
BMI_THIN = 16.0           # thin = 1 on the male basis reaches this BMI (at reference height)
SKIN_LIGHT = os.path.join(UD, 'skins', 'young_caucasian_male', 'young_caucasian_male.mhmat')
SKIN_TONE_MIX = 0.5       # 0 = light texture, 1 = dark texture; 0.5 = neutral mid tone
TEX_SIZE = 2048
ASSETS = [  # (object key, MPFB asset type, mhclo path)
    ('eyes', 'Eyes', os.path.join(UD, 'eyes', 'low-poly', 'low-poly.mhclo')),
    ('eyebrows', 'Eyebrows', os.path.join(UD, 'eyebrows', 'eyebrow001', 'eyebrow001.mhclo')),
    ('hair', 'Hair', os.path.join(UD, 'hair', 'short02', 'short02.mhclo')),
    # female head: her own hair (pulled back in a braid, no fringe over the face), finer arched brows; eyelashes on both. The app shows the male or the
    # female set by the `female` weight, so male and female faces no longer share hair and brows.
    ('hair_f', 'Hair', os.path.join(UD, 'hair', 'braid01', 'braid01.mhclo')),
    ('eyebrows_f', 'Eyebrows', os.path.join(UD, 'eyebrows', 'eyebrow006', 'eyebrow006.mhclo')),
    ('eyelashes', 'Eyelashes', os.path.join(UD, 'eyelashes', 'eyelashes01', 'eyelashes01.mhclo')),
]
HEAD_ASSETS = [a[0] for a in ASSETS]
MALE_ONLY, FEMALE_ONLY = ('hair', 'eyebrows'), ('hair_f', 'eyebrows_f')
# Pose (degrees). Standing frame while posing: +Z up, body faces -Y, patient's left = +X.
POSE = dict(left_abduction=12.0, right_abduction=40.0, arm_extension=0.0,
            foot_plantarflexion=22.0, leg_external_rotation=8.0, leg_adduction=4.0)
# Region ids stored in COLOR_0.B as id / 10 (decode: id = round(B * 10)).
REGIONS = {'none': 0, 'head': 1, 'neck': 2, 'chestL': 3, 'chestR': 4, 'arms': 5, 'abdomen': 6, 'groin': 7, 'legs': 8}


# ----------------------------------------------------------------------------- scene helpers
def final_coll():
    c = bpy.data.collections.get('PATIENT')
    if not c:
        c = bpy.data.collections.new('PATIENT')
        bpy.context.scene.collection.children.link(c)
    return c


def clear_scene(keep_final=True):
    keep = set(final_coll().all_objects) if keep_final else set()
    for o in list(bpy.data.objects):
        if o not in keep:
            bpy.data.objects.remove(o, do_unlink=True)
    for _ in range(3):
        bpy.data.orphans_purge(do_local_ids=True, do_linked_ids=True, do_recursive=True)


def macro(over):
    m = json.loads(json.dumps(BASE_MACRO))
    m.update(over)
    return m


def body_indices(human):
    gi = human.vertex_groups['body'].index
    return np.array([v.index for v in human.data.vertices if any(g.group == gi and g.weight > 0.5 for g in v.groups)], dtype=np.int64)


def evaluated_world(ob):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    me = ev.to_mesh()
    co = np.empty(len(me.vertices) * 3, dtype=np.float64)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    M = np.array(ev.matrix_world)
    co = co @ M[:3, :3].T + M[:3, 3]
    ev.to_mesh_clear()
    return co


# ----------------------------------------------------------------------------- posing
def _upd():
    bpy.context.view_layer.update()


def rot_world(rig, bone, axis, angle):
    if abs(angle) < 1e-7:
        return
    pb = rig.pose.bones[bone]
    M = pb.matrix.copy()
    h = M.translation.copy()
    R = Matrix.Rotation(angle, 4, Vector(axis).normalized())
    pb.matrix = Matrix.Translation(h) @ R @ Matrix.Translation(-h) @ M
    _upd()


def align(rig, bone, cur, tgt):
    cur, tgt = Vector(cur).normalized(), Vector(tgt).normalized()
    ax = cur.cross(tgt)
    if ax.length < 1e-8:
        return
    rot_world(rig, bone, ax, cur.angle(tgt))


def move_world(rig, bone, d):
    pb = rig.pose.bones[bone]
    pb.matrix = Matrix.Translation(Vector(d)) @ pb.matrix
    _upd()


def face_pose(rig, key):
    """Standing frame: +X patient's left, -Y forward, +Z up. Angles in degrees, moves in metres (design values, judged on renders)."""
    r = lambda b, ax, deg: rot_world(rig, b, ax, math.radians(deg))
    for s, sx in (('L', 1.0), ('R', -1.0)):
        if key == 'face_blink':                       # upper lid down over the eye, lower lid up a little
            r('orbicularis03.' + s, (1, 0, 0), 30); r('orbicularis04.' + s, (1, 0, 0), -6)
        elif key == 'face_pain':                      # brows down and knitted, eyes squeezed, upper lip raised, mouth corners drawn back
            r('orbicularis03.' + s, (1, 0, 0), 14); r('orbicularis04.' + s, (1, 0, 0), -14)
            move_world(rig, 'oculi01.' + s, (-sx * 0.003, 0, -0.005)); move_world(rig, 'oculi02.' + s, (0, 0, -0.003))
            move_world(rig, 'levator05.' + s, (0, 0, 0.003)); move_world(rig, 'risorius03.' + s, (sx * 0.004, 0, 0.002))
        elif key == 'face_gaze':                      # both eyes turned 20 degrees toward the patient's left
            r('eye.' + s, (0, 0, 1), 20)
    if key == 'face_jaw':                             # slack jaw, mouth falls open
        r('jaw', (1, 0, 0), 7)


FACE_BONES = ('jaw', 'eye.L', 'eye.R', 'orbicularis03.L', 'orbicularis03.R', 'orbicularis04.L', 'orbicularis04.R', 'oculi01.L', 'oculi01.R',
              'oculi02.L', 'oculi02.R', 'levator05.L', 'levator05.R', 'risorius03.L', 'risorius03.R')


def H(rig, b):
    return rig.pose.bones[b].head.copy()


def palm_normal(rig, s):
    u = (H(rig, 'finger3-1.' + s) - H(rig, 'wrist.' + s)).normalized()        # along the hand
    w = (H(rig, 'finger2-1.' + s) - H(rig, 'finger5-1.' + s)).normalized()    # pinky -> index
    return (u.cross(w) if s == 'L' else w.cross(u)).normalized()


def pose_supine(rig):
    """Arms along the body (right on an arm board), palms toward the bed, feet relaxed. Standing frame."""
    for s, sx, ab in (('L', 1.0, POSE['left_abduction']), ('R', -1.0, POSE['right_abduction'])):
        a, e = math.radians(ab), math.radians(POSE['arm_extension'])
        tgt = Vector((sx * math.sin(a), math.sin(e), -math.cos(a))).normalized()
        sh, el = H(rig, 'upperarm01.' + s), H(rig, 'lowerarm01.' + s)
        align(rig, 'upperarm01.' + s, el - sh, tgt)
        el, wr = H(rig, 'lowerarm01.' + s), H(rig, 'wrist.' + s)
        align(rig, 'lowerarm01.' + s, wr - el, tgt)                     # straight elbow
        wr = H(rig, 'wrist.' + s)
        align(rig, 'wrist.' + s, H(rig, 'finger3-1.' + s) - wr, tgt)     # neutral wrist
        # pronate/supinate about the forearm axis until the palm faces the bed (+Y standing = posterior)
        f = (H(rig, 'wrist.' + s) - H(rig, 'lowerarm01.' + s)).normalized()
        p = palm_normal(rig, s)
        want = Vector((0, 1, 0))
        p1, w1 = (p - f * p.dot(f)).normalized(), (want - f * want.dot(f)).normalized()
        ang = math.atan2(f.dot(p1.cross(w1)), p1.dot(w1))
        rot_world(rig, 'lowerarm01.' + s, f, ang * 0.5)
        rot_world(rig, 'lowerarm02.' + s, f, ang * 0.5)
    for s, sx in (('L', 1.0), ('R', -1.0)):
        rot_world(rig, 'upperleg01.' + s, (0, 1, 0), sx * math.radians(POSE['leg_adduction']))
        rot_world(rig, 'upperleg01.' + s, (0, 0, 1), sx * math.radians(POSE['leg_external_rotation']))
        rot_world(rig, 'foot.' + s, (1, 0, 0), math.radians(POSE['foot_plantarflexion']))
    return {s: [round(x, 3) for x in palm_normal(rig, s)] for s in 'LR'}


def group_mask(human, idx, prefixes, side, thr=0.3):
    gi = {g.index for g in human.vertex_groups if g.name.endswith('.' + side) and g.name.startswith(prefixes)}
    full = np.zeros(len(human.data.vertices), bool)
    for v in human.data.vertices:
        if any(g.group in gi and g.weight > thr for g in v.groups):
            full[v.index] = True
    return full[idx]


def settle_on_bed(rig, human, idx):
    """Lying on a mattress: extend hips and shoulders until the calves/heels and the forearms/hands touch the
    posterior plane that is tangent to the back (scapulae, buttocks). Standing frame: posterior = +Y."""
    legs = {s: group_mask(human, idx, ('lowerleg', 'foot', 'toe'), s) for s in 'LR'}
    arms = {s: group_mask(human, idx, ('lowerarm', 'wrist', 'finger', 'metacarpal'), s) for s in 'LR'}
    P = evaluated_world(human)[idx]
    hipz = 0.5 * (H(rig, 'upperleg01.L').z + H(rig, 'upperleg01.R').z)
    shz = 0.5 * (H(rig, 'upperarm01.L').z + H(rig, 'upperarm01.R').z)
    trunk = (P[:, 2] > hipz - 0.08) & (P[:, 2] < shz) & (np.abs(P[:, 0]) < 0.6 * abs(H(rig, 'upperarm01.L').x))
    y_back = float(P[trunk, 1].max())
    total = {}
    for _ in range(3):
        P = evaluated_world(human)[idx]
        for s in 'LR':
            hip = H(rig, 'upperleg01.' + s)
            m = np.where(legs[s])[0]
            v = P[m[np.argmax(P[m, 1])]]
            th = math.atan2(y_back - v[1], hip.z - v[2])
            rot_world(rig, 'upperleg01.' + s, (1, 0, 0), th)
            total['hip.' + s] = total.get('hip.' + s, 0) + math.degrees(th)
            sh = H(rig, 'upperarm01.' + s)
            d = (H(rig, 'wrist.' + s) - sh).normalized()
            k = d.cross(Vector((0, 1, 0)))
            m = np.where(arms[s])[0]
            v = P[m[np.argmax(P[m, 1])]]
            r = max(float(np.linalg.norm(v - np.array(sh))), 0.1)
            th = math.asin(max(-1.0, min(1.0, (y_back - v[1]) / r)))
            rot_world(rig, 'upperarm01.' + s, k, th)
            total['shoulder.' + s] = total.get('shoulder.' + s, 0) + math.degrees(th)
    return {k: round(v, 1) for k, v in total.items()}


# ----------------------------------------------------------------------------- variants
BONES_FOR_LANDMARKS = ['head', 'neck01', 'neck02', 'neck03', 'spine01', 'spine02', 'spine03', 'spine04', 'spine05',
                       'clavicle.L', 'clavicle.R', 'shoulder01.L', 'shoulder01.R', 'upperarm01.L', 'upperarm01.R',
                       'lowerarm01.L', 'lowerarm01.R', 'wrist.L', 'wrist.R', 'upperleg01.L', 'upperleg01.R',
                       'upperleg02.L', 'upperleg02.R']


def build_variant(key, keep=False):
    clear_scene()
    human = HS.create_human(mask_helpers=True, detailed_helpers=True, extra_vertex_groups=True,
                            feet_on_ground=True, scale=0.1, macro_detail_dict=macro(VARIANTS[key]))
    rig = HS.add_builtin_rig(human, 'default')
    if keep:
        HS.set_character_skin(SKIN_LIGHT, human, skin_type='ENHANCED_SSS')
    objs = {}
    for k, typ, path in ASSETS:
        objs[k] = HS.add_mhclo_asset(path, human, asset_type=typ, subdiv_levels=0, material_type='MAKESKIN')
    for m in human.modifiers:
        if m.type == 'MASK':
            m.show_viewport = m.show_render = False
    _upd()
    rest = evaluated_world(human)
    idx = body_indices(human)
    stature = float(rest[idx, 2].max() - rest[idx, 2].min())
    palms = pose_supine(rig)
    contact = settle_on_bed(rig, human, idx)
    out = {'body': evaluated_world(human)[idx]}
    for k in objs:
        out[k] = evaluated_world(objs[k])
    bones = {b: [list(rig.pose.bones[b].head), list(rig.pose.bones[b].tail)] for b in BONES_FOR_LANDMARKS}
    info = dict(stature=stature, sole=float(rest[idx, 2].min()), palms=palms, bones=bones, contact=contact)
    if keep:                                          # face expressions, captured before the pose is frozen
        saved = {b: rig.pose.bones[b].matrix_basis.copy() for b in FACE_BONES}
        info['face'] = {}
        for fk in FACE_KEYS:
            face_pose(rig, fk)
            info['face'][fk] = {'body': evaluated_world(human)[idx], **{k: evaluated_world(objs[k]) for k in objs}}
            for b, m in saved.items():
                rig.pose.bones[b].matrix_basis = m
            _upd()
    finals = None
    if keep:
        finals = make_final_objects(human, objs, idx)
        info['weights'] = bone_weights(human, rig, idx)
        info['groups'] = {g: group_members(human, g, idx) for g in ('nipple', 'lips')}
    log('variant', key, 'stature %.3f m' % stature, 'palms', palms, 'contact', contact)
    return out, info, finals


def group_members(human, name, idx):
    gi = human.vertex_groups[name].index
    full = {v.index for v in human.data.vertices if any(g.group == gi and g.weight > 0.5 for g in v.groups)}
    return [i for i, j in enumerate(idx) if j in full]


def bone_weights(human, rig, idx):
    names = {b.name for b in rig.data.bones}
    gname = {g.index: g.name for g in human.vertex_groups if g.name in names}
    res = []
    for j in idx:
        res.append({gname[g.group]: g.weight for g in human.data.vertices[int(j)].groups if g.group in gname and g.weight > 1e-4})
    return res


def make_final_objects(human, objs, idx):
    """Freeze the posed basis variant into plain meshes (pose applied, helpers removed)."""
    dg = bpy.context.evaluated_depsgraph_get()
    res = {}
    coll = final_coll()
    for name, ob in [('body', human)] + list(objs.items()):
        ev = ob.evaluated_get(dg)
        me = bpy.data.meshes.new_from_object(ev, preserve_all_data_layers=True, depsgraph=dg)
        me.transform(ev.matrix_world)
        if name == 'body':
            keep = np.zeros(len(me.vertices), bool)
            keep[idx] = True
            bm = bmesh.new()
            bm.from_mesh(me)
            bm.verts.ensure_lookup_table()
            bmesh.ops.delete(bm, geom=[v for v in bm.verts if not keep[v.index]], context='VERTS')
            bm.to_mesh(me)
            bm.free()
        me.name = 'patient_' + name
        o = bpy.data.objects.new('patient_' + name, me)
        coll.objects.link(o)
        res[name] = o
    return res


# ----------------------------------------------------------------------------- geometry utils
def tri_indices(me):
    me.calc_loop_triangles()
    t = np.empty(len(me.loop_triangles) * 3, dtype=np.int64)
    me.loop_triangles.foreach_get('vertices', t)
    return t.reshape(-1, 3)


def volume(P, T):
    a, b, c = P[T[:, 0]], P[T[:, 1]], P[T[:, 2]]
    return abs(np.einsum('ij,ij->i', a, np.cross(b, c)).sum() / 6.0)


def vnormals(P, T):
    fn = np.cross(P[T[:, 1]] - P[T[:, 0]], P[T[:, 2]] - P[T[:, 0]])
    n = np.zeros_like(P)
    for k in range(3):
        np.add.at(n, T[:, k], fn)
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)


def to_supine(P, H0, back):
    """Standing frame (Z up, facing -Y, left +X, soles z=0, height-normalised) -> supine export frame.
    Blender supine frame: +X toward the head (crown at x=0), +Z anterior (up, back on z=0), +Y = patient's right.
    glTF (+Y up) export maps this to: +X head, +Y anterior/up, +Z patient's left."""
    Q = np.empty_like(P)
    Q[:, 0] = P[:, 2] - H0
    Q[:, 1] = -P[:, 0]
    Q[:, 2] = -P[:, 1] - back
    return Q


# ----------------------------------------------------------------------------- main build
def main():
    bpy.context.preferences.filepaths.save_version = 0      # no .blend1 backups
    no_renders = '--no-renders' in ARGS
    os.makedirs(TMP, exist_ok=True)
    os.makedirs(os.path.dirname(OUT_GLB), exist_ok=True)
    clear_scene(keep_final=False)
    for c in list(bpy.data.collections):
        bpy.data.collections.remove(c)

    raw, infos, finals = {}, {}, None
    for key in VARIANTS:
        raw[key], infos[key], f = build_variant(key, keep=(key == 'B'))
        if f:
            finals = f
            # move the frozen basis out of MPFB's reach before the next variant clears the scene
    clear_scene()
    body = finals['body']
    T = tri_indices(body.data)
    H0 = infos['B']['stature']

    raw0 = {k: v.copy() for k, v in raw['B'].items()}
    # height-normalise every variant about the soles (app scales uniformly to the patient's height)
    for key in VARIANTS:
        s = H0 / infos[key]['stature']
        for k in raw[key]:
            raw[key][k] = raw[key][k] * s

    # ------------------------------------------------- linear shape-key deltas (standing frame)
    def bmi_of(Pbody):
        return DENSITY * volume(Pbody, T) * 1000.0 / (H0 ** 2)

    def solve_k(dname, target, base='B'):
        B, D = raw[base]['body'], raw[dname]['body'] - raw[base]['body']
        lo, hi = 0.0, 3.0
        f = lambda k: bmi_of(B + k * D) - target
        if f(lo) * f(hi) > 0:
            return 1.0
        for _ in range(60):
            mid = 0.5 * (lo + hi)
            if f(lo) * f(mid) <= 0:
                hi = mid
            else:
                lo = mid
        return 0.5 * (lo + hi)

    # heavy = 1 and thin = 1 reach the same target BMI for both sexes (female via the correctives)
    kH, kT = solve_k('H', BMI_HEAVY), solve_k('T', BMI_THIN)
    kHF, kTF = solve_k('FH', BMI_HEAVY, 'F'), solve_k('FT', BMI_THIN, 'F')
    log('heavy scale %.3f (female %.3f), thin scale %.3f (female %.3f)' % (kH, kHF, kT, kTF))

    def deltas(obj):
        r = {k: raw[k][obj] for k in VARIANTS}
        B = r['B']
        return {
            'female': r['F'] - B, 'heavy': kH * (r['H'] - B), 'thin': kT * (r['T'] - B), 'old': r['O'] - B,
            'female_heavy': kHF * (r['FH'] - r['F']) - kH * (r['H'] - B),
            'female_thin': kTF * (r['FT'] - r['F']) - kT * (r['T'] - B),
            'female_old': r['FO'] - r['F'] - r['O'] + B,
        }

    D = {k: deltas(k) for k in ['body'] + [a[0] for a in ASSETS]}

    def combo(obj, w):
        P = raw['B'][obj].copy()
        for k, v in w.items():
            if v:
                P += v * D[obj][k]
        return P

    def weights(female=0.0, heavy=0.0, thin=0.0, old=0.0):
        return {'female': female, 'heavy': heavy, 'thin': thin, 'old': old, 'female_heavy': female * heavy,
                'female_thin': female * thin, 'female_old': female * old}

    # back resting on the bed: per key, the lowest posterior point stays on z = 0
    def back_of(Pstand):
        return float((-Pstand[:, 1]).min())

    # ------------------------------------------------- BMI calibration table (reference height H0)
    grid = [round(x, 2) for x in np.linspace(0, 1, 11)]
    calib = {}
    for sex, fem in (('male', 0.0), ('female', 1.0)):
        for ag, old in (('25y', 0.0), ('90y', 1.0)):
            calib['%s_%s' % (sex, ag)] = {
                'heavy': [round(bmi_of(combo('body', weights(fem, heavy=w, old=old))), 2) for w in grid],
                'thin': [round(bmi_of(combo('body', weights(fem, thin=w, old=old))), 2) for w in grid]}
    log('calibration', json.dumps(calib))

    # ------------------------------------------------- write geometry + shape keys in the supine frame
    back0 = back_of(raw['B']['body'])
    to_s = lambda P, back: to_supine(P, H0, back)
    supine = {}
    for obj in ['body'] + [a[0] for a in ASSETS]:
        supine[obj] = {'Basis': to_s(raw['B'][obj], back0)}
    for key in SHAPE_KEYS:
        w = {k: 0.0 for k in SHAPE_KEYS}
        w[key] = 1.0
        if key.startswith('female_'):
            # correctives: store pure deltas; the back offset of the combination is folded into the parts
            for obj in supine:
                supine[obj][key] = supine[obj]['Basis'] + _rot(D[obj][key])
            continue
        Pb = combo('body', w)
        back = back_of(Pb)
        for obj in supine:
            supine[obj][key] = to_s(combo(obj, w), back)

    for obj, keys in supine.items():
        ob = finals[obj]
        set_coords(ob, keys['Basis'])
        ob.data.shade_smooth() if hasattr(ob.data, 'shade_smooth') else None
        ob.shape_key_add(name='Basis', from_mix=False)
        for key in SHAPE_KEYS:
            kb = ob.shape_key_add(name=key, from_mix=False)
            kb.data.foreach_set('co', keys[key].astype(np.float32).ravel())
            kb.slider_min, kb.slider_max = 0.0, 1.0
        if obj == 'body' or obj in HEAD_ASSETS:       # face expression deltas (rotation only: the basis variant is already height H0)
            for fk in FACE_KEYS:
                kb = ob.shape_key_add(name=fk, from_mix=False)
                kb.data.foreach_set('co', (keys['Basis'] + _rot(infos['B']['face'][fk][obj] - raw0[obj])).astype(np.float32).ravel())
                kb.slider_min, kb.slider_max = -1.0, 1.0
    bpy.context.view_layer.update()
    # the braid's tail lies under the head and back on the mattress (x < -0.20 m, the nape down): never visible, so it is dropped
    # (shape keys follow, bmesh keeps them); this keeps patient.glb within its download budget
    hf = finals['hair_f']
    bm = bmesh.new()
    bm.from_mesh(hf.data)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.x < -0.20], context='VERTS')
    bm.to_mesh(hf.data)
    bm.free()
    log('hair_f trimmed to', len(hf.data.vertices), 'vertices')

    Pb = supine['body']['Basis']
    Nb = vnormals(Pb, T)

    # ------------------------------------------------- regions, breathing and compression weights
    info = infos['B']
    region, chestish = regions_from_weights(info['weights'], raw['B']['body'])
    log('regions', {k: int((region == v).sum()) for k, v in REGIONS.items()})
    lm = landmarks(raw['B']['body'], region, info, H0)
    lm_pos = {k: Pb[v] for k, v in lm.items()}
    up = Nb[:, 2]
    R = np.clip(chestish * np.clip((up + 0.25) / 0.85, 0, 1), 0, 1)
    R = smooth_field(R, T, 4)
    st = lm_pos['sternum']
    d = np.linalg.norm(Pb - st, axis=1)
    G = np.exp(-(d ** 2) / (2 * 0.065 ** 2)) * np.clip((up + 0.1) / 0.8, 0, 1) * (region != REGIONS['arms'])
    G[G < 0.02] = 0
    Bc = region.astype(np.float64) / 10.0
    paint_color(body, np.stack([R, G, Bc], 1))
    for obj in HEAD_ASSETS:
        n = len(finals[obj].data.vertices)
        paint_color(finals[obj], np.tile([0.0, 0.0, REGIONS['head'] / 10.0], (n, 1)))

    # ------------------------------------------------- gown + sheet bound to the body surface
    colors = np.stack([R, G, Bc], 1)
    S = body_states(Pb, supine['body'])
    gown, Gs, gown_cols = build_gown(body, region, Pb, T, S, raw['B']['body'], colors, info['bones'])
    x_top = float(lm_pos['abdomen'][0]) + 0.03                 # just above the umbilicus
    x_bot = -0.60 * H0                                          # mid-thigh
    sheet = build_sheet(Pb, T, S, gown, Gs, gown_cols, colors, x_top, x_bot)

    # ------------------------------------------------- textures and materials
    bake_skin(body)
    make_materials(finals, gown, sheet)

    # ------------------------------------------------- landmark empties
    coll = final_coll()
    for name, vi in lm.items():
        e = bpy.data.objects.new(name, None)
        e.empty_display_type = 'SPHERE'
        e.empty_display_size = 0.015
        e.location = Vector(Pb[vi])
        e['anchorVertex'] = int(vi)
        e['region'] = int(region[vi])
        coll.objects.link(e)

    # ------------------------------------------------- metadata
    meta = {
        'generator': 'assets-src/build_patient.py (Blender %s, MPFB %s)' % (bpy.app.version_string, mpfb_version()),
        'units': 'metres', 'up': '+Y',
        'orientation': 'supine; +X toward the head (crown at x=0, soles at x=-referenceHeight), +Y anterior (up), '
                       '+Z patient\'s left, -Z patient\'s right; back rests on y=0; midsagittal plane z=0',
        'referenceHeight': round(H0, 4),
        'heightRule': 'scale the whole patient uniformly by height/referenceHeight about the crown (origin); '
                      'BMI scales with that factor too: BMI(h) = BMI_ref * h / referenceHeight',
        'shapeKeys': SHAPE_KEYS,
        'faceKeys': FACE_KEYS,
        'shapeKeyRules': {
            'female': '0 = male, 1 = female', 'old': 'clamp((age - 25) / 65, 0, 1)',
            'heavy': 'BMI above the basis; pick from calibration (1 = BMI %.0f male)' % BMI_HEAVY,
            'thin': 'BMI below the basis; pick from calibration (1 = BMI %.0f male)' % BMI_THIN,
            'female_heavy': 'female * heavy', 'female_thin': 'female * thin', 'female_old': 'female * old',
            'exclusive': 'use heavy or thin, never both'},
        'basis': {'sex': 'male', 'ageYears': 25, 'bmiRef': round(bmi_of(raw['B']['body']), 2)},
        'bmiCalibration': {'weights': grid, 'density_kg_per_L': DENSITY, 'atReferenceHeight': True, 'table': calib},
        'morphScale': {'heavy': round(kH, 4), 'thin': round(kT, 4), 'femaleHeavy': round(kHF, 4), 'femaleThin': round(kTF, 4)},
        'color0': {'R': 'breathing weight 0..1 (chest and abdomen, anterior)', 'G': 'chest-compression weight 0..1 (sternum)',
                   'B': 'region id / 10, decode id = round(B * 10)', 'A': '1', 'regions': REGIONS},
        'landmarks': {k: {'anchorVertex': int(v), 'position': [round(float(x), 4) for x in gltf_vec(Pb[v])],
                          'region': int(region[v])} for k, v in lm.items()},
        'meshes': {}, 'macros': {k: macro(v) for k, v in VARIANTS.items()},
        'pose': POSE, 'palmNormalsStanding': info['palms'],
    }
    bpy.context.scene['tidal_patient'] = json.dumps(meta)

    if '--no-blend' not in ARGS:
        bpy.ops.wm.save_as_mainfile(filepath=OUT_BLEND, compress=True)
        log('saved', OUT_BLEND)
    export_glb(meta)
    if not no_renders:
        renders(finals, gown, sheet, calib, lm)
    log('done')


def _rot(Dstand):
    """Rotate a standing-frame delta into the supine frame (no translation)."""
    Q = np.empty_like(Dstand)
    Q[:, 0] = Dstand[:, 2]
    Q[:, 1] = -Dstand[:, 0]
    Q[:, 2] = -Dstand[:, 1]
    return Q


def gltf_vec(p):
    return [p[0], p[2], -p[1]]


def mpfb_version():
    try:
        import addon_utils
        for m in addon_utils.modules():
            if m.__name__ == MPFB:
                return '.'.join(map(str, getattr(m, 'bl_info', {}).get('version', ()))) or '2.0.18'
    except Exception:
        pass
    return '2.0.18'


def set_coords(ob, P):
    ob.data.vertices.foreach_set('co', P.astype(np.float32).ravel())
    ob.data.update()


def smooth_field(F, T, it):
    e = np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]])
    e = np.concatenate([e, e[:, ::-1]])
    deg = np.bincount(e[:, 0], minlength=len(F)).astype(np.float64)
    for _ in range(it):
        acc = np.bincount(e[:, 0], weights=F[e[:, 1]], minlength=len(F))
        F = (F + acc) / (1 + deg)
    return F


def paint_color(ob, rgb):
    me = ob.data
    for a in list(me.color_attributes):
        me.color_attributes.remove(a)
    a = me.color_attributes.new('COLOR_0', 'FLOAT_COLOR', 'POINT')
    rgba = np.concatenate([rgb, np.ones((len(rgb), 1))], 1).astype(np.float32)
    a.data.foreach_set('color', rgba.ravel())
    me.color_attributes.active_color = a
    me.color_attributes.render_color_index = me.color_attributes.active_color_index


# ----------------------------------------------------------------------------- regions + landmarks
HEAD_BONE_HINTS = ('head', 'jaw', 'eye', 'tongue', 'oris', 'levator', 'orbicularis', 'temporalis', 'oculi',
                   'risorius', 'special', 'cheek', 'nose', 'brow', 'lip', 'mandible', 'teeth')


def bone_region(b):
    if b.startswith('neck'):
        return 'neck'
    if any(h in b for h in HEAD_BONE_HINTS):
        return 'head'
    if b in ('spine01', 'spine02') or b.startswith('clavicle') or b.startswith('breast') or b.startswith('pectoral'):
        return 'chest'
    if b in ('spine03', 'spine04', 'spine05'):
        return 'abdomen'
    if b.startswith('pelvis') or b.startswith('upperleg01'):
        return 'groin'
    if b.startswith(('upperleg', 'lowerleg', 'foot', 'toe')):
        return 'legs'
    if b.startswith(('shoulder', 'upperarm', 'lowerarm', 'wrist', 'finger', 'metacarpal', 'thumb')):
        return 'arms'
    if b == 'root':
        return 'groin'
    return 'abdomen'


def regions_from_weights(W, Pst):
    n = len(W)
    region = np.zeros(n, np.int64)
    chestish = np.zeros(n)
    for i, w in enumerate(W):
        acc = {}
        for b, x in w.items():
            r = bone_region(b)
            acc[r] = acc.get(r, 0) + x
        tot = sum(acc.values()) or 1
        chestish[i] = (acc.get('chest', 0) + acc.get('abdomen', 0)) / tot
        r = max(acc, key=acc.get) if acc else 'none'
        if r == 'chest':
            r = 'chestL' if Pst[i, 0] >= 0 else 'chestR'
        region[i] = REGIONS[r]
    return region, chestish


def landmarks(P, region, info, H0):
    """Landmarks on the skin in the standing posed frame (Z up, anterior -Y, left +X); returns vertex ids."""
    bn = {k: np.array(v[0]) for k, v in info['bones'].items()}
    bt = {k: np.array(v[1]) for k, v in info['bones'].items()}
    trunk = np.isin(region, [REGIONS['chestL'], REGIONS['chestR'], REGIONS['abdomen']])

    def extreme(mask, c, d, r):
        d = np.asarray(d, float) / np.linalg.norm(d)
        v = P - c
        along = v @ d
        perp = np.linalg.norm(v - np.outer(along, d), axis=1)
        cand = np.where(mask & (perp < r))[0]
        if len(cand) == 0:
            log('landmark fallback (no surface candidate) at', np.round(c, 3).tolist())
            cand = np.where(mask)[0]
            return int(cand[np.argmin(np.linalg.norm(P[cand] - c, axis=1))])
        return int(cand[np.argmax(along[cand])])

    nip = P[info['groups']['nipple']]
    z_nip = float(nip[:, 2].mean())
    z_notch = float(max(bn['clavicle.L'][2], bn['clavicle.R'][2]))
    x_mcl = 0.5 * abs(bn['upperarm01.L'][0] - bn['upperarm01.R'][0]) * 0.5
    ant = (0, -1, 0)
    lm = {}
    lm['sternum'] = extreme(trunk, np.array([0, 0, z_nip - 0.01]), ant, 0.012)
    lips = np.array(info['groups']['lips'])
    z_lip = float(P[lips, 2].mean())
    head = region == REGIONS['head']
    lm['airway'] = extreme(head, np.array([0, 0, z_lip]), ant, 0.006)
    nose = extreme(head & (np.abs(P[:, 0]) < 0.006) & (P[:, 2] > z_lip), np.array([0, 0, z_lip + 0.03]), ant, 0.03)
    z_face = 0.5 * (P[nose, 2] + z_lip)
    lm['face'] = extreme(head, np.array([0, 0, z_face]), ant, 0.006)
    neckm = (region == REGIONS['neck']) & (np.abs(P[:, 0]) < 0.008) & (P[:, 1] < bn['neck01'][1])
    zs = P[neckm, 2]
    z_ct = float(zs.min() + 0.55 * (zs.max() - zs.min())) if len(zs) else float(bn['neck02'][2])
    lm['neck'] = extreme(region == REGIONS['neck'], np.array([0, 0, z_ct]), ant, 0.008)
    arms = region == REGIONS['arms']
    lm['rightArmIV'] = extreme(arms & (P[:, 0] < 0), bn['lowerarm01.R'], ant, 0.02)
    lm['leftArm'] = extreme(arms & (P[:, 0] > 0), bn['lowerarm01.L'], ant, 0.02)
    lm['abdomen'] = extreme(region == REGIONS['abdomen'], np.array([0, 0, 0.60 * H0]), ant, 0.008)
    hipR = bn['upperleg01.R']
    groinish = np.isin(region, [REGIONS['groin'], REGIONS['legs']]) & (P[:, 0] < 0)
    lm['femoral'] = extreme(groinish, np.array([hipR[0] * 0.9, 0, hipR[2] - 0.03]), ant, 0.015)
    # geometric torso (pectorals included even where the skin weights call them "arms"; hanging arm excluded)
    x_sh = 0.5 * abs(bn['upperarm01.L'][0] - bn['upperarm01.R'][0])
    z_ax = 0.5 * (bn['upperarm01.L'][2] + bn['upperarm01.R'][2]) - 0.07
    z_hip = 0.5 * (bn['upperleg01.L'][2] + bn['upperleg01.R'][2])
    torso = (P[:, 2] > z_hip) & (P[:, 2] < z_notch + 0.03) & (np.abs(P[:, 0]) < x_sh)
    torso &= ~np.isin(region, [REGIONS['head'], REGIONS['neck'], REGIONS['legs']])
    torso &= ~((region == REGIONS['arms']) & (P[:, 2] < z_ax))
    for side, sx in (('R', -1.0), ('L', 1.0)):
        half = torso & (np.sign(P[:, 0]) == sx)
        lm[side + '_mcl2'] = extreme(half, np.array([sx * x_mcl, 0, z_notch - 0.055]), ant, 0.025)
        z5 = z_nip - 0.025
        sl = half & (np.abs(P[:, 2] - z5) < 0.012)
        c = P[torso & (np.abs(P[:, 2] - z5) < 0.012)].mean(0)
        lm[side + '_mal5'] = extreme(sl, c, (sx, 0, 0), 0.02)
        x_mal = abs(P[lm[side + '_mal5'], 0])
        lm[side + '_aal5'] = extreme(sl, np.array([sx * 0.85 * x_mal, 0, z5]), ant, 0.02)
        if side == 'R':
            lm['padRight'] = extreme(half, np.array([sx * x_mcl * 0.8, 0, z_notch - 0.07]), ant, 0.025)
        else:
            lm['padLeft'] = extreme(sl, np.array([sx * 0.95 * x_mal, 0, z5]), ant, 0.02)
    return lm


# ----------------------------------------------------------------------------- gown + sheet
def body_states(Pb, Bk):
    """Body positions for the basis, every pure key, and each corrective's full combination."""
    S = {'Basis': Pb}
    for k in SHAPE_KEYS:
        if k.startswith('female_'):
            part = k.split('_')[1]
            S[k] = Bk['female'] + Bk[part] - Pb + (Bk[k] - Pb)
        else:
            S[k] = Bk[k]
    return S


def keys_from_states(G):
    """Shape-key positions of a dependent mesh from its positions in each body state (correctives as differences)."""
    out = {}
    for k in SHAPE_KEYS:
        if k.startswith('female_'):
            part = k.split('_')[1]
            out[k] = G[k] - G['female'] - G[part] + 2 * G['Basis']
        else:
            out[k] = G[k]
    return out


def largest_component(bm):
    bm.verts.ensure_lookup_table()
    seen, best = set(), []
    for v in bm.verts:
        if v in seen:
            continue
        comp, stack = [], [v]
        seen.add(v)
        while stack:
            x = stack.pop()
            comp.append(x)
            for e in x.link_edges:
                y = e.other_vert(x)
                if y not in seen:
                    seen.add(y)
                    stack.append(y)
        if len(comp) > len(best):
            best = comp
    keep = set(best)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v not in keep], context='VERTS')


def add_keys(ob, basis, keys):
    set_coords(ob, basis)
    ob.shape_key_add(name='Basis', from_mix=False)
    for key in SHAPE_KEYS:
        kb = ob.shape_key_add(name=key, from_mix=False)
        kb.data.foreach_set('co', keys[key].astype(np.float32).ravel())
        kb.slider_min, kb.slider_max = 0.0, 1.0


GOWN_OFFSET = 0.022       # m total inflation along the normals
GOWN_STEPS = 6            # inflate/relax iterations
GOWN_SMOOTH = 3           # smoothing passes per iteration
GOWN_MIN_GAP = 0.012      # m, never closer to the skin than this
SHEET_GAP = 0.012         # m above skin or gown
SHEET_SLOPE = 1.6         # drop per metre where the sheet hangs off the body (about 58 degrees)
SHEET_STEP = 0.025        # m grid spacing
SHEET_HALF_WIDTH = 0.34   # m, between the hips and the arm-board arm


def build_gown(body, region, Pb, T, S, Pst, colors, bones):
    """Sleeveless hospital gown over the trunk: an offset shell of the body cut by clean planes and spheres
    (neckline at the sternal notch, round armholes, hem at the hip joints). The shell is rebuilt from every body
    state (basis, each key, each corrective combination) with identical operations on identical topology, so every
    body shape key is transferred exactly and the gown stays smooth on every morph."""
    bn = {k: np.array(v[0]) for k, v in bones.items()}
    z_top = max(bn['clavicle.L'][2], bn['clavicle.R'][2]) + 0.005
    z_bot = 0.5 * (bn['upperleg01.L'][2] + bn['upperleg01.R'][2]) - 0.01
    ok = (Pst[:, 2] <= z_top) & (Pst[:, 2] >= z_bot)
    ok &= ~np.isin(region, [REGIONS['arms'], REGIONS['head'], REGIONS['neck'], REGIONS['legs']])
    for s in 'LR':
        ok &= np.linalg.norm(Pst - bn['upperarm01.' + s], axis=1) > 0.075
    me = body.data.copy()
    me.name = 'patient_gown'
    ob = bpy.data.objects.new('patient_gown', me)
    final_coll().objects.link(ob)
    if ob.data.shape_keys:
        ob.shape_key_clear()
    set_coords(ob, Pb)
    bm = bmesh.new()
    bm.from_mesh(me)
    lay = bm.verts.layers.int.new('orig')
    for v in bm.verts:
        v[lay] = v.index
    bm.verts.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if not all(ok[v.index] for v in f.verts)], context='FACES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    largest_component(bm)
    orig = np.array([v[lay] for v in bm.verts], dtype=np.int64)
    bm.verts.layers.int.remove(lay)
    bm.to_mesh(me)                           # topology template (vertex order = orig order)
    bm.free()
    for a_ in list(me.color_attributes):
        me.color_attributes.remove(a_)
    log('gown faces', len(me.polygons))

    def shell(Pbody):
        """Same deterministic operations for every body state, so vertex i always corresponds."""
        b2 = bmesh.new()
        b2.from_mesh(me)
        b2.verts.ensure_lookup_table()
        for i, v in enumerate(b2.verts):
            v.co = Vector(Pbody[orig[i]])
        for _ in range(14):                  # straighten the hems (1-D smoothing along each boundary loop)
            new = {}
            for v in b2.verts:
                if v.is_boundary:
                    nb = [e.other_vert(v) for e in v.link_edges if e.is_boundary]
                    if len(nb) == 2:
                        new[v] = v.co * 0.5 + (nb[0].co + nb[1].co) * 0.25
            for v, c in new.items():
                v.co = c
        for _ in range(GOWN_STEPS):          # inflate a little, then relax: a loose garment, no anatomy imprint
            b2.normal_update()
            for v in b2.verts:
                v.co += v.normal * (GOWN_OFFSET / GOWN_STEPS)
            for _ in range(GOWN_SMOOTH):
                bmesh.ops.smooth_vert(b2, verts=b2.verts[:], factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
        q = np.array([v.co[:] for v in b2.verts])
        b2.free()
        bvh_s = BVHTree.FromPolygons([Vector(p) for p in Pbody], T.tolist())
        for _ in range(2):                   # collision: never closer to the skin than GOWN_MIN_GAP
            for i in range(len(q)):
                loc, nrm, _, _ = bvh_s.find_nearest(Vector(q[i]))
                d = (Vector(q[i]) - loc).dot(nrm)
                if d < GOWN_MIN_GAP:
                    q[i] = np.array(loc + nrm * GOWN_MIN_GAP)
        q[:, 2] = np.maximum(q[:, 2], 0.002)          # the back of the gown lies on the mattress
        return q
    G = {s_: shell(P_) for s_, P_ in S.items()}
    add_keys(ob, G['Basis'], keys_from_states(G))
    cols = colors[orig].copy()
    paint_color(ob, cols)
    for p in me.polygons:
        p.use_smooth = True
    return ob, G, cols


def build_sheet(Pb, T, S, gown, G, gown_cols, colors, x_top, x_bot):
    """Sheet draped over the pelvis and thighs: a grid laid from above onto the body and gown (ray cast),
    hanging off the body sides at a fixed slope down to the mattress. Recomputed for every body state."""
    xs = np.arange(x_top, x_bot - 1e-9, -SHEET_STEP)
    ys = np.arange(-SHEET_HALF_WIDTH, SHEET_HALF_WIDTH + 1e-9, SHEET_STEP)
    nx, ny = len(xs), len(ys)
    X, Y = np.meshgrid(xs, ys, indexing='ij')
    Tg = tri_indices(gown.data)
    nb = len(Pb)
    allT = np.concatenate([T, Tg + nb])

    def drape(Pbody, Pgown, want_cols=False):
        V = np.concatenate([Pbody, Pgown])
        bvh = BVHTree.FromPolygons([Vector(p) for p in V], allT.tolist())
        Hf = np.zeros((nx, ny))
        cols = np.tile([0.0, 0.0, REGIONS['groin'] / 10.0], (nx * ny, 1))
        for i in range(nx):
            for j in range(ny):
                hit = bvh.ray_cast(Vector((X[i, j], Y[i, j], 3.0)), Vector((0, 0, -1)))
                for dx, dy in ((0.012, 0), (-0.012, 0), (0, 0.012), (0, -0.012)):   # conservative: no poke-through
                    h2 = bvh.ray_cast(Vector((X[i, j] + dx, Y[i, j] + dy, 3.0)), Vector((0, 0, -1)))
                    if h2[0] is not None:
                        Hf[i, j] = max(Hf[i, j], h2[0].z + SHEET_GAP)
                if hit[0] is not None:
                    Hf[i, j] = max(Hf[i, j], hit[0].z + SHEET_GAP)
                    if want_cols:
                        t = allT[hit[2]]
                        on_body = hit[2] < len(T)
                        src = colors if on_body else gown_cols
                        tt = t if on_body else t - nb
                        w = barycentric(np.array([hit[0][:]]), V[t[0]][None], V[t[1]][None], V[t[2]][None])[0]
                        c = src[tt[0]] * w[0] + src[tt[1]] * w[1] + src[tt[2]] * w[2]
                        c[2] = src[tt[np.argmax(w)], 2]
                        cols[i * ny + j] = c
        Z = Hf.copy()
        d1, d2 = SHEET_SLOPE * SHEET_STEP, SHEET_SLOPE * SHEET_STEP * math.sqrt(2)
        for _ in range(nx + ny):              # hanging cloth: z >= neighbour - slope * distance
            Zp = np.pad(Z, 1, constant_values=0)
            cand = [Zp[:-2, 1:-1] - d1, Zp[2:, 1:-1] - d1, Zp[1:-1, :-2] - d1, Zp[1:-1, 2:] - d1,
                    Zp[:-2, :-2] - d2, Zp[:-2, 2:] - d2, Zp[2:, :-2] - d2, Zp[2:, 2:] - d2]
            Z = np.maximum(Z, np.max(cand, axis=0))
        for _ in range(2):                    # soften folds, never below the contact surface
            Zp = np.pad(Z, 1, mode='edge')
            Z = np.maximum(Hf, 0.5 * Z + 0.125 * (Zp[:-2, 1:-1] + Zp[2:, 1:-1] + Zp[1:-1, :-2] + Zp[1:-1, 2:]))
        Z = np.maximum(Z, 0.004)
        P = np.stack([X.ravel(), Y.ravel(), Z.ravel()], 1)
        return (P, cols) if want_cols else P
    Pbase, cols = drape(S['Basis'], G['Basis'], True)
    states = {'Basis': Pbase}
    for s in S:
        if s != 'Basis':
            states[s] = drape(S[s], G[s])
    faces = [(i * ny + j, (i + 1) * ny + j, (i + 1) * ny + j + 1, i * ny + j + 1) for i in range(nx - 1) for j in range(ny - 1)]
    me = bpy.data.meshes.new('patient_sheet')
    me.from_pydata(Pbase.tolist(), [], faces)
    uv = me.uv_layers.new(name='UVMap')
    for poly in me.polygons:
        for li in poly.loop_indices:
            vi = me.loops[li].vertex_index
            uv.data[li].uv = ((vi // ny) / (nx - 1), (vi % ny) / (ny - 1))
    ob = bpy.data.objects.new('patient_sheet', me)
    final_coll().objects.link(ob)
    add_keys(ob, Pbase, keys_from_states(states))
    paint_color(ob, cols)
    for p in me.polygons:
        p.use_smooth = True
    log('sheet grid', nx, 'x', ny)
    return ob


def barycentric(p, a, b, c):
    v0, v1, v2 = b - a, c - a, p - a
    d00, d01, d11 = (v0 * v0).sum(1), (v0 * v1).sum(1), (v1 * v1).sum(1)
    d20, d21 = (v2 * v0).sum(1), (v2 * v1).sum(1)
    den = np.maximum(d00 * d11 - d01 * d01, 1e-18)
    v = (d11 * d20 - d01 * d21) / den
    w = (d00 * d21 - d01 * d20) / den
    return np.stack([1 - v - w, v, w], 1)


def tri_frames(a, b, c):
    e1 = b - a
    e1 /= np.maximum(np.linalg.norm(e1, axis=1, keepdims=True), 1e-12)
    n = np.cross(b - a, c - a)
    n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
    e2 = np.cross(n, e1)
    return np.stack([e1, e2, n], 1)          # rows: e1, e2, n


# ----------------------------------------------------------------------------- skin bake
def bake_skin(body):
    """Bake MPFB's ENHANCED_SSS skin (mid-tone texture mix) to a 2048 albedo and a tangent-space normal map."""
    dark = os.path.join(UD, 'skins', 'young_african_male', 'young_darkskinned_male_diffuse.png')
    light = os.path.join(UD, 'skins', 'young_caucasian_male', 'young_lightskinned_male_diffuse.png')
    il, idk = bpy.data.images.load(light), bpy.data.images.load(dark)
    for im in (il, idk):
        if tuple(im.size) != (TEX_SIZE, TEX_SIZE):
            im.scale(TEX_SIZE, TEX_SIZE)
    a = np.empty(TEX_SIZE * TEX_SIZE * 4, np.float32)
    b = np.empty_like(a)
    il.pixels.foreach_get(a)
    idk.pixels.foreach_get(b)
    mid = bpy.data.images.new('skin_midtone_src', TEX_SIZE, TEX_SIZE)
    mid.pixels.foreach_set(a * (1 - SKIN_TONE_MIX) + b * SKIN_TONE_MIX)
    mid.pack()
    for m in body.data.materials:
        for nt in node_trees(m.node_tree):
            for n in nt.nodes:
                if n.bl_idname == 'ShaderNodeTexImage' and n.name == 'DiffuseTexture':
                    n.image = mid
    albedo = bpy.data.images.new('patient_albedo', TEX_SIZE, TEX_SIZE)
    normal = bpy.data.images.new('patient_normal', TEX_SIZE, TEX_SIZE)
    normal.colorspace_settings.name = 'Non-Color'
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = 4
    sc.render.bake.margin = 16
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    body.select_set(True)
    bpy.context.view_layer.objects.active = body
    nodes = []
    for m in body.data.materials:
        n = m.node_tree.nodes.new('ShaderNodeTexImage')
        nodes.append((m, n))
    for img, kw in ((albedo, dict(type='DIFFUSE', pass_filter={'COLOR'})), (normal, dict(type='NORMAL', normal_space='TANGENT'))):
        for m, n in nodes:
            n.image = img
            m.node_tree.nodes.active = n
        bpy.ops.object.bake(use_clear=True, margin=16, **kw)
        log('baked', img.name)
    for m, n in nodes:
        m.node_tree.nodes.remove(n)
    save_image(albedo, os.path.join(TMP, 'patient_albedo.jpg'), 'JPEG', 88)
    save_image(normal, os.path.join(TMP, 'patient_normal.jpg'), 'JPEG', 92)
    # female albedo: MPFB's female textures (softer brows and lips, finer skin) at the same tone mix and UVs
    fl = bpy.data.images.load(os.path.join(UD, 'skins', 'young_caucasian_female', 'young_lightskinned_female_diffuse.png'))
    fd = bpy.data.images.load(os.path.join(UD, 'skins', 'young_african_female', 'young_darkskinned_female_diffuse.png'))
    for im in (fl, fd):
        if tuple(im.size) != (TEX_SIZE, TEX_SIZE):
            im.scale(TEX_SIZE, TEX_SIZE)
    fl.pixels.foreach_get(a)
    fd.pixels.foreach_get(b)
    fmid = bpy.data.images.new('skin_midtone_female_src', TEX_SIZE, TEX_SIZE)
    fmid.pixels.foreach_set(a * (1 - SKIN_TONE_MIX) + b * SKIN_TONE_MIX)
    fmid.pack()
    for m in body.data.materials:
        for nt in node_trees(m.node_tree):
            for n in nt.nodes:
                if n.bl_idname == 'ShaderNodeTexImage' and n.name == 'DiffuseTexture':
                    n.image = fmid
    falb = bpy.data.images.new('patient_albedo_female', TEX_SIZE, TEX_SIZE)
    nodes = []
    for m in body.data.materials:
        n = m.node_tree.nodes.new('ShaderNodeTexImage')
        n.image = falb
        m.node_tree.nodes.active = n
        nodes.append((m, n))
    bpy.ops.object.bake(use_clear=True, margin=16, type='DIFFUSE', pass_filter={'COLOR'})
    for m, n in nodes:
        m.node_tree.nodes.remove(n)
    save_image(falb, os.path.join(TMP, 'patient_albedo_female.jpg'), 'JPEG', 88)
    save_image(falb, OUT_ALBEDO_F, 'JPEG', 88)
    log('baked female albedo', OUT_ALBEDO_F)


def node_trees(nt, seen=None):
    seen = seen or set()
    if nt is None or nt in seen:
        return []
    seen.add(nt)
    out = [nt]
    for n in nt.nodes:
        if n.bl_idname == 'ShaderNodeGroup':
            out += node_trees(n.node_tree, seen)
    return out


def save_image(img, path, fmt, quality=90):
    """Write the raw buffer (no view transform), so Non-Color data stays linear."""
    img.filepath_raw = path
    img.file_format = fmt
    try:
        img.save(filepath=path, quality=quality)
    except TypeError:
        img.save()
    return path


def load_resized(src, dst, fmt, size, quality=90):
    im = bpy.data.images.load(src)
    if tuple(im.size) != tuple(size):
        im.scale(*size)
    save_image(im, dst, fmt, quality)
    bpy.data.images.remove(im)
    return dst


# ----------------------------------------------------------------------------- export materials
def principled(name, color=None, tex=None, normal=None, rough=0.5, alpha=None, cutoff=None, double=False, nonmetal=True):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes['Principled BSDF']
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = 0.0
    if color:
        bsdf.inputs['Base Color'].default_value = (*color, 1)
    if tex:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = bpy.data.images.load(tex)
        nt.links.new(t.outputs['Color'], bsdf.inputs['Base Color'])
        if alpha:
            if cutoff is not None:
                g = nt.nodes.new('ShaderNodeMath')
                g.operation = 'GREATER_THAN'
                g.inputs[1].default_value = cutoff
                nt.links.new(t.outputs['Alpha'], g.inputs[0])
                nt.links.new(g.outputs[0], bsdf.inputs['Alpha'])
            else:
                nt.links.new(t.outputs['Alpha'], bsdf.inputs['Alpha'])
    if normal:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = bpy.data.images.load(normal)
        t.image.colorspace_settings.name = 'Non-Color'
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nt.links.new(t.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    m.use_backface_culling = not double
    if alpha:
        if hasattr(m, 'surface_render_method'):
            m.surface_render_method = 'BLENDED' if cutoff is None else 'DITHERED'
        if hasattr(m, 'blend_method'):
            m.blend_method = 'BLEND' if cutoff is None else 'CLIP'
    return m


def make_materials(finals, gown, sheet):
    eye_png = os.path.join(UD, 'eyes', 'materials', 'brown_eye.png')
    brow_png = os.path.join(UD, 'eyebrows', 'eyebrow001', 'eyebrow001.png')
    hair_png = os.path.join(UD, 'hair', 'short02', 'short02_diffuse.png')
    eye_t = load_resized(eye_png, os.path.join(TMP, 'eye_brown.jpg'), 'JPEG', (256, 256), 90)
    brow_t = load_resized(brow_png, os.path.join(TMP, 'eyebrow.png'), 'PNG', (256, 256))
    hair_t = load_resized(hair_png, os.path.join(TMP, 'hair_short.png'), 'PNG', (512, 512))
    hairf_t = load_resized(os.path.join(UD, 'hair', 'braid01', 'braid01_diffuse.png'), os.path.join(TMP, 'hair_braid.png'), 'PNG', (512, 512))
    browf_t = load_resized(os.path.join(UD, 'eyebrows', 'eyebrow006', 'eyebrow006.png'), os.path.join(TMP, 'eyebrow_f.png'), 'PNG', (256, 256))
    lash_t = load_resized(os.path.join(UD, 'eyelashes', 'eyelashes01', 'eyelashes01.png'), os.path.join(TMP, 'eyelashes.png'), 'PNG', (256, 256))
    mats = {
        'body': principled('skin', tex=os.path.join(TMP, 'patient_albedo.jpg'), normal=os.path.join(TMP, 'patient_normal.jpg'), rough=0.55),
        'eyes': principled('eyes', tex=eye_t, rough=0.08),
        'eyebrows': principled('eyebrows', tex=brow_t, rough=0.8, alpha=True, double=True),
        'hair': principled('hair', tex=hair_t, rough=0.6, alpha=True, cutoff=0.5, double=True),
        'hair_f': principled('hair_f', tex=hairf_t, rough=0.6, alpha=True, cutoff=0.5, double=True),
        'eyebrows_f': principled('eyebrows_f', tex=browf_t, rough=0.8, alpha=True, double=True),
        'eyelashes': principled('eyelashes', tex=lash_t, rough=0.8, alpha=True, double=True),
    }
    for k, m in mats.items():
        finals[k].data.materials.clear()
        finals[k].data.materials.append(m)
        for p in finals[k].data.polygons:
            p.material_index = 0
    for ob, col in ((gown, (0.16, 0.30, 0.38)), (sheet, (0.36, 0.37, 0.37))):
        ob.data.materials.clear()
        ob.data.materials.append(principled(ob.name.replace('patient_', 'cloth_'), color=col, rough=0.92, double=True))
        for p in ob.data.polygons:
            p.material_index = 0


# ----------------------------------------------------------------------------- export
def export_glb(meta):
    meshes = ['patient_body', 'patient_gown', 'patient_sheet'] + ['patient_' + k for k in HEAD_ASSETS]
    names = meshes + list(meta['landmarks'])
    for o in bpy.context.view_layer.objects:
        o.select_set(o.name in names)
    for n in meshes:
        o = bpy.data.objects[n]
        me = o.data
        tris = sum(len(p.vertices) - 2 for p in me.polygons)
        meta['meshes'][n] = {'vertices': len(me.vertices), 'triangles': tris}
    meta['triangles'] = sum(v['triangles'] for v in meta['meshes'].values())
    bpy.context.scene['tidal_patient'] = json.dumps(meta)
    props = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
    kw = dict(filepath=OUT_GLB, export_format='GLB', use_selection=True, export_yup=True, export_apply=False,
              export_texcoords=True, export_normals=True, export_tangents=False, export_materials='EXPORT',
              export_image_format='AUTO', export_morph=True, export_morph_normal=True, export_morph_tangent=False,
              export_skins=False, export_animations=False, export_extras=True, export_cameras=False, export_lights=False)
    if 'export_vertex_color' in props:
        kw['export_vertex_color'] = 'ACTIVE'
    if 'export_all_vertex_colors' in props:
        kw['export_all_vertex_colors'] = False
    if 'export_active_vertex_color_when_no_material' in props:
        kw['export_active_vertex_color_when_no_material'] = True
    if 'export_colors' in props:
        kw['export_colors'] = True
    kw = {k: v for k, v in kw.items() if k in props or k == 'filepath'}
    bpy.ops.export_scene.gltf(**kw)
    strip_face_normals()
    patch_glb_anchors(meta)
    with open(OUT_JSON, 'w', encoding='utf-8') as f:
        json.dump(meta, f, indent=1)
    log('exported', OUT_GLB, '%.2f MB' % (os.path.getsize(OUT_GLB) / 1e6), 'triangles', meta['triangles'])


def strip_face_normals():
    """The exporter writes dense NORMAL deltas for every morph target. The app moves the face on the GPU from position deltas only,
    so the face keys' normal deltas are dropped and the BIN chunk is compacted (keeps patient.glb within its download budget)."""
    import struct
    with open(OUT_GLB, 'rb') as f:
        data = f.read()
    jl = struct.unpack('<I', data[12:16])[0]
    J = json.loads(data[20:20 + jl])
    BIN = data[20 + jl + 8:]
    for m in J['meshes']:
        names = m.get('extras', {}).get('targetNames', [])
        for p in m['primitives']:
            for n, t in zip(names, p.get('targets', [])):
                if n in FACE_KEYS:
                    t.pop('NORMAL', None)
    used = set()
    def acc_views(a):
        if 'bufferView' in a:
            used.add(a['bufferView'])
        if 'sparse' in a:
            used.add(a['sparse']['indices']['bufferView']); used.add(a['sparse']['values']['bufferView'])
    live = set()
    for m in J['meshes']:
        for p in m['primitives']:
            live.update(p['attributes'].values())
            if 'indices' in p:
                live.add(p['indices'])
            for t in p.get('targets', []):
                live.update(t.values())
    for i in live:
        acc_views(J['accessors'][i])
    for im in J.get('images', []):
        used.add(im['bufferView'])
    # drop dead accessors, then dead buffer views, and repack the BIN chunk
    amap = {o: k for k, o in enumerate(sorted(live))}
    J['accessors'] = [J['accessors'][o] for o in sorted(live)]
    for m in J['meshes']:
        for p in m['primitives']:
            p['attributes'] = {k: amap[v] for k, v in p['attributes'].items()}
            if 'indices' in p:
                p['indices'] = amap[p['indices']]
            p['targets'] = [{k: amap[v] for k, v in t.items()} for t in p.get('targets', [])]
    vmap, out = {}, bytearray()
    for o in sorted(used):
        v = J['bufferViews'][o]
        while len(out) % 4:
            out.append(0)
        start = v.get('byteOffset', 0)
        vmap[o] = len(vmap)
        nv = dict(v); nv['byteOffset'] = len(out)
        out += BIN[start:start + v['byteLength']]
        J['bufferViews'][o] = nv
    J['bufferViews'] = [J['bufferViews'][o] for o in sorted(used)]
    for a in J['accessors']:
        if 'bufferView' in a:
            a['bufferView'] = vmap[a['bufferView']]
        if 'sparse' in a:
            a['sparse']['indices']['bufferView'] = vmap[a['sparse']['indices']['bufferView']]
            a['sparse']['values']['bufferView'] = vmap[a['sparse']['values']['bufferView']]
    for im in J.get('images', []):
        im['bufferView'] = vmap[im['bufferView']]
    while len(out) % 4:
        out.append(0)
    J['buffers'][0]['byteLength'] = len(out)
    js = json.dumps(J, separators=(',', ':')).encode('utf-8')
    js += b' ' * ((4 - len(js) % 4) % 4)
    binchunk = struct.pack('<I4s', len(out), b'BIN\x00') + bytes(out)
    with open(OUT_GLB, 'wb') as f:
        f.write(struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(js) + len(binchunk)) + struct.pack('<I4s', len(js), b'JSON') + js + binchunk)


def patch_glb_anchors(meta):
    """glTF splits vertices at UV seams, so Blender indices are not glTF indices. Rewrite each landmark node's
    extras.anchorVertex with the glTF index of patient_body's POSITION that matches it (blenderVertex keeps the old one)."""
    import struct
    with open(OUT_GLB, 'rb') as f:
        data = f.read()
    jl = struct.unpack('<I', data[12:16])[0]
    J = json.loads(data[20:20 + jl])
    binchunk = data[20 + jl:]
    BIN = binchunk[8:]
    mesh = next(m for m in J['meshes'] if m['name'] == 'patient_body')
    acc = J['accessors'][mesh['primitives'][0]['attributes']['POSITION']]
    bv = J['bufferViews'][acc['bufferView']]
    off = bv.get('byteOffset', 0) + acc.get('byteOffset', 0)
    pos = np.frombuffer(BIN, dtype='<f4', count=acc['count'] * 3, offset=off).reshape(-1, 3)
    for n in J['nodes']:
        if n['name'] in meta['landmarks']:
            t = np.array(n.get('translation', [0, 0, 0]))
            i = int(np.argmin(np.linalg.norm(pos - t, axis=1)))
            lmk = meta['landmarks'][n['name']]
            lmk['blenderVertex'] = lmk['anchorVertex']
            lmk['anchorVertex'] = i
            n['extras'] = {'anchorVertex': i, 'blenderVertex': lmk['blenderVertex'], 'region': lmk['region']}
    sc = J['scenes'][0].setdefault('extras', {})
    sc['tidal_patient'] = json.dumps(meta)
    js = json.dumps(J, separators=(',', ':')).encode('utf-8')
    js += b' ' * ((4 - len(js) % 4) % 4)
    out = struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(js) + len(binchunk)) + struct.pack('<I4s', len(js), b'JSON') + js + binchunk
    with open(OUT_GLB, 'wb') as f:
        f.write(out)


# ----------------------------------------------------------------------------- renders
def weights_for(calib, sex, bmi):
    """Inverse of the calibration table at the reference height (no height correction)."""
    grid = np.linspace(0, 1, 11)
    t = calib['%s_25y' % sex]
    hv, tv = np.array(t['heavy']), np.array(t['thin'])
    if bmi >= hv[0]:
        return {'heavy': float(np.interp(bmi, hv, grid)), 'thin': 0.0}
    return {'heavy': 0.0, 'thin': float(np.interp(-bmi, -tv, grid))}


def renders(finals, gown, sheet, calib, lm):
    os.makedirs(RENDER_DIR, exist_ok=True)
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = 48
    sc.cycles.use_denoising = True
    sc.render.resolution_x, sc.render.resolution_y = 1280, 720
    sc.render.film_transparent = False
    sc.view_settings.view_transform = 'Standard'
    sc.view_settings.look = 'None'
    sc.view_settings.exposure = 0.0
    sc.render.image_settings.file_format = 'PNG'
    sc.render.image_settings.color_mode = 'RGB'
    if not sc.world:
        sc.world = bpy.data.worlds.new('World')
    sc.world.use_nodes = True
    sc.world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.32, 0.34, 0.36, 1)
    sc.world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.6
    rc = bpy.data.collections.new('RENDER_SET')
    sc.collection.children.link(rc)
    H0 = json.loads(sc['tidal_patient'])['referenceHeight']
    bpy.ops.mesh.primitive_cube_add(size=1)
    bed = bpy.context.active_object
    bed.scale = (H0 + 0.35, 0.95, 0.14)
    bed.location = (-H0 / 2 + 0.05, 0, -0.07)
    bed.data.materials.append(principled('mattress', color=(0.16, 0.2, 0.26), rough=0.7))
    for o in list(bed.users_collection):
        o.objects.unlink(bed)
    rc.objects.link(bed)
    # arm board under the abducted right arm (patient's right = Blender +Y)
    P = np.array([v.co[:] for v in finals['body'].data.vertices])
    arm = P[P[:, 1] > 0.30][:, :2]
    c = arm.mean(0)
    u = np.linalg.svd(arm - c)[2][0]
    t = (arm - c) @ u
    bpy.ops.mesh.primitive_cube_add(size=1)
    board = bpy.context.active_object
    board.scale = (float(t.max() - t.min()) + 0.12, 0.17, 0.03)
    board.location = (float(c[0]), float(c[1]), -0.016)
    board.rotation_euler = (0, 0, math.atan2(u[1], u[0]))
    board.data.materials.append(principled('armboard', color=(0.16, 0.2, 0.26), rough=0.7))
    for o in list(board.users_collection):
        o.objects.unlink(board)
    rc.objects.link(board)
    for nm, loc, rot, en, size in (('key', (0.6, -2.2, 2.6), (0.9, 0, -0.3), 210, 2.5), ('fill', (-2.0, 2.0, 2.2), (0.8, 0, 3.6), 110, 3.0),
                                   ('top', (-0.85, 0, 3.0), (0, 0, 0), 110, 2.0)):
        ld = bpy.data.lights.new(nm, 'AREA')
        ld.energy, ld.size = en, size
        lo = bpy.data.objects.new(nm, ld)
        lo.location, lo.rotation_euler = loc, rot
        rc.objects.link(lo)
    cd = bpy.data.cameras.new('cam')
    cd.lens = 50
    cam = bpy.data.objects.new('cam', cd)
    rc.objects.link(cam)
    sc.camera = cam
    target = Vector((-H0 * 0.52, 0, 0.12))
    cam.location = Vector((-0.40, -3.15, 2.45))
    cam.rotation_euler = (target - cam.location).to_track_quat('-Z', 'Y').to_euler()
    objs = [finals[k] for k in ['body'] + HEAD_ASSETS] + [gown, sheet]
    paths = []
    for sex, fem in (('male', 0.0), ('female', 1.0)):
        for bmi in (17, 25, 45):
            w = weights_for(calib, sex, bmi)
            vals = {'female': fem, 'heavy': w['heavy'], 'thin': w['thin'], 'old': 0.0,
                    'female_heavy': fem * w['heavy'], 'female_thin': fem * w['thin'], 'female_old': 0.0}
            for o in objs:
                for k, v in vals.items():
                    o.data.shape_keys.key_blocks[k].value = v
            for k in MALE_ONLY:
                finals[k].hide_render = fem > 0.5
            for k in FEMALE_ONLY:
                finals[k].hide_render = fem <= 0.5
            p = os.path.join(RENDER_DIR, 'patient_%s_bmi%d.png' % (sex, bmi))
            sc.render.filepath = p
            bpy.ops.render.render(write_still=True)
            paths.append(p)
            log('render', p, {k: round(v, 3) for k, v in vals.items() if v})
    # face close-ups, male and female at BMI 25, to check that the two faces read differently
    head = Vector((-0.10, 0, 0.17))
    cam.location = head + Vector((-0.28, -0.42, 0.30))
    cam.rotation_euler = (head - cam.location).to_track_quat('-Z', 'Y').to_euler()
    faces = []
    for sex, fem in (('male', 0.0), ('female', 1.0)):
        w = weights_for(calib, sex, 25)
        vals = {'female': fem, 'heavy': w['heavy'], 'thin': w['thin'], 'old': 0.0, 'female_heavy': fem * w['heavy'], 'female_thin': fem * w['thin'], 'female_old': 0.0}
        for o in objs:
            for k, v in vals.items():
                o.data.shape_keys.key_blocks[k].value = v
        for k in MALE_ONLY:
            finals[k].hide_render = fem > 0.5
        for k in FEMALE_ONLY:
            finals[k].hide_render = fem <= 0.5
        p = os.path.join(RENDER_DIR, 'patient_face_%s.png' % sex)
        sc.render.filepath = p
        bpy.ops.render.render(write_still=True)
        faces.append(p)
        log('render', p)
    for k in FEMALE_ONLY:
        finals[k].hide_render = True
    for k in MALE_ONLY:
        finals[k].hide_render = False
    # landmark check render: basis body, gown hidden, small spheres at each landmark, top view
    for o in objs:
        for kb in o.data.shape_keys.key_blocks[1:]:
            kb.value = 0
    gown.hide_render = True
    mk = principled('marker', color=(1.0, 0.85, 0.0), rough=0.3)
    for name in lm:
        e = bpy.data.objects[name]
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.012, location=e.location)
        s = bpy.context.active_object
        s.data.materials.append(mk)
        for c in list(s.users_collection):
            c.objects.unlink(s)
        rc.objects.link(s)
    cam.location = Vector((-H0 * 0.42, -0.9, 2.4))
    target = Vector((-H0 * 0.3, 0, 0.1))
    cam.rotation_euler = (target - cam.location).to_track_quat('-Z', 'Y').to_euler()
    p = os.path.join(RENDER_DIR, 'patient_landmarks.png')
    sc.render.filepath = p
    bpy.ops.render.render(write_still=True)
    gown.hide_render = False
    log('render', p)
    contact_sheet(paths, os.path.join(RENDER_DIR, 'patient_grid.png'))


def contact_sheet(paths, out):
    ims = [bpy.data.images.load(p) for p in paths]
    w, h = ims[0].size
    sw, sh = w // 2, h // 2
    sheet = np.zeros((sh * 2, sw * 3, 4), np.float32)
    for i, im in enumerate(ims):
        im.scale(sw, sh)
        px = np.empty(sw * sh * 4, np.float32)
        im.pixels.foreach_get(px)
        r, c = i // 3, i % 3
        sheet[(1 - r) * sh:(2 - r) * sh, c * sw:(c + 1) * sw] = px.reshape(sh, sw, 4)
    img = bpy.data.images.new('grid', sw * 3, sh * 2)
    img.pixels.foreach_set(sheet.ravel())
    img.filepath_raw = out
    img.file_format = 'PNG'
    img.save()
    log('render', out)


if __name__ == '__main__':
    main()
