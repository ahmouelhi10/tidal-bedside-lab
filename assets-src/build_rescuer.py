"""Tidal Bedside Lab - the CPR rescuers -> src/web/assets/rescuer.glb (+ rescuer.json).

Two MakeHuman/MPFB people (CC0), a man and a woman, in a pale-blue coverall gown (the colour of the gown sleeves on the gloved
hands in hands.glb), shoes, a theatre cap and a surgical mask, posed leaning over a patient as for chest compressions: hips
flexed, back straight, head looking down at the hands. The arms are cut off at the shoulder: the app draws them from the
shoulder to the gloved hands on the chest, so they always reach the hands whatever the patient's size or the bed.

Frame: glTF +Y up, the person faces +Z, origin between the soles on the floor. rescuer.json gives, per person, the two shoulder
joints, the sole level, the height of the top of the head and the shoulder width (metres, same frame).

Run from the repository root (Blender 4.2 + MPFB 2.0.18 + MakeHuman system assets, like build_patient.py):
    blender -b --python assets-src/build_rescuer.py
    blender -b --python assets-src/build_rescuer.py -- --no-renders
Writes src/web/assets/rescuer.glb, src/web/assets/rescuer.json and assets-src/renders/rescuer.png. Deterministic.
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
OUT_GLB = os.path.join(REPO, 'src', 'web', 'assets', 'rescuer.glb')
OUT_JSON = os.path.join(REPO, 'src', 'web', 'assets', 'rescuer.json')
RENDER_DIR = os.path.join(HERE, 'renders')


def log(*a):
    print('[rescuer %6.1fs]' % (time.time() - T0), *a, flush=True)


def _mpfb_base():
    for k in list(sys.modules):
        if k.endswith('.mpfb') and k.startswith('bl_ext.'):
            return k
    return 'bl_ext.user_default.mpfb'


MPFB = _mpfb_base()
HS = importlib.import_module(MPFB + '.services.humanservice').HumanService
LS = importlib.import_module(MPFB + '.services.locationservice').LocationService
UD = LS.get_user_data('')

PEOPLE = {   # MakeHuman macro values (gender 1 = male; height 0.5 = average)
    'm': dict(gender=1.0, age=0.45, muscle=0.55, weight=0.5, proportions=0.5, height=0.55, cupsize=0.5, firmness=0.5,
              race=dict(asian=0.2, caucasian=0.5, african=0.3)),
    'f': dict(gender=0.0, age=0.42, muscle=0.5, weight=0.5, proportions=0.5, height=0.65, cupsize=0.45, firmness=0.5,
              race=dict(asian=0.4, caucasian=0.3, african=0.3)),
}
CLOTHES = [('gown', os.path.join(UD, 'clothes', 'male_worksuit01', 'male_worksuit01.mhclo')),
           ('shoes', os.path.join(UD, 'clothes', 'shoes02', 'shoes02.mhclo'))]
# Pose (degrees), standing frame +Z up, facing -Y: the trunk bends forward from the hips, the head looks down at the hands.
LEAN = (('spine05', 18.0), ('spine04', 12.0), ('spine03', 10.0), ('spine02', 8.0))
HEAD = (('neck01', -12.0), ('head', -8.0))
COLORS = {'gown': (0.36, 0.55, 0.68), 'shoes': (0.86, 0.87, 0.88), 'skin': (0.62, 0.44, 0.34), 'cap': (0.16, 0.36, 0.58),
          'mask': (0.55, 0.72, 0.86), 'eyes': (0.10, 0.07, 0.05)}
ARM_BONES = ('upperarm', 'lowerarm', 'wrist', 'finger', 'metacarpal')
TRI_BUDGET = 9000


def upd():
    bpy.context.view_layer.update()


def rot_world(rig, bone, axis, angle):
    if abs(angle) < 1e-7:
        return
    pb = rig.pose.bones[bone]
    h = pb.matrix.translation.copy()
    pb.matrix = Matrix.Translation(h) @ Matrix.Rotation(angle, 4, Vector(axis).normalized()) @ Matrix.Translation(-h) @ pb.matrix
    upd()


def align(rig, bone, cur, tgt):
    cur, tgt = Vector(cur).normalized(), Vector(tgt).normalized()
    ax = cur.cross(tgt)
    if ax.length > 1e-8:
        rot_world(rig, bone, ax, cur.angle(tgt))


def Hd(rig, b):
    return rig.matrix_world @ rig.pose.bones[b].head


def group_mask(ob, test):
    """Vertices of ob whose summed weight over the groups whose name passes test() exceeds 0.5."""
    gi = {g.index for g in ob.vertex_groups if test(g.name)}
    w = np.zeros(len(ob.data.vertices))
    for v in ob.data.vertices:
        w[v.index] = sum(g.weight for g in v.groups if g.group in gi)
    return w > 0.5


def material(name, rgb, rough):
    m = bpy.data.materials.new(name)
    m.use_fake_user = True                        # MPFB purges unused data while it builds a human
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*rgb, 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = 0.0
    return m


def frozen(ob, drop, name, mat, close=()):
    """The posed object as a plain mesh in world space, without the vertices in `drop`."""
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ev, depsgraph=dg)
    me.transform(ev.matrix_world)
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if drop[v.index]], context='VERTS')
    if close:                                         # close the openings left at the shoulders where the arms were cut
        near = lambda co: any((co - c).length < 0.17 for c in close)
        edges = [e for e in bm.edges if e.is_boundary and all(near(v.co) for v in e.verts)]
        if edges:
            bmesh.ops.holes_fill(bm, edges=edges, sides=0)
            bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4])
    bm.normal_update()
    bm.to_mesh(me)
    bm.free()
    me.materials.clear()
    me.materials.append(mat)
    me.name = name
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    return o


def shell(src, keep, name, mat, off):
    """A thin layer over part of a mesh (cap, mask): the faces whose vertices all pass keep(), pushed out along the normals."""
    me = src.data.copy()
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    bm.normal_update()
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if not all(keep(v.co) for v in f.verts)], context='FACES_ONLY')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    for v in bm.verts:
        v.co += v.normal * off
    bm.to_mesh(me)
    bm.free()
    me.materials.clear()
    me.materials.append(mat)
    me.name = name
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    return o


def decimate(ob, budget):
    tris = sum(len(p.vertices) - 2 for p in ob.data.polygons)
    if tris > budget:
        d = ob.modifiers.new('dec', 'DECIMATE')
        d.ratio = budget / tris
        with bpy.context.temp_override(object=ob, active_object=ob, selected_objects=[ob]):
            bpy.ops.object.modifier_apply(modifier=d.name)
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)


def build(key, mats):
    for o in list(bpy.data.objects):
        if not o.get('keep'):
            bpy.data.objects.remove(o, do_unlink=True)
    human = HS.create_human(mask_helpers=True, detailed_helpers=True, extra_vertex_groups=True, feet_on_ground=True,
                            scale=0.1, macro_detail_dict=PEOPLE[key])
    rig = HS.add_builtin_rig(human, 'default')
    worn = {k: HS.add_mhclo_asset(path, human, asset_type='Clothes', subdiv_levels=0, material_type='NONE') for k, path in CLOTHES}
    eyes = HS.add_mhclo_asset(os.path.join(UD, 'eyes', 'low-poly', 'low-poly.mhclo'), human, asset_type='Eyes', subdiv_levels=0, material_type='NONE')
    # what the clothes hide on the body (MPFB's delete groups, applied as MASK modifiers), and the helpers
    hidden = np.zeros(len(human.data.vertices), bool)
    names = {g.name for g in human.vertex_groups}
    for m in human.modifiers:
        if m.type == 'MASK':
            if m.vertex_group in names:
                inside = group_mask(human, lambda n, g=m.vertex_group: n == g)
                hidden |= inside if m.invert_vertex_group else ~inside
            m.show_viewport = m.show_render = False
    upd()
    # pose: arms forward and down toward the hands (so the shoulders take their working shape), the trunk leaning, head down
    for s in 'LR':
        sh, el = Hd(rig, 'upperarm01.' + s), Hd(rig, 'lowerarm01.' + s)
        align(rig, 'upperarm01.' + s, el - sh, Vector((0.12 if s == 'L' else -0.12, -0.25, -1.0)))
    for b, a in LEAN:
        rot_world(rig, b, (1, 0, 0), math.radians(a))
    for b, a in HEAD:
        rot_world(rig, b, (1, 0, 0), math.radians(a))
    arms_b = group_mask(human, lambda n: n.startswith(ARM_BONES))
    shoulders = {s: Hd(rig, 'upperarm01.' + s) for s in 'LR'}
    objs = [frozen(human, hidden | arms_b, 'rescuer_%s_skin' % key, mats['skin'], tuple(shoulders.values()))]
    for k, ob in worn.items():
        objs.append(frozen(ob, group_mask(ob, lambda n: n.startswith(ARM_BONES)), 'rescuer_%s_%s' % (key, k), mats[k], tuple(shoulders.values())))
    objs.append(frozen(eyes, np.zeros(len(eyes.data.vertices), bool), 'rescuer_%s_eyes' % key, mats['eyes']))
    # cap over the scalp and a mask over the nose and mouth, as thin layers of the head's own surface
    hd, nk = Hd(rig, 'head'), Hd(rig, 'neck01')
    up = (Hd(rig, 'head') - Hd(rig, 'neck01')).normalized()
    top = max((v.co for v in objs[0].data.vertices), key=lambda c: (c - hd).dot(up))
    hlen = (top - hd).dot(up)
    fwd = Vector((0, -1, 0)) - up * Vector((0, -1, 0)).dot(up)
    fwd.normalize()
    near = lambda c: (c - hd).length < hlen * 1.6
    cap = shell(objs[0], lambda c: near(c) and (c - hd).dot(up) > hlen * 0.55 - 0.03 * max(0, -(c - hd).dot(fwd)) / 0.1, 'rescuer_%s_cap' % key, mats['cap'], 0.004)
    lat = up.cross(fwd)
    mask = shell(objs[0], lambda c: near(c) and -0.10 < (c - hd).dot(up) < 0.03 and (c - hd).dot(fwd) > 0.02 and abs((c - hd).dot(lat)) < 0.075,
                 'rescuer_%s_mask' % key, mats['mask'], 0.004)                  # from under the eyes to below the chin, front of the face
    objs += [cap, mask]
    # landmarks (Blender frame, then to glTF: x, z, -y)
    P = np.array([v.co[:] for o in objs for v in o.data.vertices])               # the soles of the shoes stand on the floor
    sole = float(P[:, 2].min())
    for o in objs:
        o.data.transform(Matrix.Translation((0, 0, -sole)))
        o['keep'] = True
        decimate(o, TRI_BUDGET if o.name.endswith(('skin', 'gown')) else 2500)
    g = lambda v: [round(v[0], 4), round(v[2] - sole, 4), round(-v[1], 4)]
    info = dict(shoulderL=g(shoulders['L']), shoulderR=g(shoulders['R']), headTop=round(float(P[:, 2].max()) - sole, 4),
                shoulderWidth=round((shoulders['L'] - shoulders['R']).length, 4),
                triangles={o.name: sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objs})
    for o in [human, rig, eyes, *worn.values()]:
        bpy.data.objects.remove(o, do_unlink=True)
    log(key, json.dumps(info))
    return objs, info


def main():
    bpy.context.preferences.filepaths.save_version = 0
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    mats = {k: material('rescuer_' + k, c, 0.9 if k in ('gown', 'cap', 'mask') else 0.6) for k, c in COLORS.items()}
    allobjs, meta = [], {}
    for key in PEOPLE:
        objs, info = build(key, mats)
        allobjs += objs
        meta[key] = info
    for o in list(bpy.context.scene.objects):
        o.select_set(o in allobjs)
    props = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
    kw = dict(filepath=OUT_GLB, export_format='GLB', use_selection=True, export_yup=True, export_apply=False,
              export_normals=True, export_texcoords=False, export_tangents=False, export_materials='EXPORT',
              export_extras=False, export_animations=False, export_skins=False, export_morph=False, export_cameras=False,
              export_lights=False)
    if 'export_vertex_color' in props:
        kw['export_vertex_color'] = 'NONE'
    bpy.ops.export_scene.gltf(**{k: v for k, v in kw.items() if k in props or k == 'filepath'})
    with open(OUT_JSON, 'w') as f:
        json.dump({'frame': 'glTF metres: +Y up, faces +Z, origin between the soles', 'people': meta}, f, indent=1)
    log('exported', OUT_GLB, '%.3f MB' % (os.path.getsize(OUT_GLB) / 1e6))
    if '--no-renders' not in ARGS:
        render(allobjs)


def render(objs):
    os.makedirs(RENDER_DIR, exist_ok=True)
    sc = bpy.context.scene
    for i, o in enumerate(objs):                                # the two people side by side
        if o.name.startswith('rescuer_f'):
            o.location.x = 0.9
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    sc.collection.objects.link(cam)
    cam.location = (2.6, -3.2, 1.5)
    d = Vector((0.45, 0, 1.0)) - cam.location
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    sc.camera = cam
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.rotation_euler = (0.7, 0.2, 0.6)
    sc.collection.objects.link(sun)
    sc.render.engine = 'BLENDER_EEVEE_NEXT' if 'BLENDER_EEVEE_NEXT' in [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items] else 'BLENDER_EEVEE'
    sc.render.resolution_x, sc.render.resolution_y = 900, 700
    sc.render.filepath = os.path.join(RENDER_DIR, 'rescuer.png')
    bpy.ops.render.render(write_still=True)
    log('render', sc.render.filepath)


main()
