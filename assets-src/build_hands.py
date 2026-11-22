"""Tidal Bedside Lab - gloved right hands holding each instrument -> src/web/assets/hands.glb.

The hand is the MakeHuman/MPFB right hand (CC0), posed with the MakeHuman default rig: fingers are curled or driven
by a small CCD IK onto contact points on the instrument, then the posed hand is frozen, gloved (smoothed, blue
nitrile), given a rolled glove cuff and a hint of the gown sleeve, and written IN THE INSTRUMENT'S FRAME.
So the app draws each hand with exactly the instrument's matrix (instruments.glb: origin = working point,
long axis +Y glTF / +Z Blender toward the handle).

Run from the repository root (Blender 4.2 + MPFB 2.0.18 + MakeHuman system assets, like build_patient.py):
    blender -b --python assets-src/build_hands.py
    blender -b --python assets-src/build_hands.py -- --no-renders
Writes src/web/assets/hands.glb and assets-src/renders/hands.png. Deterministic (no random numbers).
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

T0 = time.time()
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT_GLB = os.path.join(REPO, 'src', 'web', 'assets', 'hands.glb')
INSTR_GLB = os.path.join(REPO, 'src', 'web', 'assets', 'instruments.glb')
RENDER = os.path.join(HERE, 'renders', 'hands.png')


def log(*a):
    print('[hands %6.1fs]' % (time.time() - T0), *a, flush=True)


def _mpfb_base():
    for k in list(sys.modules):
        if k.endswith('.mpfb') and k.startswith('bl_ext.'):
            return k
    return 'bl_ext.user_default.mpfb'


MPFB = _mpfb_base()
HS = importlib.import_module(MPFB + '.services.humanservice').HumanService

# adult, sex-neutral hand (glove size about 7.5-8)
MACRO = dict(gender=0.5, age=0.5, muscle=0.5, weight=0.5, proportions=0.5, height=0.5, cupsize=0.5, firmness=0.5,
             race=dict(asian=1 / 3, caucasian=1 / 3, african=1 / 3))
CUT = 0.068           # m: the glove ends this far up the forearm from the wrist joint
SLEEVE = (0.064, 0.400)   # m: gown sleeve from / to (up the forearm), starts under the glove cuff; reaches the elbow so its end never shows in a close-up
GLOVE_RGB = (0.072, 0.180, 0.640)      # #4c75d1 in linear RGB: medical nitrile blue, a little less saturated
SLEEVE_RGB = (0.36, 0.55, 0.68)        # pale blue gown cuff
TRI_BUDGET = 12000                     # triangles per hand (glove + cuff + sleeve): enough for knuckles, glove creases and finger pads
CREASE = 0.0007                        # m: depth of the nitrile fold on the inside of a bent finger joint
WRIST_RUCK = 0.00045                   # m: glove rucked up between the wrist and the rolled cuff

FINGERS = {'thumb': 'finger1', 'index': 'finger2', 'middle': 'finger3', 'ring': 'finger4', 'pinky': 'finger5'}


def chain(f):
    return ['%s-%d.R' % (FINGERS[f], k) for k in (1, 2, 3)]


# ----------------------------------------------------------------------------- grips
# Hand frame: origin = centre of the palm skin, u = along the fingers, w = toward the thumb, n = out of the palm.
# Each grip: `pre` finger poses applied first, then the instrument is anchored to the posed hand (`mode`), then
# `post` fingers are driven by IK onto points of the instrument (instrument frame, Blender: +Z toward the handle).
#   curl: ('curl', [mcp, pip, dip] flexion degrees, abduction degrees toward the thumb side)
#   modes: frame  - instrument point p at hand point q, instrument +Z along hand dir z, +X along x
#          pencil - tripod: p sits between thumb and index pads, shaft runs back over the first web space
#          knife  - instrument point p under the index fingertip pad, shaft along the index finger into the palm
#          rings  - ring at p threaded on the ring finger's distal phalanx, ring axis along that phalanx
CURLED = ('curl', [62, 85, 55], 0)
FLAT = ('curl', [3, 5, 3], 0)
PENCIL_PRE = {'index': ('curl', [28, 38, 22], 0), 'middle': ('curl', [42, 55, 30], -3), 'ring': CURLED, 'pinky': CURLED}
GRIPS = {
    'hand_press': dict(instrument=None, wrist=(32, 0), mode='frame', flat=True, p=(0, 0, 0), q=(0, 0, 0), z=(0, 0, -1), x=(1, 0, 0),
                       pre={'index': ('curl', [3, 5, 3], 5), 'middle': FLAT,
                            'ring': ('curl', [3, 5, 3], -5), 'pinky': ('curl', [3, 5, 3], -10)}, post={'thumb': (0.025, 0.075, 0.009)},
                       label='flat palm, origin = palm centre on the skin, +Y = back of the hand (fingers along +X)'),
    'hand_defibPadRight': dict(instrument='defibPadRight', wrist=(32, 0), mode='frame', flat=True, p=(0, 0, 0.0045), q=(0, 0, 0), z=(0, 0, -1), x=(-1, 0, 0),
                               pre={'index': ('curl', [2, 4, 3], 10), 'middle': ('curl', [2, 4, 3], 2),
                                    'ring': ('curl', [2, 4, 3], -8), 'pinky': ('curl', [2, 4, 3], -18)}, post={'thumb': (-0.025, -0.08, 0.0135)},
                               label='flat palm pressing the back of the pad, fingers spread'),
    'hand_chestDrain': dict(instrument='chestDrain', wrist=(10, 0), mode='frame', p=(0, 0, 0.15), q=(0.035, 0.0, 0.0065), z=(0, -1, 0), x=(0, 0, 1),
                            pre={'index': ('curl', [70, 100, 55], 0), 'middle': ('curl', [72, 102, 55], 0), 'ring': ('curl', [74, 102, 55], 0),
                                 'pinky': ('curl', [76, 100, 55], 0)},
                            post={'thumb': (0.004, -0.0095, 0.115)},
                            label='palmar grip around the tube 15 cm from the tip'),
    'hand_bougie': dict(instrument='bougie', wrist=(14, -6), mode='pencil', p=(0.0143, 0, 0.12), axis_r=0.0025, pre=PENCIL_PRE,
                        label='pencil grip 12 cm from the tip'),
    # wrist a little flexed: the needle goes in square to the chest with the forearm ~33 deg above the skin, not raised high
    'hand_needle14G': dict(instrument='needle14G', wrist=(-10, -6), mode='pencil', p=(0, 0, 0.112), axis_r=0.0038, pre=PENCIL_PRE,
                           label='pencil grip on the hub and flash chamber'),
    'hand_ivCannula': dict(instrument='ivCannula', wrist=(14, -6), mode='pencil', p=(0, 0, 0.07), axis_r=0.003, pre=PENCIL_PRE,
                           label='pencil grip (thumb and index) on the hub'),
    'hand_scalpel': dict(instrument='scalpel', wrist=(8, -6), mode='knife', p=(-0.0021, 0, 0.058), tilt=0.42,
                         pre={'index': ('curl', [14, 12, 6], 0), 'ring': ('curl', [55, 70, 40], 0), 'pinky': ('curl', [60, 75, 45], 0)},
                         post={'thumb': (0.002, -0.0092, 0.082), 'middle': (0.004, 0.0095, 0.088)},
                         label='table-knife grip, index on the back of the blade'),
    'hand_forcepsGauze': dict(instrument='forcepsGauze', wrist=(10, 0), mode='rings', p=(-0.024, 0, 0.238),
                              pre={'ring': ('curl', [32, 42, 22], 0), 'pinky': ('curl', [40, 52, 30], 0), 'middle': ('curl', [30, 40, 22], 0),
                                   'index': ('curl', [12, 12, 6], 0)},
                              post={'thumb': (0.024, 0.0, 0.238), 'index': (0.0035, 0.0065, 0.19)},
                              label='thumb and ring finger in the rings, index along the shank'),
    'hand_stethoscope': dict(instrument='stethoscope', wrist=(26, 0), mode='frame', flat=True, p=(0, 0, 0.0165), q=(0.042, 0, 0), z=(0, 0, -1), x=(1, 0, 0),
                             pre={'index': ('curl', [18, 30, 20], 6), 'middle': ('curl', [20, 32, 22], 0), 'ring': ('curl', [30, 45, 30], -6), 'pinky': ('curl', [40, 55, 35], -12)},
                             post={'thumb': (-0.010, -0.019, 0.010)},
                             label='palm over the chest piece, fingertips steadying the rim'),
    'hand_usProbe': dict(instrument='usProbe', wrist=(12, 0), mode='frame', p=(0, 0, 0.078), q=(0.033, 0.0, 0.0175), z=(0, 1, 0), x=(0, 0, 1),
                         pre={'index': ('curl', [52, 72, 42], 0), 'middle': ('curl', [56, 76, 44], 0), 'ring': ('curl', [58, 78, 46], 0), 'pinky': ('curl', [60, 80, 48], 0)},
                         post={'thumb': (0.0, 0.0135, 0.085)},
                         label='palmar grip around the body, lens below the little finger, thumb on the marked side'),
    'hand_syringe': dict(instrument='syringe', wrist=(10, 0), mode='frame', p=(0, 0, 0.0878), q=(0.072, 0.0095, 0.024), z=(-1, 0, -0.08), x=(0, 1, 0),
                         pre={'ring': CURLED, 'pinky': CURLED, 'index': ('curl', [30, 60, 40], 6), 'middle': ('curl', [30, 60, 40], -6)},
                         post={'index': (0.0125, 0.0, 0.0790), 'middle': (-0.0125, 0.0, 0.0790), 'thumb': (0.0, 0.0, 0.1445)},
                         label='thumb on the plunger, index and middle fingers hooked over the flange'),
    # the other hand: stretches the skin below a puncture or an incision (built as a right hand, then mirrored to a left hand)
    'hand_pressL': dict(instrument=None, wrist=(22, 0), mode='frame', flat=True, mirror=True, p=(0, 0, 0), q=(0, 0, 0), z=(0, 0, -1), x=(1, 0, 0),
                        pre={'index': ('curl', [4, 6, 4], 16), 'middle': ('curl', [8, 12, 8], 2),
                             'ring': ('curl', [11, 15, 10], -7), 'pinky': ('curl', [14, 18, 12], -16)}, post={'thumb': (0.02, 0.085, 0.001)},
                        label='left hand tensing the skin: thumb and index spread on the skin, other fingers resting'),
    # chest compressions: the heel of the lower (right) hand on the lower half of the sternum, wrist strongly extended so the
    # forearm stands over the chest, fingers lifted off the ribs; origin = heel of the hand on the skin
    'hand_cprBottom': dict(instrument=None, wrist=(62, 0), mode='frame', flat=True, p=(0, 0, 0), q=(-0.03, 0, 0), z=(0, 0, -1), x=(1, 0, 0),
                           pre={'index': ('curl', [-22, 6, 4], 4), 'middle': ('curl', [-22, 6, 4], 0),
                                'ring': ('curl', [-22, 6, 4], -4), 'pinky': ('curl', [-22, 6, 4], -8)}, post={'thumb': (0.03, 0.05, 0.014)},
                           label='CPR, lower hand: heel on the sternum, fingers raised off the ribs; origin = heel of the hand'),
    # the upper (left) hand on the back of the lower one, its fingers hooked down between the lower hand's fingers
    'hand_cprTop': dict(instrument=None, wrist=(56, 0), mode='frame', flat=True, mirror=True, p=(0, 0, 0), q=(-0.03, 0, 0), z=(0, 0, -1), x=(1, 0, 0),
                        pre={'index': ('curl', [38, 62, 40], 2), 'middle': ('curl', [40, 64, 42], 0),
                             'ring': ('curl', [42, 66, 44], -2), 'pinky': ('curl', [44, 66, 44], -4)}, post={'thumb': (0.02, 0.045, 0.004)},
                        label='CPR, upper hand: palm on the back of the lower hand, fingers interlaced; origin = heel of the hand'),
}


# ----------------------------------------------------------------------------- MPFB hand
def evaluated_world(ob):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    me = ev.to_mesh()
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    M = np.array(ev.matrix_world)
    ev.to_mesh_clear()
    return co @ M[:3, :3].T + M[:3, 3]


def upd():
    bpy.context.view_layer.update()


def Hd(rig, b):
    return rig.pose.bones[b].head.copy()


def Tl(rig, b):
    return rig.pose.bones[b].tail.copy()


def rot_world(rig, bone, axis, angle):
    if abs(angle) < 1e-8 or Vector(axis).length < 1e-9:
        return
    pb = rig.pose.bones[bone]
    M = pb.matrix.copy()
    h = M.translation.copy()
    pb.matrix = Matrix.Translation(h) @ Matrix.Rotation(angle, 4, Vector(axis).normalized()) @ Matrix.Translation(-h) @ M
    upd()


def reset_pose(rig):
    for pb in rig.pose.bones:
        pb.matrix_basis = Matrix.Identity(4)
    upd()


def hand_frame(rig, d_palm):
    wr, mid = Hd(rig, 'wrist.R'), Hd(rig, 'finger3-1.R')
    u = (mid - wr).normalized()
    w = Hd(rig, 'finger2-1.R') - Hd(rig, 'finger5-1.R')
    w = (w - u * w.dot(u)).normalized()
    n = w.cross(u).normalized()                 # palm normal of a right hand
    return (wr + mid) * 0.5 + n * d_palm, u, w, n


def setup():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    human = HS.create_human(mask_helpers=True, detailed_helpers=True, extra_vertex_groups=True, feet_on_ground=True,
                            scale=0.1, macro_detail_dict=MACRO)
    rig = HS.add_builtin_rig(human, 'default')
    for m in human.modifiers:
        if m.type == 'MASK':
            m.show_viewport = m.show_render = False
    upd()
    gi = human.vertex_groups['body'].index
    body = np.zeros(len(human.data.vertices), bool)
    for v in human.data.vertices:
        if any(g.group == gi and g.weight > 0.5 for g in v.groups):
            body[v.index] = True
    P = evaluated_world(human)
    wr, el = np.array(Hd(rig, 'wrist.R')), np.array(Hd(rig, 'lowerarm01.R'))
    f = (wr - el) / np.linalg.norm(wr - el)
    t = (P - wr) @ f
    perp = np.linalg.norm((P - wr) - np.outer(t, f), axis=1)
    arm_groups = {g.index for g in human.vertex_groups if g.name.endswith('.R') and g.name.startswith(('lowerarm', 'wrist', 'finger', 'metacarpal'))}
    arm = np.zeros(len(P), bool)
    for v in human.data.vertices:
        if any(g.group in arm_groups and g.weight > 0.05 for g in v.groups):
            arm[v.index] = True
    sel = body & arm & (t > -CUT - 0.022) & (perp < 0.16) & (P[:, 0] < 0)   # glove edge hidden inside the sleeve
    me = human.data.copy()
    bm = bmesh.new()
    bm.from_mesh(me)
    lay = bm.verts.layers.int.new('orig')
    for v in bm.verts:
        v[lay] = v.index
    bmesh.ops.delete(bm, geom=[fc for fc in bm.faces if not all(sel[v.index] for v in fc.verts)], context='FACES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    orig = np.array([v[lay] for v in bm.verts], np.int64)
    bm.verts.layers.int.remove(lay)
    tmpl = bpy.data.meshes.new('hand_template')
    bm.to_mesh(tmpl)
    bm.free()
    bpy.data.meshes.remove(me)
    # palm skin depth below the wrist->middle-finger bone line (rest pose)
    Pc, u, w, n = hand_frame(rig, 0.0)
    H = P[orig]
    rel = H - np.array(Pc)
    along = rel @ np.array(n)
    off = rel - np.outer(along, np.array(n))
    near = np.linalg.norm(off, axis=1) < 0.012
    d_palm = float(along[near].max())
    log('hand template', len(tmpl.vertices), 'verts', sum(len(p.vertices) - 2 for p in tmpl.polygons), 'tris',
        'palm depth %.4f' % d_palm)
    return human, rig, tmpl, orig, d_palm


# ----------------------------------------------------------------------------- posing
def flex_axes(rig, f, n):
    """Flexion axis of each joint, fixed in that bone's own frame (so it turns with the finger, and flexion can
    go past 90 degrees without flipping)."""
    ch = chain(f)
    k0 = (Tl(rig, ch[0]) - Hd(rig, ch[0])).cross(n).normalized()
    return {b: rig.pose.bones[b].matrix.to_3x3().inverted() @ k0 for b in ch}


def axis_now(rig, b, k_local):
    return (rig.pose.bones[b].matrix.to_3x3() @ k_local).normalized()


def curl_finger(rig, f, angles, abd, n):
    ch = chain(f)
    if abd:
        rot_world(rig, ch[0], n, math.radians(abd))
    ks = flex_axes(rig, f, n)
    for b, a in zip(ch, angles):
        rot_world(rig, b, axis_now(rig, b, ks[b]), math.radians(a))


def ik_finger(rig, f, target, n, iters=40, maxflex=110):
    """CCD: knuckle (MCP / thumb CMC) may flex and spread, the two distal joints only flex (0..110 deg)."""
    ch = chain(f)
    ks = flex_axes(rig, f, n)
    flex = {b: 0.0 for b in ch}
    target = Vector(target)
    for _ in range(iters):
        for j in reversed(range(3)):
            b = ch[j]
            tip, h = Tl(rig, ch[-1]), Hd(rig, b)
            a, c = tip - h, target - h
            if a.length < 1e-6 or c.length < 1e-6:
                continue
            if j == 0:
                rot_world(rig, b, a.cross(c), min(a.angle(c), math.radians(8)))
            else:
                k = axis_now(rig, b, ks[b])
                a2, c2 = a - k * a.dot(k), c - k * c.dot(k)
                if a2.length < 1e-6 or c2.length < 1e-6:
                    continue
                ang = math.atan2(k.dot(a2.cross(c2)), a2.dot(c2))
                new = max(0.0, min(math.radians(maxflex), flex[b] + ang))
                rot_world(rig, b, k, new - flex[b])
                flex[b] = new
        if (Tl(rig, ch[-1]) - target).length < 0.0008:
            break
    return (Tl(rig, ch[-1]) - target).length


def place_world(p_i, A, ex, ey, ez):
    R = Matrix((ex, ey, ez)).transposed()
    return Matrix.Translation(A - R @ Vector(p_i)) @ R.to_4x4()


def ortho(z, x):
    ez = Vector(z).normalized()
    ex = Vector(x)
    ex = (ex - ez * ex.dot(ez)).normalized()
    return ex, ez.cross(ex), ez


def pose_grip(rig, g, d_palm):
    reset_pose(rig)
    ext, dev = g['wrist']
    P0, u, w, n = hand_frame(rig, d_palm)
    rot_world(rig, 'wrist.R', u.cross(-n), math.radians(ext))        # dorsal extension
    rot_world(rig, 'wrist.R', n, math.radians(dev))                  # + radial / - ulnar deviation
    P0, u, w, n = hand_frame(rig, d_palm)
    Hm = Matrix((u, w, n)).transposed()
    for f, spec in g['pre'].items():
        curl_finger(rig, f, spec[1], spec[2], n)
    errs = {}
    mode = g['mode']
    if mode == 'frame':
        ex, ey, ez = ortho(Hm @ Vector(g['z']), Hm @ Vector(g['x']))
        M = place_world(g['p'], P0 + Hm @ Vector(g['q']), ex, ey, ez)
    elif mode == 'pencil':
        # thumb pad meets the index pad, the shaft passes between them and back over the first web space
        ik_finger(rig, 'thumb', Tl(rig, 'finger2-3.R') + n * 0.004 + w * (2 * g['axis_r'] + 0.006), n)
        pinch = (Tl(rig, 'finger1-3.R') + Tl(rig, 'finger2-3.R')) * 0.5
        web = (Hd(rig, 'finger1-2.R') + Hd(rig, 'finger2-1.R')) * 0.5 - n * 0.012
        ex, ey, ez = ortho(web - pinch, n)
        M = place_world(g['p'], pinch, ex, ey, ez)
        ax, pp, r = ez, pinch, g['axis_r'] + 0.0075
        side = lambda v: (v - ax * v.dot(ax)).normalized()
        tg = {'thumb': pp + side(w * 0.8 + n * 0.6) * r, 'index': pp + side(-n * 0.8 + w * 0.3) * r - ax * 0.003,
              'middle': pp + side(n * 0.7 - w * 0.7) * r - ax * 0.013}
        for f in ('index', 'middle', 'thumb'):
            errs[f] = round(ik_finger(rig, f, tg[f], n) * 1000, 1)
    elif mode == 'knife':
        a, b = Hd(rig, 'finger2-1.R'), Tl(rig, 'finger2-3.R')
        d = (b - a).normalized()
        A = b + n * 0.0085 - d * 0.007
        ex, ey, ez = ortho(-d + n * g['tilt'], n)
        M = place_world(g['p'], A, ex, ey, ez)
    elif mode == 'rings':
        h4, t4 = Hd(rig, 'finger4-3.R'), Tl(rig, 'finger4-3.R')
        ey = (t4 - h4).normalized()
        ex = (w - ey * w.dot(ey)).normalized()
        ez = ex.cross(ey)
        M = place_world(g['p'], (h4 + t4) * 0.5, ex, ey, ez)
    for f, tgt in g.get('post', {}).items():
        errs[f] = round(ik_finger(rig, f, M @ Vector(tgt), n, maxflex=12 if g.get("flat") else 110) * 1000, 1)
    return M, errs


# ----------------------------------------------------------------------------- glove geometry
def tri_idx(me):
    me.calc_loop_triangles()
    t = np.empty(len(me.loop_triangles) * 3, np.int64)
    me.loop_triangles.foreach_get('vertices', t)
    return t.reshape(-1, 3)


def vnormals(P, T):
    fn = np.cross(P[T[:, 1]] - P[T[:, 0]], P[T[:, 2]] - P[T[:, 0]])
    nn = np.zeros_like(P)
    for k in range(3):
        np.add.at(nn, T[:, k], fn)
    return nn / np.maximum(np.linalg.norm(nn, axis=1, keepdims=True), 1e-12)


def glove(P, T, edges):
    """Nitrile glove: smooth away nails and skin creases, then add the glove thickness."""
    deg = np.bincount(edges[:, 0], minlength=len(P)).astype(float)
    for _ in range(3):
        acc = np.zeros_like(P)
        for k in range(3):
            acc[:, k] = np.bincount(edges[:, 0], weights=P[edges[:, 1], k], minlength=len(P))
        P = P + 0.3 * (acc / np.maximum(deg, 1)[:, None] - P)
    return P + vnormals(P, T) * 0.0007


SEG = 28


def basis(axis):
    ax = Vector(axis).normalized()
    a = Vector((1, 0, 0)) if abs(ax.x) < 0.9 else Vector((0, 1, 0))
    e1 = ax.cross(a).normalized()
    return ax, e1, ax.cross(e1)


def ring_mesh(bm, center, axis, radii, r, rseg=8):
    """Rolled glove cuff: a tube of radius r following the forearm's own cross-section (radii per angle)."""
    ax, e1, e2 = basis(axis)
    vs = []
    for i in range(SEG):
        t = 2 * math.pi * i / SEG
        radial = e1 * math.cos(t) + e2 * math.sin(t)
        vs.append([bm.verts.new(Vector(center) + radial * (radii[i] + r * math.cos(2 * math.pi * j / rseg)) + ax * (r * math.sin(2 * math.pi * j / rseg)))
                   for j in range(rseg)])
    for i in range(SEG):
        for j in range(rseg):
            bm.faces.new((vs[i][j], vs[(i + 1) % SEG][j], vs[(i + 1) % SEG][(j + 1) % rseg], vs[i][(j + 1) % rseg])).smooth = True


def sleeve_mesh(bm, c0, axis, radii0, flare, length):
    """Gown sleeve up the forearm: a cloth tube that widens toward the elbow, with soft folds that drift along its length
    (deterministic, no random numbers), ending in a gathered hem closed by a rounded end (it is usually out of frame)."""
    ax, e1, e2 = basis(axis)
    NR = 26
    rings = []
    for k in range(NR + 1):
        u = (k / NR) ** 1.5                                                     # rings closer together near the cuff, where the cloth bunches
        s_ = length * u
        gather = 1.0 - 0.10 * max(0.0, (u - 0.94) / 0.06)                     # elastic hem pulls in at the end
        ring = []
        for i in range(SEG):
            th = 2 * math.pi * i / SEG
            fold = 0.0016 * math.sin(5 * th + 7.0 * u) * min(1.0, u * 4) + 0.0010 * math.sin(3 * th - 4.0 * u + 1.3)
            bunch = 0.0024 * max(0.0, 1.0 - s_ / 0.07) * (0.5 + 0.5 * math.sin(2 * math.pi * s_ / 0.017 + 0.6 * math.sin(2 * th)))   # cloth pushed up by the glove cuff
            r_ = (radii0[i] + flare * min(1.0, u * 1.15) + fold + bunch) * gather
            ring.append(bm.verts.new(Vector(c0) + ax * s_ + (e1 * math.cos(th) + e2 * math.sin(th)) * r_))
        rings.append(ring)
    for k in range(NR):
        for i in range(SEG):
            bm.faces.new((rings[k][i], rings[k][(i + 1) % SEG], rings[k + 1][(i + 1) % SEG], rings[k + 1][i])).smooth = True
    # rounded end: two shrinking rings then a pole, instead of a flat disc
    last = rings[-1]
    c = sum((v.co for v in last), Vector()) / SEG
    prev = last
    for k, (dz, kr) in enumerate(((0.006, 0.78), (0.010, 0.42))):
        ring = [bm.verts.new(c + (v.co - c) * kr + ax * dz) for v in last]
        for i in range(SEG):
            bm.faces.new((prev[i], prev[(i + 1) % SEG], ring[(i + 1) % SEG], ring[i])).smooth = True
        prev = ring
    cap = bm.verts.new(c + ax * 0.012)
    for i in range(SEG):
        bm.faces.new((prev[i], prev[(i + 1) % SEG], cap)).smooth = True


def glove_folds(P, T, rig, wr, f):
    """Nitrile does not stretch evenly: it folds into a crease on the inside of each bent finger joint and rucks up in
    soft ridges between the wrist and the rolled cuff. Deterministic (no random numbers)."""
    N = vnormals(P, T)
    n_palm = np.array(hand_frame(rig, 0.0)[3])
    D = np.zeros(len(P))
    for fg in FINGERS:
        bones = chain(fg)
        for a, b in zip(bones, bones[1:] + [None]):
            J = np.array(Hd(rig, a if b is None else b))           # the joint between bone a and the next one (the DIP for the last)
            if b is None:
                continue
            da = np.array(Tl(rig, a) - Hd(rig, a)); da /= np.linalg.norm(da)
            db = np.array(Tl(rig, b) - Hd(rig, b)); db /= np.linalg.norm(db)
            bend = db - da
            k = np.linalg.norm(bend)
            concave = bend / k if k > 0.12 else n_palm          # inside of the bend; a straight finger creases on its palmar side
            axial = (P - J) @ ((da + db) / np.linalg.norm(da + db))
            near = np.linalg.norm(P - J, axis=1) < 0.014
            inside = np.clip((N @ concave - 0.05) / 0.5, 0, 1)
            amp = CREASE * (0.45 + 0.55 * min(1.0, k / 0.9))       # deeper the more the joint is bent
            D -= near * inside * amp * np.exp(-(axial / 0.0026) ** 2)
    t = (P - wr) @ f                                              # wrist ruck: ridges round the forearm under the cuff
    band = np.clip((t + CUT - 0.004) / 0.008, 0, 1) * np.clip((-0.012 - t) / 0.008, 0, 1)
    D += band * WRIST_RUCK * np.sin(2 * math.pi * t / 0.0085)
    return P + N * D[:, None]


def mirror_left(ob):
    """Right hand -> left hand in the same frame: mirror Blender Y (glTF -Z, across the fingers), keep the palm normal
    (Blender +Z = glTF +Y) and the finger direction; faces flipped so the normals still point out."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.transform(bm, matrix=Matrix.Diagonal((1, -1, 1, 1)), verts=bm.verts)
    bmesh.ops.reverse_faces(bm, faces=bm.faces)
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()


def build_hand_object(name, human, rig, tmpl, orig, M, T, edges, mats):
    Pw = evaluated_world(human)[orig]
    Pg = glove(Pw, T, edges)
    wr0, el0 = np.array(Hd(rig, 'wrist.R')), np.array(Hd(rig, 'lowerarm01.R'))
    Pg = glove_folds(Pg, T, rig, wr0, (wr0 - el0) / np.linalg.norm(wr0 - el0))
    Minv = np.array(M.inverted())
    wr, el = np.array(Hd(rig, 'wrist.R')), np.array(Hd(rig, 'lowerarm01.R'))
    f = (wr - el) / np.linalg.norm(wr - el)
    ax, e1, e2 = basis(Vector(-f))
    rel = Pg - wr
    t = rel @ f
    ang = np.arctan2(rel @ np.array(e2), rel @ np.array(e1)) % (2 * math.pi)
    perp = np.linalg.norm(rel - np.outer(t, f), axis=1)

    def radii_at(tt, pad):
        """Forearm cross-section at distance tt along the arm: max radius per angular sector, smoothed."""
        m = np.abs(t - tt) < 0.006
        bins = np.full(SEG, np.nan)
        k = (ang[m] / (2 * math.pi) * SEG).astype(int) % SEG
        for b_, r_ in zip(k, perp[m]):
            bins[b_] = r_ if np.isnan(bins[b_]) else max(bins[b_], r_)
        good = ~np.isnan(bins)
        if not good.any():
            return np.full(SEG, 0.03 + pad)
        idx = np.arange(SEG)
        bins = np.interp(idx, np.concatenate([idx[good] - SEG, idx[good], idx[good] + SEG]), np.tile(bins[good], 3))
        for _ in range(2):
            bins = np.maximum(bins, (np.roll(bins, 1) + bins + np.roll(bins, -1)) / 3)
        return bins + pad
    me = tmpl.copy()
    me.name = name
    me.vertices.foreach_set('co', Pg.astype(np.float32).ravel())
    bm = bmesh.new()
    bm.from_mesh(me)
    for fc in bm.faces:
        fc.material_index = 0
        fc.smooth = True
    nglove = len(bm.faces)
    # rolled glove cuff (outermost), then the gown sleeve under it running up the forearm
    ring_mesh(bm, Vector(wr - f * CUT), Vector(-f), radii_at(-CUT + 0.003, 0.0012), 0.0022)
    sleeve_mesh(bm, Vector(wr - f * SLEEVE[0]), Vector(-f), radii_at(-SLEEVE[0] + 0.002, 0.0015), 0.024, SLEEVE[1] - SLEEVE[0])   # forearm widens ~2.4 cm toward the elbow
    bm.faces.ensure_lookup_table()
    cuff_faces = SEG * 8
    for i, fc in enumerate(bm.faces):
        if i >= nglove:
            fc.material_index = 0 if i < nglove + cuff_faces else 1
    bmesh.ops.transform(bm, matrix=Matrix(Minv.tolist()), verts=bm.verts)
    me.materials.clear()                     # slots first: to_mesh clamps material indices to the existing slots
    me.materials.append(mats['glove'])
    me.materials.append(mats['sleeve'])
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    tris = sum(len(p.vertices) - 2 for p in me.polygons)
    if tris > TRI_BUDGET:
        dec = ob.modifiers.new('dec', 'DECIMATE')
        dec.ratio = TRI_BUDGET / tris
        with bpy.context.temp_override(object=ob, active_object=ob, selected_objects=[ob]):
            bpy.ops.object.modifier_apply(modifier=dec.name)
    return ob


def material(name, rgb, rough):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*rgb, 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = 0.0
    return m


# ----------------------------------------------------------------------------- main
def main():
    bpy.context.preferences.filepaths.save_version = 0
    human, rig, tmpl, orig, d_palm = setup()
    T = tri_idx(tmpl)
    e = np.array([ed.vertices[:] for ed in tmpl.edges], np.int64)
    edges = np.concatenate([e, e[:, ::-1]])
    mats = {'glove': material('nitrile_glove', GLOVE_RGB, 0.55), 'sleeve': material('gown_sleeve', SLEEVE_RGB, 0.9)}   # nitrile is satin, not glossy
    hands, report = [], {}
    for name, g in GRIPS.items():
        M, errs = pose_grip(rig, g, d_palm)
        ob = build_hand_object(name, human, rig, tmpl, orig, M, T, edges, mats)
        if g.get('mirror'):
            mirror_left(ob)
        ob['instrument'] = g['instrument'] or ''
        ob['grip'] = g['label']
        ob['frame'] = 'instrument' if g['instrument'] else 'skin contact: origin = palm centre, +Y = back of the hand'
        hands.append(ob)
        tris = sum(len(p.vertices) - 2 for p in ob.data.polygons)
        report[name] = {'triangles': tris, 'ikErrorMm': errs}
        log(name, report[name])
    for o in list(bpy.data.objects):
        if o not in hands:
            bpy.data.objects.remove(o, do_unlink=True)
    for o in list(bpy.context.scene.objects):
        o.select_set(o in hands)
    props = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
    kw = dict(filepath=OUT_GLB, export_format='GLB', use_selection=True, export_yup=True, export_apply=False,
              export_normals=True, export_texcoords=False, export_tangents=False, export_materials='EXPORT',
              export_extras=True, export_animations=False, export_skins=False, export_morph=False, export_cameras=False,
              export_lights=False)
    if 'export_vertex_color' in props:
        kw['export_vertex_color'] = 'NONE'
    bpy.ops.export_scene.gltf(**{k: v for k, v in kw.items() if k in props or k == 'filepath'})
    log('exported', OUT_GLB, '%.3f MB' % (os.path.getsize(OUT_GLB) / 1e6), 'total triangles',
        sum(r['triangles'] for r in report.values()))
    print('[hands-report]', json.dumps(report), flush=True)
    if '--no-renders' not in ARGS:
        render(hands)


def render(hands):
    sc = bpy.context.scene
    bpy.ops.import_scene.gltf(filepath=INSTR_GLB)
    instr = {o.name: o for o in bpy.context.selected_objects if o.type == 'MESH'}
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = 32
    sc.cycles.use_denoising = True
    sc.render.resolution_x, sc.render.resolution_y = 640, 480
    sc.view_settings.view_transform = 'Standard'
    if not sc.world:
        sc.world = bpy.data.worlds.new('World')
    sc.world.use_nodes = True
    sc.world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.42, 0.45, 0.48, 1)
    sc.world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.6
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.data.energy = 3.0
    sun.rotation_euler = (0.5, 0.3, 0.8)
    sc.collection.objects.link(sun)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    cam.data.type = 'ORTHO'
    sc.collection.objects.link(cam)
    sc.camera = cam
    paths = []
    tmp = os.path.join(HERE, 'build-tmp')
    os.makedirs(tmp, exist_ok=True)
    for h in hands:
        for o in hands:
            o.hide_render = o is not h
        for nm, o in instr.items():
            o.hide_render = nm != h['instrument']
        pts = [h.matrix_world @ v.co for v in h.data.vertices]
        if h['instrument']:
            io = instr[h['instrument']]
            c0 = sum(pts, Vector()) / len(pts)
            pts += [io.matrix_world @ v.co for v in io.data.vertices if (io.matrix_world @ v.co - c0).length < 0.16]
        lo = Vector([min(p[i] for p in pts) for i in range(3)])
        hi = Vector([max(p[i] for p in pts) for i in range(3)])
        c = (lo + hi) / 2
        rad = (hi - lo).length / 2
        d = Vector((0.9, -1.25, 0.75)).normalized()
        cam.location = c + d * 2.0
        cam.rotation_euler = (-d).to_track_quat('-Z', 'Z').to_euler()
        cam.data.ortho_scale = rad * 2.25
        p = os.path.join(tmp, h.name + '.png')
        sc.render.filepath = p
        bpy.ops.render.render(write_still=True)
        paths.append(p)
    sheet(paths, RENDER)
    log('render', RENDER)


def sheet(paths, out, cols=3):
    ims = [bpy.data.images.load(p) for p in paths]
    w, h = ims[0].size
    rows = (len(ims) + cols - 1) // cols
    S = np.zeros((h * rows, w * cols, 4), np.float32)
    for i, im in enumerate(ims):
        px = np.empty(w * h * 4, np.float32)
        im.pixels.foreach_get(px)
        r, c = i // cols, i % cols
        S[(rows - 1 - r) * h:(rows - r) * h, c * w:(c + 1) * w] = px.reshape(h, w, 4)
    img = bpy.data.images.new('hands_sheet', w * cols, h * rows)
    img.pixels.foreach_set(S.ravel())
    img.filepath_raw = out
    img.file_format = 'PNG'
    os.makedirs(os.path.dirname(out), exist_ok=True)
    img.save()


if __name__ == '__main__':
    main()
