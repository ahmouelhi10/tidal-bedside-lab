"""Tidal Bedside Lab - reproducible build of the instrument set (procedural, no external assets).

Writes src/web/assets/instruments.glb, assets-src/instruments.blend and assets-src/renders/instruments.png.

Run from the repository root:
    blender -b --python assets-src/build_instruments.py
    blender -b --python assets-src/build_instruments.py -- --no-renders --no-blend

Conventions (see assets-src/README.md): metres, real-world size, glTF +Y up. Every instrument is a top-level node
at the origin with an identity transform. The origin is the working point (needle/blade/tube tip, pad centre,
gauze contact point, tourniquet loop centre) and the instrument's long axis points along +Y from that point
toward the handle, so placing an instrument = put its origin on the landmark and turn +Y to the approach direction.
"""
import bpy
import bmesh
import json
import math
import os
import sys

from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT_GLB = os.path.join(REPO, 'src', 'web', 'assets', 'instruments.glb')
OUT_BLEND = os.path.join(HERE, 'instruments.blend')
RENDER = os.path.join(HERE, 'renders', 'instruments.png')
SEG = 20   # radial segments for round parts


# ----------------------------------------------------------------------------- materials
def mat(name, color, metal=0.0, rough=0.5, alpha=1.0):
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*color, 1)
    b.inputs['Metallic'].default_value = metal
    b.inputs['Roughness'].default_value = rough
    if alpha < 1.0:
        b.inputs['Alpha'].default_value = alpha
        if hasattr(m, 'surface_render_method'):
            m.surface_render_method = 'BLENDED'
        if hasattr(m, 'blend_method'):
            m.blend_method = 'BLEND'
    return m


STEEL = lambda: mat('steel', (0.78, 0.79, 0.8), metal=1.0, rough=0.28)
CLEAR = lambda: mat('clear_plastic', (0.9, 0.95, 0.97), rough=0.08, alpha=0.35)
WHITE = lambda: mat('white_plastic', (0.88, 0.88, 0.86), rough=0.45)
BLACK = lambda: mat('black_rubber', (0.025, 0.025, 0.028), rough=0.6)
ORANGE = lambda: mat('orange_14G', (0.95, 0.38, 0.05), rough=0.4)
GREEN = lambda: mat('green_18G', (0.05, 0.55, 0.2), rough=0.4)
GAUZE = lambda: mat('gauze', (0.92, 0.92, 0.9), rough=0.95)
BLUE = lambda: mat('blue_band', (0.12, 0.35, 0.75), rough=0.55)
STRAW = lambda: mat('bougie_straw', (0.78, 0.66, 0.38), rough=0.5)
DARK = lambda: mat('scope_dark', (0.06, 0.065, 0.07), rough=0.35)
GREY = lambda: mat('scope_grey', (0.35, 0.37, 0.4), metal=0.3, rough=0.35)
PAD = lambda: mat('pad_foam', (0.93, 0.93, 0.9), rough=0.8)
GEL = lambda: mat('pad_gel', (0.35, 0.6, 0.85), rough=0.2)
RED = lambda: mat('red_wire', (0.75, 0.08, 0.06), rough=0.5)
GLASS = lambda: mat('lens', (0.02, 0.02, 0.03), rough=0.05, metal=0.2)


# ----------------------------------------------------------------------------- primitives (Blender Z = glTF +Y)
def new_obj(name, bm, material):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(material)
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    return o


def cyl(name, r1, r2, z0, z1, material, seg=SEG, x=0.0, y=0.0, cap=True):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=cap, cap_tris=False, segments=seg, radius1=r1, radius2=r2, depth=z1 - z0)
    bmesh.ops.translate(bm, verts=bm.verts, vec=(x, y, (z0 + z1) / 2))
    return new_obj(name, bm, material)


def box(name, sx, sy, sz, cx, cy, cz, material, rz=0.0):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=(sx, sy, sz), verts=bm.verts)
    if rz:
        bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(rz, 3, 'Z'))
    bmesh.ops.translate(bm, verts=bm.verts, vec=(cx, cy, cz))
    return new_obj(name, bm, material)


def torus(name, R, r, center, axis, material, seg=24, rseg=10, sx=1.0):
    bm = bmesh.new()
    verts = []
    for i in range(seg):
        a = 2 * math.pi * i / seg
        ring = []
        for j in range(rseg):
            b = 2 * math.pi * j / rseg
            p = Vector(((R + r * math.cos(b)) * math.cos(a) * sx, (R + r * math.cos(b)) * math.sin(a), r * math.sin(b)))
            ring.append(bm.verts.new(p))
        verts.append(ring)
    for i in range(seg):
        for j in range(rseg):
            bm.faces.new((verts[i][j], verts[(i + 1) % seg][j], verts[(i + 1) % seg][(j + 1) % rseg], verts[i][(j + 1) % rseg]))
    rot = Vector((0, 0, 1)).rotation_difference(Vector(axis)).to_matrix()
    bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=rot)
    bmesh.ops.translate(bm, verts=bm.verts, vec=center)
    return new_obj(name, bm, material)


def tube_path(name, pts, r, material, seg=12, cap=True):
    """Sweep a circle along a polyline (parallel-transport frames)."""
    bm = bmesh.new()
    pts = [Vector(p) for p in pts]
    rings = []
    prev_n = None
    for i, p in enumerate(pts):
        t = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
        if prev_n is None:
            a = Vector((1, 0, 0)) if abs(t.x) < 0.9 else Vector((0, 1, 0))
            n = t.cross(a).normalized()
        else:
            n = (prev_n - t * prev_n.dot(t)).normalized()
        prev_n = n
        b = t.cross(n)
        rings.append([bm.verts.new(p + (n * math.cos(2 * math.pi * k / seg) + b * math.sin(2 * math.pi * k / seg)) * r) for k in range(seg)])
    for i in range(len(rings) - 1):
        for k in range(seg):
            bm.faces.new((rings[i][k], rings[i + 1][k], rings[i + 1][(k + 1) % seg], rings[i][(k + 1) % seg]))
    if cap:
        bm.faces.new(list(reversed(rings[0])))
        bm.faces.new(rings[-1])
    return new_obj(name, bm, material)


def prism(name, profile_xz, thick, material):
    """Flat plate from an XZ outline (counter-clockwise), thickness along Y."""
    bm = bmesh.new()
    f = bm.faces.new([bm.verts.new((x, -thick / 2, z)) for x, z in profile_xz])
    ext = bmesh.ops.extrude_face_region(bm, geom=[f])
    bmesh.ops.translate(bm, verts=[v for v in ext['geom'] if isinstance(v, bmesh.types.BMVert)], vec=(0, thick, 0))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return new_obj(name, bm, material)


def rounded_rect(name, w, h, t, r, z0, material, seg=6):
    pts = []
    for cx, cy, a0 in ((w / 2 - r, h / 2 - r, 0), (-w / 2 + r, h / 2 - r, 90), (-w / 2 + r, -h / 2 + r, 180), (w / 2 - r, -h / 2 + r, 270)):
        for k in range(seg + 1):
            a = math.radians(a0 + 90 * k / seg)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    bm = bmesh.new()
    f = bm.faces.new([bm.verts.new((x, y, z0)) for x, y in pts])
    ext = bmesh.ops.extrude_face_region(bm, geom=[f])
    bmesh.ops.translate(bm, verts=[v for v in ext['geom'] if isinstance(v, bmesh.types.BMVert)], vec=(0, 0, t))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return new_obj(name, bm, material)


def join(name, parts, info):
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for p in parts:
        p.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    with bpy.context.temp_override(active_object=parts[0], selected_editable_objects=parts, selected_objects=parts):
        bpy.ops.object.join()
    o = parts[0]
    o.name = o.data.name = name
    for p in o.data.polygons:
        p.use_smooth = True
    o.data.set_sharp_from_angle(angle=math.radians(35)) if hasattr(o.data, 'set_sharp_from_angle') else None
    for k, v in info.items():
        o[k] = v
    return o


# ----------------------------------------------------------------------------- instruments
def syringe():
    P = [cyl('s_tip', 0.0011, 0.0019, 0.0, 0.009, CLEAR()),
         cyl('s_cone', 0.0019, 0.0078, 0.009, 0.013, CLEAR()),
         cyl('s_barrel', 0.0078, 0.0078, 0.013, 0.088, CLEAR(), cap=False),
         box('s_flange', 0.036, 0.012, 0.0022, 0, 0, 0.089, CLEAR()),
         cyl('s_stopper', 0.0074, 0.0074, 0.050, 0.057, BLACK()),
         box('s_rod1', 0.0115, 0.0018, 0.078, 0, 0, 0.096, WHITE()),
         box('s_rod2', 0.0018, 0.0115, 0.078, 0, 0, 0.096, WHITE()),
         cyl('s_press', 0.0105, 0.0105, 0.135, 0.137, WHITE())]
    return join('syringe', P, {'label': '10 mL Luer syringe', 'tip': 'origin', 'axis': '+Y', 'length_m': 0.137})


def needle14():
    P = [cyl('n_bevel', 0.00002, 0.0008, 0.0, 0.004, STEEL(), seg=10),
         cyl('n_needle', 0.0008, 0.0008, 0.004, 0.11, STEEL(), seg=10),
         cyl('n_cath_tip', 0.0008, 0.00105, 0.004, 0.006, WHITE(), seg=12),
         cyl('n_cath', 0.00105, 0.00105, 0.006, 0.084, mat('catheter', (0.92, 0.94, 0.95), rough=0.3, alpha=0.7), seg=12),
         cyl('n_hub', 0.0024, 0.0042, 0.084, 0.102, ORANGE()),
         cyl('n_hubring', 0.0048, 0.0048, 0.100, 0.103, ORANGE()),
         cyl('n_flash', 0.0038, 0.0038, 0.103, 0.132, mat('flash_orange', (0.95, 0.55, 0.2), rough=0.1, alpha=0.5)),
         cyl('n_cap', 0.0041, 0.0041, 0.132, 0.137, WHITE())]
    return join('needle14G', P, {'label': '14 G 8 cm catheter-over-needle (needle decompression)', 'tip': 'origin', 'axis': '+Y',
                                 'length_m': 0.137, 'catheterLength_m': 0.08})


def scalpel():
    blade = [(-0.0021, 0.046), (-0.0021, 0.012), (-0.0013, 0.0045), (0.0, 0.0), (0.0024, 0.0028), (0.0048, 0.0082),
             (0.0061, 0.016), (0.0063, 0.03), (0.0052, 0.046)]
    P = [prism('sc_blade', blade, 0.0004, STEEL()),
         box('sc_tang', 0.0055, 0.0018, 0.016, 0.0016, 0, 0.052, STEEL()),
         box('sc_handle', 0.0105, 0.0026, 0.115, 0.0016, 0, 0.117, STEEL()),
         box('sc_grip', 0.0108, 0.0028, 0.03, 0.0016, 0, 0.083, mat('steel_grip', (0.55, 0.56, 0.57), metal=1.0, rough=0.55))]
    return join('scalpel', P, {'label': 'No. 3 handle with No. 10 blade', 'tip': 'origin (blade tip)', 'axis': '+Y',
                               'edge': '+X side is the cutting belly', 'length_m': 0.175})


def bougie():
    a = math.radians(35)
    pts = [(0, 0, 0)]
    for k in range(1, 6):                       # coude tip: 2.5 cm, 35 degrees off the shaft axis
        s = 0.025 * k / 5
        pts.append((s * math.sin(a), 0, s * math.cos(a)))
    x0, z0 = pts[-1][0], pts[-1][2]
    for k in range(1, 13):
        pts.append((x0, 0, z0 + 0.6 * k / 12))
    P = [tube_path('b_shaft', pts, 0.0025, STRAW(), seg=12),
         cyl('b_tipcap', 0.0025, 0.0025, -0.0005, 0.0005, STRAW(), seg=12)]
    return join('bougie', P, {'label': '15 Fr 60 cm introducer, 35 degree coude tip (tip bends toward +X)', 'tip': 'origin',
                              'axis': '+Y', 'length_m': 0.625})


def chest_drain():
    pvc = mat('drain_pvc', (0.88, 0.93, 0.95), rough=0.15, alpha=0.55)
    P = [cyl('d_tipround', 0.003, 0.00465, 0.0, 0.004, pvc),
         cyl('d_tube', 0.00465, 0.00465, 0.004, 0.40, pvc, cap=False),
         box('d_stripe', 0.0012, 0.0005, 0.396, 0, -0.0046, 0.202, BLUE()),
         cyl('d_conn', 0.0052, 0.0062, 0.40, 0.43, WHITE()),
         cyl('d_conn2', 0.0042, 0.0042, 0.43, 0.46, WHITE())]
    for i, z in enumerate((0.012, 0.03, 0.05, 0.07)):           # side eyes
        ang = (i % 2) * math.pi
        P.append(box('d_eye%d' % i, 0.0045, 0.0012, 0.008, 0.0045 * math.cos(ang), 0.0045 * math.sin(ang), z, BLACK(), rz=ang + math.pi / 2))
    return join('chestDrain', P, {'label': '28 Fr 40 cm chest drain with side eyes and radio-opaque stripe', 'tip': 'origin',
                                  'axis': '+Y', 'length_m': 0.46})


def forceps_gauze():
    P = []
    for s in (-1, 1):
        P.append(torus('f_jaw%d' % s, 0.0075, 0.0012, (s * 0.0035, 0, 0.022), (0, 1, 0), STEEL(), seg=16, rseg=6, sx=0.6))
        pts = [(s * 0.0035, 0, 0.03), (s * 0.003, 0, 0.11), (s * 0.0025, 0, 0.15), (s * 0.012, 0, 0.215), (s * 0.017, 0, 0.228)]
        P.append(tube_path('f_shank%d' % s, pts, 0.0016, STEEL(), seg=8))
        P.append(torus('f_ring%d' % s, 0.011, 0.0018, (s * 0.024, 0, 0.238), (0, 1, 0), STEEL(), seg=20, rseg=8))
        P.append(box('f_ratchet%d' % s, 0.004, 0.0025, 0.007, s * 0.006, 0, 0.205, STEEL()))
    P.append(box('f_boxlock', 0.009, 0.0045, 0.012, 0, 0, 0.15, STEEL()))
    # gauze swab folded into a ball: deterministic lumpy sphere, contact point at the origin
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=3, radius=0.013)
    for v in bm.verts:
        d = v.co.normalized()
        v.co *= 1.0 + 0.09 * math.sin(7 * d.x + 3 * d.y) * math.cos(5 * d.z + 2 * d.x) + 0.05 * math.sin(13 * d.y + 11 * d.z)
        v.co.z *= 1.15
    bmesh.ops.translate(bm, verts=bm.verts, vec=(0, 0, 0.0145))
    P.insert(0, new_obj('f_gauze', bm, GAUZE()))
    return join('forcepsGauze', P, {'label': 'Sponge-holding forceps with folded gauze swab', 'tip': 'origin (gauze contact point)',
                                    'axis': '+Y', 'length_m': 0.25})


def tourniquet():
    bm = bmesh.new()
    R, w, t, n = 0.045, 0.025, 0.0016, 72
    rings = []
    span = 2 * math.pi + 0.5                      # overlapping strap ends
    for i in range(n + 1):
        a = span * i / n - 0.25
        r = R + 0.0022 * (a / (2 * math.pi))      # slight spiral so the ends overlap without intersecting
        c, s_ = math.cos(a), math.sin(a)
        ring = [bm.verts.new((rr * c, rr * s_, z)) for rr, z in ((r, -w / 2), (r, w / 2), (r + t, w / 2), (r + t, -w / 2))]
        rings.append(ring)
    for i in range(n):
        for k in range(4):
            bm.faces.new((rings[i][k], rings[i + 1][k], rings[i + 1][(k + 1) % 4], rings[i][(k + 1) % 4]))
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    band = new_obj('t_band', bm, BLUE())
    buckle = box('t_buckle', 0.012, 0.03, 0.032, R + 0.008, 0.0, 0.0, BLACK())
    return join('tourniquet', [band, buckle], {'label': 'Quick-release tourniquet strap around a 9 cm limb',
                                                'tip': 'origin (loop centre)', 'axis': '+Y (align with the limb axis)', 'length_m': 0.035})


def iv_cannula():
    P = [cyl('c_bevel', 0.00002, 0.0006, 0.0, 0.003, STEEL(), seg=10),
         cyl('c_needle', 0.0006, 0.0006, 0.003, 0.075, STEEL(), seg=10),
         cyl('c_cath_tip', 0.0006, 0.00068, 0.003, 0.0045, WHITE(), seg=12),
         cyl('c_cath', 0.00068, 0.00068, 0.0045, 0.048, mat('catheter', (0.92, 0.94, 0.95), rough=0.3, alpha=0.7), seg=12),
         cyl('c_hub', 0.0018, 0.0034, 0.048, 0.062, GREEN()),
         box('c_wings', 0.03, 0.0012, 0.011, 0, 0, 0.054, GREEN()),
         cyl('c_port', 0.0022, 0.0022, 0.0, 0.007, GREEN()),
         cyl('c_flash', 0.003, 0.003, 0.062, 0.085, CLEAR()),
         cyl('c_plug', 0.0033, 0.0033, 0.085, 0.09, WHITE())]
    port = P[6]
    port.data.transform(Matrix.Rotation(math.pi / 2, 4, 'X'))
    port.data.transform(Matrix.Translation((0, -0.0045, 0.057)))
    return join('ivCannula', P, {'label': '18 G 45 mm peripheral IV cannula with wings and injection port', 'tip': 'origin',
                                 'axis': '+Y', 'length_m': 0.09})


def defib_pad(name):
    P = [rounded_rect(name + '_gel', 0.118, 0.088, 0.0015, 0.012, 0.0, GEL()),
         rounded_rect(name + '_foam', 0.124, 0.094, 0.0025, 0.014, 0.0015, PAD()),
         box(name + '_mark', 0.03, 0.006, 0.0006, 0, 0, 0.0043, RED()),
         box(name + '_mark2', 0.006, 0.03, 0.0006, 0, 0, 0.0043, RED())]
    P.append(tube_path(name + '_lead', [(0.062, 0, 0.002), (0.09, 0, 0.004), (0.14, 0.01, 0.006), (0.2, 0.03, 0.006)], 0.0018, RED(), seg=8))
    return join(name, P, {'label': 'Adult multifunction defibrillation pad (gel side faces -Y, lead toward +X)',
                          'tip': 'origin (pad centre on the skin)', 'axis': '+Y (outward skin normal)', 'length_m': 0.124})


def bronchoscope():
    pts = [(0, 0, 0.004 + 0.6 * k / 30) for k in range(31)]
    P = [cyl('br_tip', 0.0026, 0.0026, 0.0, 0.004, GREY(), seg=16),
         cyl('br_lens', 0.0009, 0.0009, -0.0002, 0.0002, GLASS(), seg=10, x=0.0008),
         cyl('br_channel', 0.0006, 0.0006, -0.0002, 0.0002, BLACK(), seg=8, x=-0.0010),
         tube_path('br_insertion', pts, 0.0026, DARK(), seg=14),
         cyl('br_relief', 0.0026, 0.008, 0.604, 0.64, DARK()),
         cyl('br_body', 0.016, 0.017, 0.64, 0.74, GREY(), seg=24),
         cyl('br_head', 0.017, 0.014, 0.74, 0.77, DARK(), seg=24),
         cyl('br_eyepiece', 0.011, 0.012, 0.77, 0.80, DARK(), seg=24),
         box('br_lever', 0.004, 0.022, 0.012, 0, -0.026, 0.75, BLACK()),
         cyl('br_suction', 0.004, 0.004, 0.0, 0.02, GREY(), seg=12)]
    s = P[-1]
    s.data.transform(Matrix.Rotation(-math.pi / 2.5, 4, 'Y'))
    s.data.transform(Matrix.Translation((0.016, 0, 0.73)))
    cord = [(-0.016, 0, 0.70), (-0.05, 0, 0.69), (-0.1, 0, 0.66), (-0.16, 0, 0.6), (-0.2, 0, 0.52)]
    P.append(tube_path('br_cord', cord, 0.0045, DARK(), seg=10))
    return join('bronchoscope', P, {'label': 'Flexible bronchoscope, 5.2 mm insertion tube 60 cm, handle with thumb lever',
                                    'tip': 'origin (distal lens)', 'axis': '+Y', 'length_m': 0.80})


# ----------------------------------------------------------------------------- main
def main():
    bpy.context.preferences.filepaths.save_version = 0      # no .blend1 backups
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for _ in range(3):
        bpy.data.orphans_purge(do_local_ids=True, do_linked_ids=True, do_recursive=True)
    objs = [syringe(), needle14(), scalpel(), bougie(), chest_drain(), forceps_gauze(), tourniquet(), iv_cannula(),
            defib_pad('defibPadRight'), defib_pad('defibPadLeft'), bronchoscope()]
    report = {}
    for o in objs:
        o.location = (0, 0, 0)
        tris = sum(len(p.vertices) - 2 for p in o.data.polygons)
        report[o.name] = {'triangles': tris, 'label': o['label']}
    if '--no-blend' not in ARGS:
        bpy.ops.wm.save_as_mainfile(filepath=OUT_BLEND, compress=True)
    for o in bpy.context.view_layer.objects:
        o.select_set(o in objs)
    os.makedirs(os.path.dirname(OUT_GLB), exist_ok=True)
    props = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
    kw = dict(filepath=OUT_GLB, export_format='GLB', use_selection=True, export_yup=True, export_apply=True,
              export_normals=True, export_texcoords=False, export_tangents=False, export_materials='EXPORT',
              export_extras=True, export_animations=False, export_skins=False, export_morph=False, export_cameras=False,
              export_lights=False)
    if 'export_vertex_color' in props:
        kw['export_vertex_color'] = 'NONE'
    bpy.ops.export_scene.gltf(**{k: v for k, v in kw.items() if k in props or k == 'filepath'})
    total = sum(v['triangles'] for v in report.values())
    print('[instruments]', json.dumps(report), 'total triangles', total, '%.3f MB' % (os.path.getsize(OUT_GLB) / 1e6), flush=True)
    if '--no-renders' not in ARGS:
        render(objs)


def render(objs):
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = 64
    sc.cycles.use_denoising = True
    sc.render.resolution_x, sc.render.resolution_y = 1600, 900
    sc.view_settings.view_transform = 'Standard'
    if not sc.world:
        sc.world = bpy.data.worlds.new('World')
    sc.world.use_nodes = True
    sc.world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.5, 0.52, 0.55, 1)
    sc.world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.35
    # lay the instruments flat on a tray: +Y (Blender Z) axis along the tray's +Y
    layout = {'bronchoscope': (-0.42, -0.45), 'bougie': (-0.30, -0.36), 'chestDrain': (-0.20, -0.3), 'forcepsGauze': (-0.08, -0.2),
              'scalpel': (0.02, -0.15), 'syringe': (0.10, -0.12), 'needle14G': (0.18, -0.12), 'ivCannula': (0.25, -0.1),
              'tourniquet': (0.35, 0.05), 'defibPadRight': (0.30, -0.17), 'defibPadLeft': (0.47, -0.17)}
    for o in objs:
        x, y = layout[o.name]
        if o.name.startswith('defibPad') or o.name == 'tourniquet':
            o.rotation_euler = (0, 0, 0)
            o.location = (x, y, 0.0)
        else:
            o.rotation_euler = (-math.pi / 2, 0, 0)
            o.location = (x, y, 0.006)
    bpy.ops.mesh.primitive_plane_add(size=1.4, location=(0.03, 0.0, -0.001))
    tray = bpy.context.active_object
    tray.data.materials.append(mat('drape', (0.05, 0.16, 0.13), rough=0.9))
    for nm, loc, en, size in (('key', (0.5, -0.8, 1.6), 22, 1.2), ('fill', (-0.7, 0.6, 1.4), 9, 1.5)):
        L = bpy.data.objects.new(nm, bpy.data.lights.new(nm, 'AREA'))
        L.data.energy, L.data.size = en, size
        L.location = loc
        L.rotation_euler = (Vector((0.03, 0, 0)) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
        sc.collection.objects.link(L)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    cam.data.lens = 35
    cam.location = (0.03, -0.42, 1.45)
    cam.rotation_euler = (Vector((0.03, -0.04, 0)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    sc.collection.objects.link(cam)
    sc.camera = cam
    os.makedirs(os.path.dirname(RENDER), exist_ok=True)
    sc.render.filepath = RENDER
    bpy.ops.render.render(write_still=True)
    print('[instruments] render', RENDER, flush=True)


if __name__ == '__main__':
    main()
