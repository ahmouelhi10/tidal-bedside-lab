"""Tidal Bedside Lab - the CPR rescuers -> src/web/assets/rescuer.glb (+ rescuer.json).

Two doctors made like the patient, from MakeHuman / MPFB (CC0): a man (`m`) and a woman (`f`) with real skin textures, eyes,
eyebrows, eyelashes and hair, in scrubs (MakeHuman's long-sleeved top and trousers re-dyed the pale blue of the gown sleeves on
the gloved hands in hands.glb, logo and stripes removed) and shoes. Each is posed leaning over a patient as for chest
compressions (hips flexed, back straight, head down) and exported twice:
  - `cpr`: the arms going down toward the patient's chest, cut at the elbow. The app puts the elbows where the gown sleeves
    of the gloved CPR hands end, so arm and hand join whatever the patient's size;
  - `idle`: the arms relaxed at the sides, elbows a little bent, the hands gloved (blue nitrile).
COLOR_0 carries, per vertex, how much it follows the trunk when the body bends at the base of the spine (R) and how much it
follows the head when it nods at the base of the neck (G), from the rig's own skinning weights.

Frame: glTF +Y up, the person faces +Z, origin between the soles on the floor. rescuer.json gives, per person: the two
shoulder joints, the two elbows of the `cpr` arms, the hip and neck hinges, the upper-arm length, the top of the head, the
shoulder width.

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
TMP = os.path.join(HERE, 'build-tmp', 'rescuer')


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
J = os.path.join

PEOPLE = {   # MakeHuman macro values (gender 1 = male; height 0.5 = average), skin, hair, brows
    'm': dict(macro=dict(gender=1.0, age=0.45, muscle=0.55, weight=0.5, proportions=0.5, height=0.55, cupsize=0.5, firmness=0.5,
                         race=dict(asian=0.2, caucasian=0.3, african=0.5)),
              skin=J(UD, 'skins', 'young_african_male', 'young_darkskinned_male_diffuse.png'),
              hair=J(UD, 'hair', 'short02', 'short02.mhclo'), brows=J(UD, 'eyebrows', 'eyebrow001', 'eyebrow001.mhclo'), hairTint=(0.22, 0.2, 0.19)),
    'f': dict(macro=dict(gender=0.0, age=0.42, muscle=0.5, weight=0.5, proportions=0.5, height=0.65, cupsize=0.45, firmness=0.5,
                         race=dict(asian=0.5, caucasian=0.4, african=0.1)),
              skin=J(UD, 'skins', 'young_asian_female', 'young_lightskinned_female_diffuse3.png'),
              hair=J(UD, 'hair', 'ponytail01', 'ponytail01.mhclo'), brows=J(UD, 'eyebrows', 'eyebrow006', 'eyebrow006.mhclo'),
              skinTint=(0.93, 0.82, 0.74)),   # the light texture reads pale under the bay's cool light: the app warms it
}
SCRUBS = J(UD, 'clothes', 'male_casualsuit02', 'male_casualsuit02.mhclo')
SHOES = J(UD, 'clothes', 'shoes02', 'shoes02.mhclo')
EYES = J(UD, 'eyes', 'low-poly', 'low-poly.mhclo')
LASHES = J(UD, 'eyelashes', 'eyelashes01', 'eyelashes01.mhclo')
SCRUB_RGB = (0.36, 0.55, 0.68)        # the pale blue of the gown sleeves in hands.glb
GLOVE_RGB = (0.23, 0.44, 0.85)        # nitrile, as in hands.glb
# Pose (degrees), standing frame +Z up, facing -Y: the trunk bends forward from the hips, the head looks down at the hands.
LEAN = (('spine05', 18.0), ('spine04', 12.0), ('spine03', 10.0), ('spine02', 8.0))
HEAD = (('neck01', -12.0), ('head', -8.0))
CPR_REACH = Vector((0.0, -0.51, -0.85))   # from the shoulders toward the hands on the chest (standing frame: forward -Y, down -Z)
FOREARM_BONES = ('lowerarm', 'wrist', 'finger', 'metacarpal')
HAND_BONES = ('wrist', 'finger', 'metacarpal')
LOWER_BONES = ('root', 'pelvis', 'upperleg', 'lowerleg', 'foot', 'toe')
BUDGET = dict(skin=6500, scrubs=5500, shoes=1400, hair=2600, gloves=1600)


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


def weights_by(ob, test):
    """Per vertex, summed weight over the vertex groups whose name passes test()."""
    gi = {g.index for g in ob.vertex_groups if test(g.name)}
    w = np.zeros(len(ob.data.vertices))
    for v in ob.data.vertices:
        w[v.index] = sum(g.weight for g in v.groups if g.group in gi)
    return w


def flex_weights(ob, bones, head_bones):
    """(trunk, head) per vertex from the skinning: the trunk is everything above the pelvis and legs (half of the lowest spine
    bone, where the bend starts); the head is the head and neck above the base of the neck (half of the lowest neck bone)."""
    is_bone = lambda n: n in bones
    tot = weights_by(ob, is_bone)
    low = weights_by(ob, lambda n: is_bone(n) and n.startswith(LOWER_BONES)) + 0.5 * weights_by(ob, lambda n: n == 'spine05')
    trunk = np.where(tot > 1e-6, np.clip(1 - low / np.maximum(tot, 1e-6), 0, 1), 1.0)
    head = np.where(tot > 1e-6, np.clip((weights_by(ob, lambda n: n in head_bones) + 0.5 * weights_by(ob, lambda n: n == 'neck01')) / np.maximum(tot, 1e-6), 0, 1), 0.0)
    return trunk, head


# ----------------------------------------------------------------------------- textures and materials
def load_scaled(path, size):
    im = bpy.data.images.load(path)
    if im.size[0] != size:
        im.scale(size, size)
    return im


def save(im, name, fmt, quality=88):
    os.makedirs(TMP, exist_ok=True)
    path = J(TMP, name)
    s = bpy.context.scene.render.image_settings
    s.file_format, s.color_mode = fmt, ('RGB' if fmt == 'JPEG' else 'RGBA')
    if fmt == 'JPEG':
        s.quality = quality
    im.save_render(path)
    out = bpy.data.images.load(path)
    out.name = name
    return out


def scrub_texture():
    """MakeHuman's top and jeans re-dyed as scrubs: the cloth's own shading kept, its colour, stripes, logo and jeans fading removed."""
    im = load_scaled(J(UD, 'clothes', 'male_casualsuit02', 'male_casualsuit02_diffuse.png'), 1024)
    n = im.size[0]
    a = np.array(im.pixels[:], np.float32).reshape(n, n, 4)
    rgb = a[..., :3]
    L = rgb @ np.array([0.3, 0.55, 0.15], np.float32)
    blue = rgb[..., 2] > rgb[..., 0] + 0.15                      # the fabric; orange stripes, logo and the small print are not
    for _ in range(3):                                           # and the soft edges around them
        blue &= np.roll(blue, 1, 0) & np.roll(blue, -1, 0) & np.roll(blue, 1, 1) & np.roll(blue, -1, 1)
    L[~blue] = np.median(L[blue])
    rows = np.repeat(np.arange(n)[:, None], n, axis=1)
    trousers = rows < n * 0.58                                   # Blender images start at the bottom: the jeans are the lower part
    for part, keep in ((trousers, 0.35), (~trousers, 0.8)):      # jeans fading softened; the top's knit kept
        m = float(np.median(L[part & blue]))
        L[part] = m * (1 + keep * (L[part] / m - 1))
    f = np.clip(L / float(np.median(L)), 0.55, 1.45)
    for c in range(3):
        a[..., c] = SCRUB_RGB[c] * f
    a[..., 3] = 1
    out = bpy.data.images.new('scrubs_albedo', n, n)
    out.pixels.foreach_set(a.ravel())
    return save(out, 'scrubs_albedo.jpg', 'JPEG', 86)


def material(name, rgb=(1, 1, 1), image=None, normal=None, alpha=None, rough=0.7):
    m = bpy.data.materials.new(name)
    m.use_fake_user = True                        # MPFB purges unused data while it builds a human
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*rgb, 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = 0.0
    if image:
        image.use_fake_user = True
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = image
        nt.links.new(t.outputs['Color'], b.inputs['Base Color'])
        if alpha:
            nt.links.new(t.outputs['Alpha'], b.inputs['Alpha'])
            m.blend_method = 'BLEND' if alpha == 'blend' else 'CLIP'
    if normal:
        normal.use_fake_user = True
        normal.colorspace_settings.name = 'Non-Color'
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = normal
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nt.links.new(t.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
    return m


def materials():
    def tex(path, size, name, fmt):
        return save(load_scaled(path, size), name, fmt)
    mats = {
        'scrubs': material('rescuer_scrubs', image=scrub_texture(),
                           normal=tex(J(UD, 'clothes', 'male_casualsuit02', 'male_casualsuit02_normal.png'), 1024, 'scrubs_normal.jpg', 'JPEG'), rough=0.9),
        'shoes': material('rescuer_shoes', image=tex(J(UD, 'clothes', 'shoes02', 'shoes02_diffuse.png'), 512, 'shoes.jpg', 'JPEG')),
        'eyes': material('rescuer_eyes', image=tex(J(UD, 'eyes', 'materials', 'brown_eye.png'), 256, 'eyes.jpg', 'JPEG'), rough=0.1),
        'lashes': material('rescuer_lashes', image=tex(J(UD, 'eyelashes', 'eyelashes01', 'eyelashes01.png'), 256, 'lashes.png', 'PNG'), alpha='blend'),
        'gloves': material('rescuer_gloves', rgb=GLOVE_RGB, rough=0.55),
    }
    for k, P in PEOPLE.items():
        mats['skin_' + k] = material('rescuer_skin_' + k, image=tex(P['skin'], 1024, 'skin_%s.jpg' % k, 'JPEG'), rough=0.55)
        hair = load_scaled(os.path.splitext(P['hair'])[0] + '_diffuse.png', 512)
        if P.get('hairTint'):                         # MakeHuman's short hair is light brown: dyed to this person's own colour
            px = np.array(hair.pixels[:], np.float32).reshape(-1, 4)
            px[:, :3] *= np.array(P['hairTint'], np.float32)
            hair.pixels.foreach_set(px.ravel())
        mats['hair_' + k] = material('rescuer_hair_' + k, image=save(hair, 'hair_%s.png' % k, 'PNG'), alpha='clip', rough=0.6)
        mats['brows_' + k] = material('rescuer_brows_' + k, image=tex(os.path.splitext(P['brows'])[0] + '.png', 256, 'brows_%s.png' % k, 'PNG'), alpha='blend')
    return mats


# ----------------------------------------------------------------------------- meshes
def frozen(ob, drop, name, mat, flex, close=()):
    """The posed object as a plain mesh in world space without the vertices in `drop`, with the bend weights in COLOR_0."""
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ev, depsgraph=dg)
    me.transform(ev.matrix_world)
    ca = me.color_attributes.new('flex', 'FLOAT_COLOR', 'POINT')
    col = np.zeros((len(me.vertices), 4), np.float32)
    col[:, 0], col[:, 1], col[:, 3] = flex[0], flex[1], 1
    ca.data.foreach_set('color', col.ravel())
    me.color_attributes.active_color = ca
    me.color_attributes.render_color_index = me.color_attributes.active_color_index
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if drop[v.index]], context='VERTS')
    if close:                                         # close the openings left where the arms were cut
        near = lambda co: any((co - c).length < 0.13 for c in close)
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


def decimate(ob, budget):
    tris = sum(len(p.vertices) - 2 for p in ob.data.polygons)
    if tris > budget:
        d = ob.modifiers.new('dec', 'DECIMATE')
        d.ratio = budget / tris
        with bpy.context.temp_override(object=ob, active_object=ob, selected_objects=[ob]):
            bpy.ops.object.modifier_apply(modifier=d.name)


def pose_arms(rig, variant):
    mid = (Hd(rig, 'upperarm01.L') + Hd(rig, 'upperarm01.R')) / 2
    for s in 'LR':
        sx = 1.0 if s == 'L' else -1.0
        sh = Hd(rig, 'upperarm01.' + s)
        if variant == 'cpr':                          # straight arms converging on the hands, the shoulders over them
            tgt = mid + CPR_REACH.normalized() * 0.55 - sh
            align(rig, 'upperarm01.' + s, Hd(rig, 'lowerarm01.' + s) - sh, tgt)
            align(rig, 'lowerarm01.' + s, Hd(rig, 'wrist.' + s) - Hd(rig, 'lowerarm01.' + s), tgt)
        else:                                         # relaxed at the sides, elbows a little bent, hands forward
            align(rig, 'upperarm01.' + s, Hd(rig, 'lowerarm01.' + s) - sh, Vector((sx * 0.16, -0.12, -1.0)))
            el = Hd(rig, 'lowerarm01.' + s)
            align(rig, 'lowerarm01.' + s, Hd(rig, 'wrist.' + s) - el, Vector((sx * 0.08, -0.45, -1.0)))
            wr = Hd(rig, 'wrist.' + s)
            align(rig, 'wrist.' + s, Hd(rig, 'finger3-1.' + s) - wr, Vector((sx * 0.05, -0.4, -1.0)))


def build(key, mats):
    for o in list(bpy.data.objects):
        if not o.get('keep'):
            bpy.data.objects.remove(o, do_unlink=True)
    P = PEOPLE[key]
    human = HS.create_human(mask_helpers=True, detailed_helpers=True, extra_vertex_groups=True, feet_on_ground=True,
                            scale=0.1, macro_detail_dict=P['macro'])
    rig = HS.add_builtin_rig(human, 'default')
    add = lambda path, typ: HS.add_mhclo_asset(path, human, asset_type=typ, subdiv_levels=0, material_type='NONE')
    worn = {'scrubs': add(SCRUBS, 'Clothes'), 'shoes': add(SHOES, 'Clothes'), 'eyes': add(EYES, 'Eyes'),
            'brows': add(P['brows'], 'Eyebrows'), 'lashes': add(LASHES, 'Eyelashes'), 'hair': add(P['hair'], 'Hair')}
    hidden = np.zeros(len(human.data.vertices), bool)             # helpers, and the body under the clothes (MPFB's delete groups)
    names = {g.name for g in human.vertex_groups}
    for m in human.modifiers:
        if m.type == 'MASK':
            if m.vertex_group in names:
                inside = weights_by(human, lambda n, g=m.vertex_group: n == g) > 0.5
                hidden |= inside if m.invert_vertex_group else ~inside
            m.show_viewport = m.show_render = False
    bones = {b.name for b in rig.data.bones}
    head_bones = {b.name for b in rig.data.bones if b.name in ('neck02', 'neck03', 'head') or any(p.name == 'head' for p in b.parent_recursive)}
    flex = {'skin': flex_weights(human, bones, head_bones), **{k: flex_weights(o, bones, head_bones) for k, o in worn.items()}}
    upd()
    for b, a in LEAN:
        rot_world(rig, b, (1, 0, 0), math.radians(a))
    for b, a in HEAD:
        rot_world(rig, b, (1, 0, 0), math.radians(a))
    info, objs, none = {}, [], lambda ob: np.zeros(len(ob.data.vertices), bool)
    for variant in ('cpr', 'idle'):
        pose_arms(rig, variant)
        pre = 'rescuer_%s_%s_' % (key, variant)
        if variant == 'cpr':                          # cut at the elbows: the gloved hand's gown sleeve carries on from there
            elbows = [Hd(rig, 'lowerarm01.' + s) for s in 'LR']
            fore = lambda ob: weights_by(ob, lambda n: n.startswith(FOREARM_BONES)) > 0.5
            objs.append(frozen(human, hidden | fore(human), pre + 'skin', mats['skin_' + key], flex['skin'], elbows))
            objs.append(frozen(worn['scrubs'], fore(worn['scrubs']), pre + 'scrubs', mats['scrubs'], flex['scrubs'], elbows))
            info.update(shoulderL=Hd(rig, 'upperarm01.L'), shoulderR=Hd(rig, 'upperarm01.R'), elbowL=elbows[0], elbowR=elbows[1],
                        hip=Hd(rig, 'spine05'), neck=Hd(rig, 'neck01'))
            upper_arm = (elbows[0] - info['shoulderL']).length
        else:
            hand = weights_by(human, lambda n: n.startswith(HAND_BONES)) > 0.5
            objs.append(frozen(human, hidden | hand, pre + 'skin', mats['skin_' + key], flex['skin']))
            objs.append(frozen(human, ~hand, pre + 'gloves', mats['gloves'], flex['skin']))   # the hands, gloved
            objs.append(frozen(worn['scrubs'], none(worn['scrubs']), pre + 'scrubs', mats['scrubs'], flex['scrubs']))
        for k in ('shoes', 'eyes', 'brows', 'lashes', 'hair'):
            objs.append(frozen(worn[k], none(worn[k]), pre + k, mats[k + '_' + key] if k in ('brows', 'hair') else mats[k], flex[k]))
    # soles on the floor; triangle budgets; landmarks to glTF (x, z, -y)
    sole = min(min(v.co.z for v in o.data.vertices) for o in objs if o.data.vertices)
    for o in objs:
        o.data.transform(Matrix.Translation((0, 0, -sole)))
        o['keep'] = True
        part = o.name.split('_')[-1]
        if part in BUDGET:
            decimate(o, BUDGET[part])
    g = lambda v: [round(v[0], 4), round(v[2] - sole, 4), round(-v[1], 4)]
    top = max(max(v.co.z for v in o.data.vertices) for o in objs if o.data.vertices)
    out = {k: g(v) for k, v in info.items()}
    if P.get('skinTint'):
        out['skinTint'] = list(P['skinTint'])
    out.update(upperArm=round(upper_arm, 4), headTop=round(top, 4), shoulderWidth=round((info['shoulderL'] - info['shoulderR']).length, 4),
               triangles={o.name: sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objs})
    for o in [human, rig, *worn.values()]:
        bpy.data.objects.remove(o, do_unlink=True)
    log(key, json.dumps({k: v for k, v in out.items() if k != 'triangles'}), 'triangles', sum(out['triangles'].values()))
    return objs, out


def main():
    bpy.context.preferences.filepaths.save_version = 0
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    mats = materials()
    allobjs, meta = [], {}
    for key in PEOPLE:
        objs, info = build(key, mats)
        allobjs += objs
        meta[key] = info
    for o in list(bpy.context.scene.objects):
        o.select_set(o in allobjs)
    props = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
    kw = dict(filepath=OUT_GLB, export_format='GLB', use_selection=True, export_yup=True, export_apply=False,
              export_normals=True, export_texcoords=True, export_tangents=False, export_materials='EXPORT', export_image_format='AUTO',
              export_extras=False, export_animations=False, export_skins=False, export_morph=False, export_cameras=False,
              export_lights=False)
    if 'export_vertex_color' in props:
        kw['export_vertex_color'] = 'ACTIVE'
    if 'export_all_vertex_colors' in props:
        kw['export_all_vertex_colors'] = False
    if 'export_colors' in props:
        kw['export_colors'] = True
    bpy.ops.export_scene.gltf(**{k: v for k, v in kw.items() if k in props or k == 'filepath'})
    with open(OUT_JSON, 'w') as f:
        json.dump({'frame': 'glTF metres: +Y up, faces +Z, origin between the soles', 'people': meta}, f, indent=1)
    log('exported', OUT_GLB, '%.3f MB' % (os.path.getsize(OUT_GLB) / 1e6))
    if '--no-renders' not in ARGS:
        render(allobjs)


def render(objs):
    os.makedirs(RENDER_DIR, exist_ok=True)
    sc = bpy.context.scene
    for o in objs:                                    # the two people side by side, each in both arm poses
        k, v = o.name.split('_')[1], o.name.split('_')[2]
        o.location.x = (0.9 if k == 'f' else 0) + (1.8 if v == 'idle' else 0)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    sc.collection.objects.link(cam)
    cam.location = (3.2, -4.6, 1.7)
    cam.rotation_euler = (Vector((1.35, 0, 0.95)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    sc.camera = cam
    for rot, e in (((0.7, 0.2, 0.6), 3.0), ((1.2, 0, -2.4), 1.2)):
        sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
        sun.data.energy = e
        sun.rotation_euler = rot
        sc.collection.objects.link(sun)
    sc.render.engine = 'BLENDER_EEVEE_NEXT' if 'BLENDER_EEVEE_NEXT' in [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items] else 'BLENDER_EEVEE'
    s = sc.render.image_settings
    s.file_format, s.color_mode = 'PNG', 'RGBA'
    sc.render.resolution_x, sc.render.resolution_y = 1100, 650
    sc.render.filepath = J(RENDER_DIR, 'rescuer.png')
    bpy.ops.render.render(write_still=True)
    log('render', sc.render.filepath)


main()
