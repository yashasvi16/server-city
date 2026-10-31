"""Builds the Living Server City island in Blender, then renders, bakes or exports it.

Usage (Blender as a Python module, `pip install bpy`):
    python build_city.py preview OUT.png [CAMERA]     # Cycles preview render
    python build_city.py bake OUT_DIR [--quick]         # bake lightmaps + export city.glb
    python build_city.py blend OUT.blend                 # save the scene for hand editing

Inputs:
    scene.json   written by `npm run export-scene` (map, landmarks, station tracks)
    ../../frontend/... nothing else: Kenney models come from KENNEY_DIR (CC0)

Approach (learned from Bruno Simon's my-room-in-3d / folio-2025):
  * Every static object shares ONE palette texture (Kenney's colormap with our
    own colour cells packed into its unused half) via UV0, so the whole city
    is one material.
  * Lighting is baked in Cycles into lightmaps (UV1): a warm low sun, a
    purple-blue sky (so shadows are tinted, never grey), lit windows and
    street lamps. The browser multiplies palette x lightmap: film-quality
    light for the cost of a texture lookup.
  * Edges are bevelled before UV assignment so they catch light.
"""
import json
import math
import os
import random
import sys

import numpy as np
import bpy
import bmesh
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
KENNEY_DIR = os.environ.get('KENNEY_DIR', os.path.join(HERE, 'kenney'))
SCENE = json.load(open(os.path.join(HERE, 'scene.json')))
RNG = random.Random(16)
T = SCENE['tile']


def B(x, z, y=0.0):
    """three.js (x, y, z) -> Blender (x, -z, y)."""
    return Vector((x, -z, y))


# ─────────────────────────────────────────────────────────────────────────────
# Palette atlas: Kenney colormap + our cells in its unused top half
# ─────────────────────────────────────────────────────────────────────────────
CELL = 32
OURS = {
    # name: (hex, emissive)
    'grass': ('#5fbf86', False), 'grass_dark': ('#3f9a73', False), 'dirt': ('#9a6a52', False),
    'rock_top': ('#7a5468', False), 'rock_mid': ('#583d5e', False), 'rock_deep': ('#352848', False), 'rock_dark': ('#241c34', False),
    'concrete': ('#c9c3d9', False), 'concrete_mid': ('#9d97b8', False), 'concrete_dark': ('#6b6688', False),
    'metal_dark': ('#3a3654', False), 'steel': ('#9aa2d4', False), 'gravel': ('#4c4764', False), 'sleeper': ('#6a4f4a', False),
    'rail': ('#c8cce8', False), 'glass': ('#a8dcff', False), 'brick': ('#c4604f', False), 'brick_dark': ('#93463d', False),
    'wood': ('#8a5638', False), 'wood_dark': ('#5e3a2a', False), 'felt': ('#1f9a68', False), 'copper': ('#d08454', False),
    'gold': ('#e9b24c', False), 'white': ('#f4efe6', False), 'navy': ('#2f3266', False), 'paving': ('#bdb2cc', False),
    'teal': ('#3fbfa8', False), 'redis': ('#e0483e', False), 'purple': ('#7b5fc7', False), 'pink': ('#ff7aa8', False),
    'roof_red': ('#b4463e', False), 'roof_dark': ('#4a3a5a', False), 'tree': ('#2f8a6a', False), 'tree_dark': ('#226a58', False),
    'trunk': ('#5a3a30', False), 'water': ('#3a6ad0', False), 'sand': ('#e6c49a', False),
    # emissive (bake as light sources, glow + bloom at runtime)
    'win_warm': ('#ffc27a', True), 'win_cool': ('#a8c4ff', True), 'win_dim': ('#e09a5a', True), 'win_off': ('#2b2f4a', False),
    'neon_amber': ('#ffa63d', True), 'neon_teal': ('#5ff2d3', True), 'neon_red': ('#ff4d5e', True),
    'neon_pink': ('#ff4fa3', True), 'neon_white': ('#fff3df', True), 'neon_blue': ('#6e8bff', True), 'lamp': ('#ffe2b0', True),
}


def hex_rgb(h):
    h = h.lstrip('#')
    return [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]


class Palette:
    """Our cells occupy rows 384..511 (v 0.75..1) of the 512px colormap."""

    def __init__(self):
        src = bpy.data.images.load(os.path.join(KENNEY_DIR, 'Textures', 'colormap.png'))
        W, H = src.size
        px = np.array(src.pixels[:], dtype=np.float32).reshape(H, W, 4)
        mask = np.zeros_like(px)
        mask[..., 3] = 1
        self.cells = {}
        for i, (name, (hx, emit)) in enumerate(OURS.items()):
            cx, cy = i % 16, 12 + i // 16  # rows 12..15 of 32px cells
            assert cy < 16, 'palette full'
            c = hex_rgb(hx)
            px[cy * CELL:(cy + 1) * CELL, cx * CELL:(cx + 1) * CELL, :3] = c
            px[cy * CELL:(cy + 1) * CELL, cx * CELL:(cx + 1) * CELL, 3] = 1
            if emit:
                mask[cy * CELL:(cy + 1) * CELL, cx * CELL:(cx + 1) * CELL, :3] = 1
            self.cells[name] = ((cx + 0.5) * CELL / W, (cy + 0.5) * CELL / H)
        self.image = bpy.data.images.new('palette', W, H, alpha=True)
        self.image.pixels[:] = px.ravel()
        self.mask = bpy.data.images.new('emissive', W, H, alpha=True)
        self.mask.pixels[:] = mask.ravel()
        self.mask.colorspace_settings.name = 'Non-Color'
        self.src_px = px
        self.size = (W, H)

    def color_at(self, u, v):
        W, H = self.size
        x = min(W - 1, max(0, int(u * W)))
        y = min(H - 1, max(0, int(v * H)))
        return self.src_px[y, x, :3]

    def save(self, out_dir):
        for img, name in ((self.image, 'palette.png'), (self.mask, 'emissive.png')):
            img.filepath_raw = os.path.join(out_dir, name)
            img.file_format = 'PNG'
            img.save()


PAL: Palette = None  # type: ignore
MASTER: bpy.types.Material = None  # type: ignore
EMIT_STRENGTH = 4.0


def master_material():
    m = bpy.data.materials.new('city')
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    uv = nt.nodes.new('ShaderNodeUVMap')
    uv.uv_map = 'UVMap'
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = PAL.image
    tex.interpolation = 'Closest'
    emask = nt.nodes.new('ShaderNodeTexImage')
    emask.image = PAL.mask
    emask.interpolation = 'Closest'
    nt.links.new(uv.outputs['UV'], tex.inputs['Vector'])
    nt.links.new(uv.outputs['UV'], emask.inputs['Vector'])
    diff = nt.nodes.new('ShaderNodeBsdfDiffuse')
    nt.links.new(tex.outputs['Color'], diff.inputs['Color'])
    emit = nt.nodes.new('ShaderNodeEmission')
    mul = nt.nodes.new('ShaderNodeMath')
    mul.operation = 'MULTIPLY'
    mul.inputs[1].default_value = EMIT_STRENGTH
    nt.links.new(emask.outputs['Color'], mul.inputs[0])
    nt.links.new(tex.outputs['Color'], emit.inputs['Color'])
    nt.links.new(mul.outputs[0], emit.inputs['Strength'])
    add = nt.nodes.new('ShaderNodeAddShader')
    nt.links.new(diff.outputs[0], add.inputs[0])
    nt.links.new(emit.outputs[0], add.inputs[1])
    nt.links.new(add.outputs[0], out.inputs['Surface'])
    m['bake_tex_node'] = nt.nodes.new('ShaderNodeTexImage').name
    return m


# ─────────────────────────────────────────────────────────────────────────────
# Mesh helpers: build with named palette slots, bevel, then flatten to UV0
# ─────────────────────────────────────────────────────────────────────────────
COLL: dict = {}


def coll(name):
    if name not in COLL:
        c = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(c)
        COLL[name] = c
    return COLL[name]


def slot_mat(name):
    m = bpy.data.materials.get('pal:' + name)
    if m is None:
        assert name in PAL.cells, name
        m = bpy.data.materials.new('pal:' + name)
    return m


def new_obj(name, bm, group, cell, bevel=0.0, segs=2, smooth=False):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    coll(group).objects.link(o)
    o.data.materials.append(slot_mat(cell))
    if bevel > 0:
        mod = o.modifiers.new('bevel', 'BEVEL')
        mod.width = bevel
        mod.segments = segs
        mod.limit_method = 'ANGLE'
        mod.angle_limit = math.radians(35)
        mod.harden_normals = False
    o['smooth'] = smooth
    return o


def box(name, group, cell, size, at, rot_z=0.0, bevel=0.06, segs=2):
    """size=(w, h, d) in three units (x, y, z), at = three (x, y_bottom, z)."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    w, h, d = size
    bmesh.ops.scale(bm, vec=Vector((w, d, h)), verts=bm.verts)
    bmesh.ops.translate(bm, vec=Vector((0, 0, h / 2)), verts=bm.verts)
    o = new_obj(name, bm, group, cell, bevel=min(bevel, w * 0.3, h * 0.3, d * 0.3), segs=segs)
    o.location = B(at[0], at[2], at[1])
    o.rotation_euler.z = rot_z
    return o


def cyl(name, group, cell, r, h, at, verts=24, r2=None, bevel=0.05, segs=2, cap=True):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=cap, segments=verts, radius1=r, radius2=r if r2 is None else r2, depth=h)
    bmesh.ops.translate(bm, vec=Vector((0, 0, h / 2)), verts=bm.verts)
    o = new_obj(name, bm, group, cell, bevel=bevel, segs=segs)
    o.location = B(at[0], at[2], at[1])
    return o


def torus(name, group, cell, R, r, at, maj=48, mn=8, rot=(0, 0, 0)):
    bm = bmesh.new()
    # build torus manually (bmesh has no torus op)
    rings = []
    for i in range(maj):
        a = 2 * math.pi * i / maj
        ring = []
        for j in range(mn):
            b = 2 * math.pi * j / mn
            x = (R + r * math.cos(b)) * math.cos(a)
            y = (R + r * math.cos(b)) * math.sin(a)
            z = r * math.sin(b)
            ring.append(bm.verts.new((x, y, z)))
        rings.append(ring)
    for i in range(maj):
        for j in range(mn):
            a, b2 = rings[i], rings[(i + 1) % maj]
            bm.faces.new((a[j], b2[j], b2[(j + 1) % mn], a[(j + 1) % mn]))
    o = new_obj(name, bm, group, cell)
    o.location = B(at[0], at[2], at[1])
    o.rotation_euler = rot
    return o


def set_cell(o, cell):
    """Paint the whole object with one cell (replaces slots)."""
    o.data.materials.clear()
    o.data.materials.append(slot_mat(cell))


def paint_faces(o, pred_cell):
    """pred_cell(face_center_world, normal_world) -> cell name or None."""
    me = o.data
    names = [m.name[4:] for m in me.materials]
    for p in me.polygons:
        c = pred_cell(o.matrix_world @ p.center, (o.matrix_world.to_3x3() @ p.normal).normalized())
        if c:
            if c not in names:
                me.materials.append(slot_mat(c))
                names.append(c)
            p.material_index = names.index(c)


def finalize_all():
    """Apply modifiers + transforms, convert palette slots to UV0, single material."""
    dg = bpy.context.evaluated_depsgraph_get()
    for o in list(bpy.data.objects):
        if o.type != 'MESH' or o.get('kenney'):
            continue
        if o.modifiers:
            ev = o.evaluated_get(dg)
            me = bpy.data.meshes.new_from_object(ev)
            old = o.data
            o.modifiers.clear()
            o.data = me
            if old.users == 0:
                bpy.data.meshes.remove(old)
        me = o.data
        if not me.uv_layers:
            me.uv_layers.new(name='UVMap')
        uvl = me.uv_layers[0]
        uvl.name = 'UVMap'
        cells = [PAL.cells[m.name[4:]] for m in me.materials]
        uvs = np.zeros((len(me.loops), 2), dtype=np.float32)
        mi = np.zeros(len(me.polygons), dtype=np.int32)
        me.polygons.foreach_get('material_index', mi)
        starts = np.zeros(len(me.polygons), dtype=np.int32)
        totals = np.zeros(len(me.polygons), dtype=np.int32)
        me.polygons.foreach_get('loop_start', starts)
        me.polygons.foreach_get('loop_total', totals)
        cell_arr = np.array(cells, dtype=np.float32)
        loop_mi = np.repeat(mi, totals)
        uvs[:] = cell_arr[loop_mi]
        uvl.data.foreach_set('uv', uvs.ravel())
        me.materials.clear()
        me.materials.append(MASTER)
        for p in me.polygons:
            p.use_smooth = bool(o.get('smooth'))


# ─────────────────────────────────────────────────────────────────────────────
# Kenney tiles
# ─────────────────────────────────────────────────────────────────────────────
PROTOS: dict = {}


def kenney_proto(name):
    if name in PROTOS:
        return PROTOS[name]
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(KENNEY_DIR, name + '.glb'))
    new = [o for o in bpy.data.objects if o not in before and o.type == 'MESH']
    for o in bpy.data.objects:
        if o not in before and o.type != 'MESH':
            bpy.data.objects.remove(o)
    o = new[0]
    for c in o.users_collection:
        c.objects.unlink(o)
    me = o.data
    me.transform(o.matrix_world)
    me.transform(Matrix.Scale(T, 4))
    bpy.data.objects.remove(o)
    me.name = 'proto:' + name
    me.uv_layers[0].name = 'UVMap'
    me.materials.clear()
    me.materials.append(MASTER)
    PROTOS[name] = me
    return me


WINDOW_CELLS = ['win_warm'] * 9 + ['win_cool'] * 3 + ['win_dim'] * 2 + ['win_off'] * 7


def kenney_place(name, x, z, rot_k, group, windows=False):
    """Place a Kenney tile centred on three (x, z), rotated rot_k * 90deg CCW."""
    proto = kenney_proto(name)
    me = proto.copy()
    o = bpy.data.objects.new(name, me)
    o['kenney'] = True
    coll(group).objects.link(o)
    o.location = B(x, z)
    o.rotation_euler.z = rot_k * math.pi / 2
    if windows:
        # Dark vertical window panes -> lit / dark window cells, per window.
        uvl = me.uv_layers[0].data
        for p in me.polygons:
            if abs(p.normal.z) > 0.3:
                continue
            u = sum(uvl[l].uv[0] for l in p.loop_indices) / p.loop_total
            v = sum(uvl[l].uv[1] for l in p.loop_indices) / p.loop_total
            if PAL.color_at(u, v).max() < 0.28 and p.area < 0.9 * T * T * 0.1:
                cu, cv = PAL.cells[RNG.choice(WINDOW_CELLS)]
                for l in p.loop_indices:
                    uvl[l].uv = (cu, cv)
    return o


# Road connectivity in Blender directions: N=+Y (three -z), E=+X, S=-Y, W=-X
ROT = {'N': 'W', 'W': 'S', 'S': 'E', 'E': 'N'}  # one 90deg CCW turn
BASE = {
    'road-straight': {'N', 'S'},
    'road-corner': {'S', 'W'},
    'road-split': {'W', 'E', 'S'},
    'road-intersection': {'N', 'S', 'E', 'W'},
}


def road_tile(dirs):
    if len(dirs) == 1:
        dirs = dirs | {({'N': 'S', 'S': 'N', 'E': 'W', 'W': 'E'})[next(iter(dirs))]}
    for name, base in BASE.items():
        if len(base) != len(dirs):
            continue
        s = set(base)
        for k in range(4):
            if s == dirs:
                return name, k
            s = {ROT[d] for d in s}
    return 'road-straight', 0


# ─────────────────────────────────────────────────────────────────────────────
# Island
# ─────────────────────────────────────────────────────────────────────────────
RX, RZ = SCENE['island']['rx'], SCENE['island']['rz']


def island_r(th):
    return 1 + 0.04 * math.sin(3 * th + 0.7) + 0.022 * math.sin(5 * th + 2.1) + 0.006 * math.sin(11 * th)


def inside(x, z, margin=0.0):
    th = math.atan2(-z / RZ, x / RX)
    return math.hypot(x / RX, z / RZ) < island_r(th) - margin / RX


def outline(scale=1.0, n=160, jitter=0.0, seed=1):
    r = random.Random(seed)
    pts = []
    for i in range(n):
        th = 2 * math.pi * i / n
        s = island_r(th) * scale * (1 + (r.random() - 0.5) * jitter)
        pts.append((math.cos(th) * RX * s, math.sin(th) * RZ * s))  # Blender (x, y)
    return pts


def build_island():
    # Ground: a fine grid clipped to the outline (lightmap gets planar UVs).
    bm = bmesh.new()
    pts = outline()
    verts = [bm.verts.new((x, y, -0.08)) for x, y in pts]  # just below the tiles: no z-fighting
    bm.faces.new(verts)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    o = new_obj('ground', bm, 'ground', 'grass')
    o['lm'] = 'ground'

    # Cliff: lip, then strata rings narrowing into a keel, flat shaded.
    rnd = random.Random(7)
    rings = []
    profile = [  # (scale, depth, cell for band below this ring)
        (1.0, 0.0, 'grass'), (1.006, -0.7, 'dirt'), (0.985, -2.4, 'rock_top'), (0.95, -5.0, 'rock_top'),
        (0.9, -8.5, 'rock_mid'), (0.8, -13.0, 'rock_mid'), (0.66, -18.5, 'rock_deep'), (0.5, -24.5, 'rock_deep'),
        (0.33, -30.0, 'rock_dark'), (0.18, -35.0, 'rock_dark'), (0.07, -39.0, 'rock_dark'),
    ]
    N = 160
    bm = bmesh.new()
    for k, (s, d, _) in enumerate(profile):
        jit = 0 if k < 2 else 0.12
        ring = []
        for i, (x, y) in enumerate(outline(s, N, jit, seed=100 + k)):
            dz = 0 if k < 2 else (rnd.random() - 0.5) * 1.6
            ring.append(bm.verts.new((x, y, d + dz)))
        rings.append(ring)
    tip = bm.verts.new((3, 2, -44))
    face_cells = []
    for k in range(len(rings) - 1):
        a, b = rings[k], rings[k + 1]
        for i in range(N):
            j = (i + 1) % N
            f = bm.faces.new((a[i], a[j], b[j], b[i]))
            face_cells.append(profile[k + 1][2])
    for i in range(N):
        bm.faces.new((rings[-1][i], rings[-1][(i + 1) % N], tip))
        face_cells.append('rock_dark')
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    cliff = new_obj('cliff', bm, 'nature', 'rock_top')
    names = []
    for c in face_cells:
        if c not in names:
            names.append(c)
    cliff.data.materials.clear()
    for c in names:
        cliff.data.materials.append(slot_mat(c))
    for p, c in zip(cliff.data.polygons, face_cells):
        p.material_index = names.index(c)
    p0 = cliff.data.polygons[0]
    if p0.normal.dot(Vector((p0.center.x, p0.center.y, 0))) < 0:  # make normals face outward
        cliff.data.flip_normals()

    # Floating islets around the keel: flat grassy top, rocky cone below.
    for i in range(11):
        th = rnd.random() * 2 * math.pi
        rr = 1.12 + rnd.random() * 0.35
        size = 1.6 + rnd.random() * 3.2
        bm = bmesh.new()
        n = 9
        top = [bm.verts.new((math.cos(a) * size * (0.85 + rnd.random() * 0.3), math.sin(a) * size * (0.85 + rnd.random() * 0.3), 0))
               for a in (k / n * 2 * math.pi for k in range(n))]
        mid = [bm.verts.new((v.co.x * 0.7, v.co.y * 0.7, -size * (0.5 + rnd.random() * 0.3))) for v in top]
        tipv = bm.verts.new(((rnd.random() - 0.5) * size * 0.4, (rnd.random() - 0.5) * size * 0.4, -size * 2.0))
        bm.faces.new(top)
        for k in range(n):
            j = (k + 1) % n
            bm.faces.new((top[j], top[k], mid[k], mid[j]))
            bm.faces.new((mid[j], mid[k], tipv))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        loc = (math.cos(th) * RX * rr, math.sin(th) * RZ * rr, -6 - rnd.random() * 22)
        rot = rnd.random() * 6
        if near_deck(loc[0], -loc[1], 8) or near_bridge(loc[0], -loc[1], 6):
            bm.free()
            continue
        o = new_obj(f'shard{i}', bm, 'nature', 'rock_mid')
        paint_faces(o, lambda c, nn, s=size: 'grass' if nn.z > 0.7 else ('rock_top' if c.z > -s * 0.45 else None))
        o.location = loc
        o.rotation_euler = (0, 0, rot)


# ─────────────────────────────────────────────────────────────────────────────
# City grid: roads, districts, filler buildings and parks
# ─────────────────────────────────────────────────────────────────────────────
def on_road(x, z):
    for r in SCENE['roads']:
        (ax, az), (bx, bz) = r['a'], r['b']
        if ax == bx == x and min(az, bz) <= z <= max(az, bz):
            return True
        if az == bz == z and min(ax, bx) <= x <= max(ax, bx):
            return True
    return False


def in_spot(x, z, pad=0.0):
    for k, s in SCENE['spots'].items():
        a, b, c, d = s['rect']
        if a - pad <= x <= c + pad and b - pad <= z <= d + pad:
            return k
    return None


LAMPS = []  # three (x, z) of street lamps (also exported for the runtime)


def build_city():
    cells = {}
    for i in range(-11, 12):
        for j in range(-11, 12):
            x, z = i * T, j * T
            corners_in = all(inside(x + dx, z + dz, 1.0) for dx in (-3, 3) for dz in (-3, 3))
            if not corners_in:
                continue
            if on_road(x, z):
                cells[(i, j)] = 'road'
            elif in_spot(x, z, 1.0):
                cells[(i, j)] = 'spot:' + in_spot(x, z, 1.0)
            else:
                cells[(i, j)] = 'filler'
    # Roads
    dirmap = {'N': (0, -1), 'S': (0, 1), 'E': (1, 0), 'W': (-1, 0)}  # three (di, dj)
    for (i, j), kind in cells.items():
        if kind != 'road':
            continue
        dirs = {d for d, (di, dj) in dirmap.items() if cells.get((i + di, j + dj)) == 'road'}
        name, k = road_tile(dirs)
        kenney_place(name, i * T, j * T, k, 'ground')
        if name == 'road-straight' and (i + j) % 2 == 0:
            vertical = dirs <= {'N', 'S'}
            for side in (-1, 1):
                off = 2.65 * side
                LAMPS.append((i * T + off, j * T) if vertical else (i * T, j * T + off))
    # Districts get paving; filler becomes buildings near roads, parks elsewhere.
    for (i, j), kind in cells.items():
        x, z = i * T, j * T
        if kind.startswith('spot:'):
            if kind == 'spot:station':
                continue  # the rail yard has its own gravel bed
            kenney_place('pavement', x, z, RNG.randrange(4), 'ground')
        elif kind == 'filler':
            road_dirs = [d for d, (di, dj) in dirmap.items() if cells.get((i + di, j + dj)) == 'road']
            if road_dirs and RNG.random() < 0.92:
                face = road_dirs[0]
                # building front faces Blender -Y (three +z, 'S'); rotate to face the road
                k = {'S': 0, 'E': 1, 'N': 2, 'W': 3}[face]
                bname = RNG.choice(['building-small-a', 'building-small-b', 'building-small-c', 'building-small-c', 'building-small-d', 'building-small-b', 'building-garage'])
                kenney_place(bname, x, z, k, 'buildings', windows=True)
            else:
                r = RNG.random()
                pname = 'grass-trees-tall' if r < 0.4 else 'grass-trees' if r < 0.75 else 'pavement-fountain' if r < 0.8 else 'grass'
                kenney_place(pname, x, z, RNG.randrange(4), 'ground')
    return cells


def build_lamps():
    for n, (x, z) in enumerate(LAMPS):
        g = 'props'
        cyl(f'lamp_post{n}', g, 'metal_dark', 0.08, 3.1, (x, 0.3, z), verts=8, bevel=0.0)
        o = box(f'lamp_head{n}', g, 'metal_dark', (0.5, 0.16, 0.5), (x, 3.3, z), bevel=0.05)
        b = box(f'lamp_bulb{n}', g, 'lamp', (0.36, 0.06, 0.36), (x, 3.25, z), bevel=0.0)
        light = bpy.data.lights.new(f'lampL{n}', 'POINT')
        light.energy = 140
        light.color = (1.0, 0.72, 0.42)
        light.shadow_soft_size = 0.25
        lo = bpy.data.objects.new(f'lampL{n}', light)
        coll('lights').objects.link(lo)
        lo.location = B(x, z, 3.0)


def build_rim_trees():
    """Trees and rocks on the organic grass margin outside the tile grid."""
    rnd = random.Random(23)
    placed = []
    n = 0
    for _ in range(2600):
        x = (rnd.random() * 2 - 1) * RX
        z = (rnd.random() * 2 - 1) * RZ
        if not inside(x, z, 1.4):
            continue
        # outside the tile grid?
        i, j = round(x / T), round(z / T)
        cx, cz = i * T, j * T
        in_grid = abs(x - cx) <= 3 and abs(z - cz) <= 3 and all(inside(cx + dx, cz + dz, 1.0) for dx in (-3, 3) for dz in (-3, 3))
        if in_grid:
            continue
        if any((px - x) ** 2 + (pz - z) ** 2 < 2.2 ** 2 for px, pz in placed):
            continue
        if near_bridge(x, z, 2.5):
            continue
        placed.append((x, z))
        s = 0.8 + rnd.random() * 0.7
        if rnd.random() < 0.82:
            tree(f'tree{n}', x, z, s, rnd)
        else:
            bm = bmesh.new()
            bmesh.ops.create_icosphere(bm, subdivisions=1, radius=0.7 * s)
            for v in bm.verts:
                v.co.z *= 0.6
            o = new_obj(f'rock{n}', bm, 'nature', 'rock_top')
            o.location = B(x, z, 0.15)
            o.rotation_euler.z = rnd.random() * 6
        n += 1


def tree(name, x, z, s, rnd, g='nature'):
    cyl(name + 't', g, 'trunk', 0.18 * s, 0.9 * s, (x, 0, z), verts=6, bevel=0)
    cell = 'tree' if rnd.random() < 0.6 else 'tree_dark'
    for k, (r, h, y) in enumerate(((1.25, 1.9, 0.7), (0.95, 1.6, 1.6), (0.6, 1.3, 2.45))):
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, segments=7, radius1=r * s, radius2=0.05, depth=h * s)
        bmesh.ops.translate(bm, vec=Vector((0, 0, h * s / 2)), verts=bm.verts)
        o = new_obj(f'{name}c{k}', bm, g, cell)
        o.location = B(x, z, y * s)
        o.rotation_euler.z = rnd.random() * 6


# ─────────────────────────────────────────────────────────────────────────────
# Landmarks (static parts only; moving parts live in the runtime)
# ─────────────────────────────────────────────────────────────────────────────
def fillet(points, radius=1.8, step=0.35):
    """Polyline with rounded corners -> dense list of three (x, z)."""
    P = [Vector((p[0], p[1])) for p in points]
    out = [P[0]]
    for i in range(1, len(P) - 1):
        a, b, c = P[i - 1], P[i], P[i + 1]
        din, dout = (b - a).normalized(), (c - b).normalized()
        r = min(radius, (b - a).length / 2, (c - b).length / 2)
        p1, p2 = b - din * r, b + dout * r
        out.append(p1)
        for k in range(1, 8):
            t = k / 8
            out.append((1 - t) ** 2 * p1 + 2 * (1 - t) * t * b + t * t * p2)
        out.append(p2)
    out.append(P[-1])
    dense = [out[0]]
    for q in out[1:]:
        start = dense[-1]
        n = max(1, int((q - start).length / step))
        for k in range(1, n + 1):
            dense.append(start.lerp(q, k / n))
    return dense


YARD_TOP = 0.42


def track(name, pts):
    """Sleepers + two rails + powered centre strip, baked into the city."""
    dense = fillet(pts)
    bm_s = bmesh.new()
    bm_r = bmesh.new()
    bm_c = bmesh.new()
    prev = None
    for k, p in enumerate(dense):
        q = dense[min(k + 1, len(dense) - 1)] if k < len(dense) - 1 else p + (p - dense[k - 1])
        t = (q - p).normalized() if (q - p).length > 1e-6 else Vector((1, 0))
        side = Vector((-t.y, t.x))
        cur = []
        for off, bmx, h in ((-0.62, bm_r, 0.2), (-0.5, bm_r, 0.2), (0.5, bm_r, 0.2), (0.62, bm_r, 0.2), (-0.1, bm_c, 0.15), (0.1, bm_c, 0.15)):
            v = p + side * off
            cur.append(bmx.verts.new(B(v.x, v.y, YARD_TOP + h)))
        if prev:
            for (a, b2, bmx) in ((0, 1, bm_r), (2, 3, bm_r), (4, 5, bm_c)):
                bmx.faces.new((prev[a], prev[b2], cur[b2], cur[a]))
        prev = cur
        if k % 2 == 0:
            ang = math.atan2(t.y, t.x)
            vs = bmesh.ops.create_cube(bm_s, size=1.0)['verts']
            bmesh.ops.scale(bm_s, vec=Vector((0.3, 1.6, 0.12)), verts=vs)
            bmesh.ops.rotate(bm_s, cent=Vector((0, 0, 0)), matrix=Matrix.Rotation(-ang, 3, 'Z'), verts=vs)
            bmesh.ops.translate(bm_s, vec=B(p.x, p.y, YARD_TOP + 0.06), verts=vs)
    new_obj(name + '_sleepers', bm_s, 'station', 'sleeper')
    new_obj(name + '_rails', bm_r, 'station', 'rail')
    new_obj(name + '_strip', bm_c, 'station', 'neon_amber')


def build_station():
    g = 'station'
    N = SCENE['stationNodes']
    a, b, c, d = SCENE['spots']['station']['rect']
    # gravel bed with a concrete kerb
    box('yard_kerb', g, 'concrete_mid', (c - a + 1.2, 0.3, d - b + 1.2), ((a + c) / 2, 0, (b + d) / 2), bevel=0.12)
    box('yard_bed', g, 'gravel', (c - a, 0.12, d - b), ((a + c) / 2, 0.3, (b + d) / 2), bevel=0.0)
    seen = set()
    for i, t in enumerate(SCENE['tracks']):
        key = tuple(sorted((t['from'], t['to'])))
        if key in seen:
            continue
        seen.add(key)
        track(f'track{i}', t['points'])
    track('spur', SCENE['spur'])
    y0 = 0.42
    # floodlight posts at the yard corners
    for k, (fx, fz) in enumerate(((a + 0.8, b + 0.8), (c - 0.8, b + 0.8), (a + 0.8, d - 0.8), (c - 0.8, d - 0.8))):
        cyl(f'yard_post{k}', g, 'metal_dark', 0.12, 6.0, (fx, y0, fz), verts=8, bevel=0)
        box(f'yard_head{k}', g, 'lamp', (0.9, 0.3, 0.5), (fx, y0 + 6.0, fz), bevel=0.04)
        light = bpy.data.lights.new(f'yardL{k}', 'POINT')
        light.energy = 900
        light.color = (1.0, 0.78, 0.55)
        light.shadow_soft_size = 0.4
        lo = bpy.data.objects.new(f'yardL{k}', light)
        coll('lights').objects.link(lo)
        lo.location = B(fx + (1.2 if fx < 0 else -1.2), fz + (1.2 if fz < 0 else -1.2), y0 + 5.6)

    # Container stacks in the free south-east corner of the yard
    crng = random.Random(11)
    cols_c = ['redis', 'teal', 'navy', 'copper', 'purple', 'gold']
    for row in range(2):
        for k in range(4):
            for lvl in range(crng.choice((1, 1, 2, 2, 3))):
                cx_, cz_ = 7.5 + k * 3.3, 8.6 + row * 3.0
                box(f'cont{row}{k}{lvl}', g, crng.choice(cols_c), (3.0, 1.25, 2.5), (cx_, y0 + lvl * 1.25, cz_), rot_z=0, bevel=0.05)

    # Client: ticket kiosk with an awning
    x, z = N['client']
    box('kiosk', g, 'brick', (2.6, 2.4, 2.0), (x - 2.8, y0, z + 2.6))
    box('kiosk_win', g, 'win_warm', (1.7, 0.8, 0.08), (x - 2.8, y0 + 1.0, z + 3.6), bevel=0.02)
    box('kiosk_awning', g, 'neon_red', (3.0, 0.14, 1.0), (x - 2.8, y0 + 2.15, z + 3.9), bevel=0.04)
    box('kiosk_roof', g, 'roof_dark', (2.9, 0.25, 2.3), (x - 2.8, y0 + 2.4, z + 2.6))

    # Broker: the station hall (barrel vault on columns, platform inside)
    x, z = N['broker']
    L, W, H = 11.0, 6.6, 3.4
    hx = x - 1.5
    box('hall_platform', g, 'paving', (L, 0.35, 1.4), (hx, y0, z - W / 2 + 0.9))
    for i in range(6):
        for s in (-1, 1):
            box(f'hall_col{i}{s}', g, 'steel', (0.34, H, 0.34), (hx - L / 2 + i * L / 5, y0, z + s * W / 2), bevel=0.05)
    for i in range(6):
        torus(f'hall_rib{i}', g, 'steel', W / 2, 0.11, (hx - L / 2 + i * L / 5, y0 + H, z), maj=32, mn=6, rot=(0, math.pi / 2, 0))
    # vault panels: half-cylinder of frosted glass
    bm = bmesh.new()
    seg = 16
    for k in range(seg):
        a0, a1 = math.pi * k / seg, math.pi * (k + 1) / seg
        vs = []
        for (xx, aa) in ((-L / 2, a0), (L / 2, a0), (L / 2, a1), (-L / 2, a1)):
            vs.append(bm.verts.new((xx, math.cos(aa) * W / 2 * 0.98, math.sin(aa) * W / 2 * 0.98)))
        bm.faces.new(vs)
    o = new_obj('hall_glass', bm, g, 'glass')
    o.location = B(hx, z, y0 + H)
    box('hall_sign', g, 'neon_amber', (4.6, 0.7, 0.14), (hx, y0 + H + W / 2 + 0.35, z + 0.2), bevel=0.04)

    # Dispatcher: signal tower (lamps are runtime)
    x, z = N['dispatcher']
    box('signal_tower', g, 'concrete_dark', (1.3, 8.2, 1.3), (x - 3, y0, z + 2.5))
    box('signal_cap', g, 'steel', (1.9, 0.3, 1.9), (x - 3, y0 + 8.2, z + 2.5))
    box('signal_board', g, 'metal_dark', (1.0, 2.6, 0.3), (x - 3, y0 + 5.3, z + 3.25))

    # Worker pool: four sheds (fans are runtime)
    x, z = N['pool']
    for i in range(4):
        sx = x - 3.9 + i * 2.6
        box(f'shed{i}', g, 'brick' if i % 2 else 'brick_dark', (2.2, 2.2, 2.4), (sx, y0, -4 + (z - 2)), bevel=0.1)
        box(f'shed_roof{i}', g, 'roof_dark', (2.4, 0.18, 2.6), (sx, y0 + 2.2, -4 + (z - 2)), bevel=0.06)
        box(f'shed_win{i}', g, 'win_warm', (1.2, 0.6, 0.06), (sx, y0 + 0.9, -4 + (z - 2) + 1.22), bevel=0.0)

    # Middleware: four gantries the train passes under
    x, z = N['middleware']
    cols = ['neon_blue', 'neon_teal', 'neon_amber', 'neon_white']
    for i, cname in enumerate(cols):
        gx = x - 6.5 + i * 1.7
        for s in (-1, 1):
            box(f'gantry{i}{s}', g, 'steel', (0.18, 2.6, 0.18), (gx, y0, z + s * 1.05), bevel=0.03)
        box(f'gantry_beam{i}', g, cname, (0.22, 0.24, 2.4), (gx, y0 + 2.6, z), bevel=0.03)

    # Handler: sawtooth factory with a chimney
    x, z = N['handler']
    fx, fz = x + 4.6, z + 4.0
    box('factory', g, 'brick', (4.4, 2.8, 4.8), (fx, y0, fz))
    for i in range(3):
        bm = bmesh.new()
        v = [bm.verts.new(p) for p in ((-2.2, -0.0, 0), (2.2, 0, 0), (2.2, 0, 1.1), (-2.2, 0, 1.1))]
        v2 = [bm.verts.new(p) for p in ((-2.2, -1.5, 0), (2.2, -1.5, 0))]
        bm.faces.new((v[0], v[1], v[2], v[3]))
        bm.faces.new((v2[0], v2[1], v[2], v[3]))
        bm.faces.new((v[0], v2[0], v[3]))
        bm.faces.new((v[1], v[2], v2[1]))
        bm.faces.new((v2[0], v2[1], v[1], v[0]))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        o = new_obj(f'saw{i}', bm, g, 'roof_dark')
        o.location = B(fx, fz - 2.4 + i * 1.6 + 1.5, y0 + 2.8)
        paint_faces(o, lambda cc, n: 'glass' if n.y > 0.5 and n.z < 0.5 else None)
    cyl('chimney', g, 'brick_dark', 0.36, 5.0, (fx + 1.4, y0, fz + 1.6), verts=12)
    cyl('chimney_top', g, 'neon_amber', 0.4, 0.18, (fx + 1.4, y0 + 5.0, fz + 1.6), verts=12, bevel=0.02)

    # Acknowledge: platform with a teal light strip
    x, z = N['ack']
    box('ack_platform', g, 'paving', (6.6, 0.4, 1.4), (x, y0, z - 1.5))
    box('ack_strip', g, 'neon_teal', (6.4, 0.06, 0.14), (x, y0 + 0.4, z - 0.86), bevel=0.0)
    for s in (-1, 1):
        box(f'ack_post{s}', g, 'steel', (0.12, 2.4, 0.12), (x + s * 2.8, y0 + 0.4, z - 1.9), bevel=0.02)
    box('ack_canopy', g, 'roof_dark', (6.8, 0.12, 1.6), (x, y0 + 2.8, z - 1.6))

    # Retry set: a half-round roundhouse with doors facing the track
    x, z = N['retry']
    o = cyl('roundhouse', g, 'brick', 3.6, 2.8, (x, y0, z - 1.3), verts=24)
    o.rotation_euler.z = 0
    paint_faces(o, lambda cc, n: 'win_dim' if abs(n.z) < 0.2 and n.y < -0.6 and (cc.z - (y0 + 1.2)) ** 2 < 0.25 else None)
    cyl('roundhouse_roof', g, 'roof_dark', 3.9, 0.9, (x, y0 + 2.8, z - 1.3), verts=24, r2=2.4)

    # Scheduler: a clock tower (hands are runtime)
    x, z = N['scheduler']
    cx, cz = x - 3.2, z - 1.0
    box('clock_tower', g, 'concrete', (1.9, 7.8, 1.9), (cx, y0, cz))
    box('clock_band', g, 'concrete_dark', (2.1, 0.3, 2.1), (cx, y0 + 5.6, cz), bevel=0.04)
    cyl('clock_face', g, 'neon_white', 0.75, 0.08, (cx, y0 + 6.7, cz + 0.97), verts=24, bevel=0.0).rotation_euler.x = math.pi / 2
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=4, radius1=1.6, radius2=0.0, depth=2.0)
    bmesh.ops.translate(bm, vec=Vector((0, 0, 1.0)), verts=bm.verts)
    o = new_obj('clock_roof', bm, g, 'roof_red', bevel=0.03)
    o.location = B(cx, cz, y0 + 7.8)
    o.rotation_euler.z = math.pi / 4

    # Dead letters: a buffer stop at the end of the siding (lamp is runtime)
    x, z = N['dlq']
    box('buffer_stop', g, 'brick_dark', (0.6, 1.1, 1.8), (x + 1.3, y0, z), bevel=0.08)
    box('buffer_stripe', g, 'neon_red', (0.62, 0.18, 1.82), (x + 1.3, y0 + 0.75, z), bevel=0.02)


def build_vault():
    g = 'vault'
    y0 = 0.36
    vx, vz = -39, -1
    o = cyl('vault_drum', g, 'concrete_mid', 6.4, 5.4, (vx, y0, vz), verts=40, r2=6.1)
    paint_faces(o, lambda c, n: ('win_warm' if (int((math.atan2(n.y, n.x) + 7) * 4) % 3 == 0) else 'win_off')
                if abs(n.z) < 0.2 and 1.8 < c.z - y0 < 2.5 and n.y > -0.5 else None)
    cyl('vault_plinth', g, 'concrete_dark', 6.9, 0.5, (vx, y0, vz), verts=40)
    cyl('vault_cap', g, 'metal_dark', 6.2, 0.9, (vx, y0 + 5.4, vz), verts=40, r2=5.3)
    torus('vault_cap_ring', g, 'neon_amber', 6.15, 0.08, (vx, y0 + 5.38, vz), maj=64, mn=6)
    # door frame on the south face (door plate + wheel are runtime)
    torus('vault_frame', g, 'steel', 2.55, 0.32, (vx, y0 + 2.7, vz + 6.35), maj=48, mn=10, rot=(math.pi / 2, 0, 0))
    torus('vault_frame_glow', g, 'neon_amber', 2.95, 0.07, (vx, y0 + 2.7, vz + 6.3), maj=48, mn=6, rot=(math.pi / 2, 0, 0))
    for s in (-1, 1):
        box(f'vault_step{s}', g, 'concrete', (5.4, 0.3, 1.4), (vx, y0 + (0 if s < 0 else 0.3), vz + 6.9 + (0.0 if s < 0 else -0.5)))
    # Redis tower: slim cylinder, beacon on top (rings are runtime)
    tx, tz = -46, -9
    o = cyl('redis_tower', g, 'concrete_dark', 1.4, 16, (tx, y0, tz), verts=16, r2=1.15)
    paint_faces(o, lambda c, n: 'win_cool' if abs(n.z) < 0.2 and int((c.z - y0) / 1.2) % 2 == 1 and abs(n.x) < 0.8 else None)
    cyl('redis_base', g, 'redis', 2.2, 1.0, (tx, y0, tz), verts=16)
    cyl('redis_cap', g, 'metal_dark', 1.5, 0.5, (tx, y0 + 16, tz), verts=16)
    # API office with eight endpoint lamps and a roof mast
    ax, az = -32, 8
    o = box('api_office', g, 'navy', (5.4, 4.6, 4.2), (ax, y0, az), bevel=0.1)
    paint_faces(o, lambda c, n: ('win_cool' if int(c.x * 1.4) % 2 == 0 else 'win_warm') if n.y < -0.9 and 1.4 < c.z - y0 < 3.4 and abs(c.x - ax) < 2.2 else None)
    box('api_roof', g, 'concrete_dark', (5.8, 0.25, 4.6), (ax, y0 + 4.6, az))
    for i in range(8):
        box(f'api_lamp{i}', g, 'neon_teal', (0.34, 0.34, 0.08), (ax - 1.9 + i * 0.54, y0 + 3.9, az + 2.12), bevel=0.0)
    cyl('api_mast', g, 'steel', 0.07, 3.4, (ax + 1.6, y0 + 4.85, az - 1), verts=8, bevel=0)
    # Auth gate before the API
    gx, gz = -27.5, 12.5
    for s in (-1, 1):
        box(f'auth_post{s}', g, 'steel', (0.3, 2.7, 0.3), (gx + s * 1.25, y0, gz), bevel=0.04)
    box('auth_bar', g, 'neon_blue', (2.8, 0.22, 0.3), (gx, y0 + 2.7, gz), bevel=0.03)


def build_arena():
    g = 'arena'
    cx, cz = SCENE['spots']['arena']['anchor']
    y0 = 0.36
    # stadium bowl: lathed tiers
    prof = [(7.6, 0), (7.6, 0.8), (8.6, 1.2), (8.6, 1.5), (9.6, 2.2), (9.6, 2.5), (10.6, 3.2), (10.6, 3.5), (11.4, 3.9), (11.6, 3.9), (11.6, 0)]
    bm = bmesh.new()
    SEG = 64
    rings = [[bm.verts.new((r * math.cos(2 * math.pi * k / SEG), r * math.sin(2 * math.pi * k / SEG), h)) for k in range(SEG)] for r, h in prof]
    cellsf = []
    for i in range(len(prof) - 1):
        for k in range(SEG):
            j = (k + 1) % SEG
            bm.faces.new((rings[i][k], rings[i][j], rings[i + 1][j], rings[i + 1][k]))
            cellsf.append('concrete' if i % 2 == 0 else ('purple' if (k // 4) % 2 else 'pink'))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    o = new_obj('bowl', bm, g, 'concrete')
    names = []
    for c in cellsf:
        if c not in names:
            names.append(c)
    o.data.materials.clear()
    for c in names:
        o.data.materials.append(slot_mat(c))
    for p, c in zip(o.data.polygons, cellsf):
        p.material_index = names.index(c)
    o.location = B(cx, cz, y0)
    # outer wall with lit concourse windows
    o = cyl('bowl_wall', g, 'concrete_mid', 11.7, 3.9, (cx, y0, cz), verts=64, cap=False, bevel=0)
    paint_faces(o, lambda c, n: ('win_warm' if (int((math.atan2(n.y, n.x) + 7) * 6) % 2) else 'win_off') if 1.4 < c.z - y0 < 2.2 else None)
    torus('bowl_rim', g, 'neon_amber', 11.6, 0.1, (cx, y0 + 3.95, cz), maj=96, mn=6)
    # pitch
    cyl('pitch', g, 'teal', 7.6, 0.12, (cx, y0, cz), verts=64, bevel=0)
    torus('pitch_circle', g, 'neon_teal', 2.6, 0.06, (cx, y0 + 0.14, cz), maj=48, mn=4)
    box('pitch_line', g, 'neon_teal', (0.12, 0.04, 14.8), (cx, y0 + 0.12, cz), bevel=0)
    # floodlight masts
    for i in range(4):
        a = math.pi / 4 + i * math.pi / 2
        x, z = cx + math.cos(a) * 12.8, cz + math.sin(a) * 12.8
        box(f'flood{i}', g, 'metal_dark', (0.35, 9, 0.35), (x, y0, z), bevel=0.04)
        o = box(f'flood_head{i}', g, 'neon_white', (1.6, 0.8, 0.3), (x, y0 + 9, z), bevel=0.04)
        o.rotation_euler.z = -a + math.pi / 2
    # session registry, stat accumulator, database
    o = box('sessions', g, 'navy', (4.2, 3.4, 3.6), (-10.5, y0, -23.5), bevel=0.1)
    paint_faces(o, lambda c, n: 'win_cool' if n.y < -0.9 and 1.0 < c.z - y0 < 2.6 else None)
    o = box('accumulator', g, 'navy', (4.2, 3.8, 3.6), (10.5, y0, -23.5), bevel=0.1)
    paint_faces(o, lambda c, n: 'win_warm' if n.y < -0.9 and 1.0 < c.z - y0 < 3.0 else None)
    cyl('jet_db', g, 'concrete_mid', 1.9, 3.2, (14.5, y0, -31), verts=24)
    torus('jet_db_ring', g, 'neon_amber', 1.95, 0.07, (14.5, y0 + 3.0, -31), maj=40, mn=4)


def build_gateway():
    g = 'gateway'
    gx, gz = SCENE['gate']
    y0 = 0.36
    for s in (-1, 1):
        box(f'pylon{s}', g, 'metal_dark', (1.8, 9.5, 1.8), (gx + s * 5.4, y0, gz), bevel=0.14)
        for dz in (-0.96, 0.96):
            box(f'pylon_strip{s}{dz}', g, 'neon_amber', (0.12, 8.6, 0.06), (gx + s * 5.4, y0 + 0.4, gz + dz), bevel=0)
    box('lintel', g, 'navy', (13.2, 1.5, 2.3), (gx, y0 + 9.5, gz), bevel=0.14)
    box('lintel_glow', g, 'neon_amber', (12.4, 0.1, 0.1), (gx, y0 + 9.45, gz + 1.18), bevel=0)


def build_poolhall():
    g = 'poolhall'
    cx, cz = SCENE['spots']['poolhall']['anchor']
    y0 = 0.36
    o = box('pool_hall', g, 'brick', (15, 3.6, 9.5), (cx, y0, cz), bevel=0.12)
    paint_faces(o, lambda c, n: ('win_warm' if int(c.x * 0.8) % 3 else 'win_dim') if n.y < -0.9 and 1.0 < c.z - y0 < 2.6 and abs(c.x - cx) > 1.5 else None)
    box('pool_cornice', g, 'concrete', (15.4, 0.3, 9.9), (cx, y0 + 3.6, cz), bevel=0.06)
    box('pool_door', g, 'wood_dark', (2.2, 2.4, 0.1), (cx, y0, cz + 4.8), bevel=0.02)
    # roof table (balls/cue are runtime): rail + felt + pockets + lamp
    H = y0 + 3.9
    box('table_rail', g, 'wood', (9.0, 0.5, 5.2), (cx, H, cz), bevel=0.12)
    box('table_felt', g, 'felt', (8.0, 0.06, 4.2), (cx, H + 0.48, cz), bevel=0)
    for px, pz in ((-1, -1), (0, -1), (1, -1), (-1, 1), (0, 1), (1, 1)):
        cyl(f'pocket{px}{pz}', g, 'metal_dark', 0.3, 0.06, (cx + px * 3.88, H + 0.5, cz + pz * 2.0), verts=12, bevel=0)
    for s in (-1, 1):
        box(f'lamp_wire{s}', g, 'metal_dark', (0.05, 2.6, 0.05), (cx + s * 1.6, H + 0.6, cz), bevel=0)
    box('table_lamp', g, 'lamp', (3.6, 0.15, 0.6), (cx, H + 3.1, cz), bevel=0.03)


def build_arcade():
    g = 'arcade'
    cx, cz = SCENE['spots']['arcade']['anchor']
    y0 = 0.36
    o = box('arcade', g, 'purple', (13, 4.4, 8), (cx, y0, cz), bevel=0.12)
    box('arcade_cornice', g, 'navy', (13.4, 0.3, 8.4), (cx, y0 + 4.4, cz), bevel=0.06)
    for i, cname in enumerate(('neon_pink', 'neon_teal', 'neon_amber')):
        box(f'arcade_stripe{i}', g, cname, (13.1, 0.16, 0.12), (cx, y0 + 0.9 + i * 0.5, cz + 4.03), bevel=0)
    box('arcade_door', g, 'win_warm', (2.6, 2.0, 0.08), (cx - 3.5, y0, cz + 4.03), bevel=0)
    # the rolling-world runner on the roof is runtime (runner.ts)


def build_garden():
    g = 'garden'
    cx, cz = SCENE['spots']['guestbook']['anchor']
    y0 = 0.36
    cyl('pav_floor', g, 'paving', 2.9, 0.22, (cx, y0, cz), verts=6, bevel=0.05)
    for i in range(6):
        a = i / 6 * math.pi * 2
        box(f'pav_post{i}', g, 'wood_dark', (0.22, 2.6, 0.22), (cx + math.cos(a) * 2.2, y0 + 0.22, cz + math.sin(a) * 2.2), bevel=0.03)
    cyl('pav_roof', g, 'roof_red', 3.4, 1.6, (cx, y0 + 2.8, cz), verts=6, r2=0.1, bevel=0.06)
    cyl('pav_glow', g, 'lamp', 0.45, 0.6, (cx, y0 + 1.7, cz), verts=10, bevel=0)
    # pond
    cyl('pond_rim', g, 'concrete', 3.6, 0.35, (cx + 6, y0, cz + 2.5), verts=40)
    cyl('pond', g, 'water', 3.3, 0.37, (cx + 6, y0, cz + 2.5), verts=40, bevel=0)
    # lantern tree
    tx, tz = cx - 5.5, cz - 3
    cyl('ltree_trunk', g, 'trunk', 0.3, 3.4, (tx, y0, tz), verts=8, r2=0.2)
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=1, radius=2.7)
    for v in bm.verts:
        v.co.z *= 0.7
    o = new_obj('ltree_canopy', bm, g, 'tree')
    o.location = B(tx, tz, y0 + 4.2)
    for i in range(10):
        a = i / 10 * math.pi * 2
        r = 2.1 + (i % 3) * 0.35
        cyl(f'ltree_lantern{i}', g, 'lamp', 0.17, 0.34, (tx + math.cos(a) * r, y0 + 2.5 + (i % 2) * 0.4, tz + math.sin(a) * r), verts=8, bevel=0)
    # path lanterns on posts
    for i in range(6):
        x, z = cx - 7 + i * 3.2, cz + 5.6
        box(f'post{i}', g, 'metal_dark', (0.1, 1.5, 0.1), (x, y0, z), bevel=0)
        cyl(f'post_lantern{i}', g, 'lamp', 0.17, 0.34, (x, y0 + 1.5, z), verts=8, bevel=0)
        light = bpy.data.lights.new(f'gl{i}', 'POINT')
        light.energy = 18
        light.color = (1.0, 0.7, 0.4)
        lo = bpy.data.objects.new(f'gl{i}', light)
        coll('lights').objects.link(lo)
        lo.location = B(x, z, y0 + 1.7)
    light = bpy.data.lights.new('pavL', 'POINT')
    light.energy = 120
    light.color = (1.0, 0.7, 0.42)
    lo = bpy.data.objects.new('pavL', light)
    coll('lights').objects.link(lo)
    lo.location = B(cx, cz, y0 + 1.9)


# ─────────────────────────────────────────────────────────────────────────────
# Traffic Defense deck: a floating platform east of the island, joined to
# Main Street by a bridge. Static parts only; towers and traffic are runtime.
# ─────────────────────────────────────────────────────────────────────────────
DECK = SCENE['deck']


def deck_w(c, r):
    """Game cell (c, r) -> three (x, z)."""
    return (DECK['x'] + (c - DECK['cols'] / 2) * DECK['cell'], DECK['z'] + (r - DECK['rows'] / 2) * DECK['cell'])


DECK_X0, DECK_Z0 = deck_w(-1.4, -0.9)
DECK_X1, DECK_Z1 = deck_w(18.7, 9.9)
BRIDGE_Z = SCENE['deck']['road'][0][1]
BRIDGE_X0 = 55.0  # end of Main Street on the island


def near_deck(x, z, m=0.0):
    return DECK_X0 - m <= x <= DECK_X1 + m and DECK_Z0 - m <= z <= DECK_Z1 + m


def near_bridge(x, z, m=0.0):
    return BRIDGE_X0 - 2 <= x <= DECK_X0 + 1 and abs(z - BRIDGE_Z) <= 2 + m


def text_obj(name, group, cell, body, size, at, rot_y=0.0, extrude=0.06):
    """Neon lettering standing upright, facing three +z (rotated by rot_y)."""
    cu = bpy.data.curves.new(name, 'FONT')
    cu.body = body
    cu.size = size
    cu.extrude = extrude
    cu.align_x = 'CENTER'
    cu.align_y = 'CENTER'
    o = bpy.data.objects.new(name, cu)
    coll(group).objects.link(o)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.ops.object.convert(target='MESH')
    o = bpy.context.view_layer.objects.active
    o.data.materials.clear()
    o.data.materials.append(slot_mat(cell))
    o.location = B(at[0], at[2], at[1])
    o.rotation_euler = (math.pi / 2, 0, rot_y)
    return o


def deck_light(name, x, y, z, energy, color=(1.0, 0.74, 0.48)):
    light = bpy.data.lights.new(name, 'POINT')
    light.energy = energy
    light.color = color
    light.shadow_soft_size = 0.3
    lo = bpy.data.objects.new(name, light)
    coll('lights').objects.link(lo)
    lo.location = B(x, z, y)


def build_deck():
    g = 'deck'
    x0, z0, x1, z1 = DECK_X0, DECK_Z0, DECK_X1, DECK_Z1
    cx, cz = (x0 + x1) / 2, (z0 + z1) / 2
    W, D = x1 - x0, z1 - z0

    # Slab with a lit edge, and a floor grid fine enough to catch lamp pools.
    box('deck_slab', g, 'concrete_mid', (W, 1.4, D), (cx, -1.42, cz), bevel=0.35, segs=3)
    box('deck_edge', g, 'neon_teal', (W + 0.1, 0.1, D + 0.1), (cx, -0.55, cz), bevel=0)
    bm = bmesh.new()
    nx, nz = int(W), int(D)
    vs = [[bm.verts.new(B(x0 + W * i / nx, z0 + D * j / nz, 0.0)) for j in range(nz + 1)] for i in range(nx + 1)]
    for i in range(nx):
        for j in range(nz):
            bm.faces.new((vs[i][j], vs[i + 1][j], vs[i + 1][j + 1], vs[i][j + 1]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    fl = new_obj('deck_floor', bm, g, 'grass')
    if fl.data.polygons[0].normal.z < 0:
        fl.data.flip_normals()
    # a little variation in the grass, like the island's
    paint_faces(fl, lambda c, n: 'grass_dark' if math.sin(c.x * 0.31) + math.sin(-c.y * 0.37 + c.x * 0.13) + 0.6 * math.sin(c.x * 0.9 - c.y * 0.7) > 1.6 else None)

    # Rocky underside, like the islets around the island.
    rnd = random.Random(91)
    prof = [(1.0, -1.3, 'rock_top'), (0.94, -3.2, 'rock_top'), (0.78, -7.5, 'rock_mid'), (0.56, -12.5, 'rock_deep'), (0.32, -17.5, 'rock_dark'), (0.12, -21.0, 'rock_dark')]
    N = 64
    bm = bmesh.new()
    rings = []
    for k, (sc, dep, _) in enumerate(prof):
        ring = []
        for i in range(N):
            a = 2 * math.pi * i / N
            ca, sa = math.cos(a), math.sin(a)
            # superellipse: a rounded rectangle at the top, rounder below
            e = 2 / (6 - 3.5 * k / (len(prof) - 1))
            px = math.copysign(abs(ca) ** e, ca) * W / 2 * sc
            pz = math.copysign(abs(sa) ** e, sa) * D / 2 * sc
            j = 0 if k == 0 else (rnd.random() - 0.5) * 1.6
            ring.append(bm.verts.new(B(cx + px * (1 + 0.02 * j), cz + pz * (1 + 0.02 * j), dep + (0 if k == 0 else (rnd.random() - 0.5) * 1.2))))
        rings.append(ring)
    tip = bm.verts.new(B(cx + 4, cz - 2, -26))
    cells = []
    for k in range(len(rings) - 1):
        for i in range(N):
            j = (i + 1) % N
            bm.faces.new((rings[k][i], rings[k][j], rings[k + 1][j], rings[k + 1][i]))
            cells.append(prof[k + 1][2])
    for i in range(N):
        bm.faces.new((rings[-1][i], rings[-1][(i + 1) % N], tip))
        cells.append('rock_dark')
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    o = new_obj('deck_rock', bm, g, 'rock_top')
    names = []
    for c in cells:
        if c not in names:
            names.append(c)
    o.data.materials.clear()
    for c in names:
        o.data.materials.append(slot_mat(c))
    for poly, c in zip(o.data.polygons, cells):
        poly.material_index = names.index(c)
    p0 = o.data.polygons[N]
    if p0.normal.dot(Vector((p0.center.x - cx, p0.center.y + cz, 0))) < 0:
        o.data.flip_normals()

    # The road, through the real game waypoints: one slab per straight and one
    # per corner, touching but never overlapping (overlaps bake black).
    pts = [Vector((x, z)) for x, z in DECK['road']]
    pts[0] = Vector((x0 - 0.2, pts[0].y))  # meet the bridge at the deck edge
    HW = 1.6
    road_top = lambda c, n: 'concrete_dark' if n.z > 0.5 else None
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]
        dirv = (b - a).normalized()
        a2 = a + dirv * (HW if i > 0 else 0)
        b2 = b - dirv * (HW if i < len(pts) - 2 else 0)
        mid, ln = (a2 + b2) / 2, (b2 - a2).length
        horiz = abs(b.x - a.x) > abs(b.y - a.y)
        size = (ln, 0.2, HW * 2) if horiz else (HW * 2, 0.2, ln)
        o = box(f'deck_road{i}', g, 'concrete', size, (mid.x, 0.0, mid.y), bevel=0.05)
        paint_faces(o, road_top)
        if 0 < i:
            o = box(f'deck_corner{i}', g, 'concrete', (HW * 2, 0.2, HW * 2), (a.x, 0.0, a.y), bevel=0.05)
            paint_faces(o, road_top)
        # dashed centre line, kept clear of the corners
        n = int((b - a).length / 1.4)
        for k in range(1, n):
            p = a.lerp(b, k / n)
            if (p - a).length < 1.9 or (p - b).length < 1.9:
                continue
            dsz = (0.6, 0.02, 0.12) if horiz else (0.12, 0.02, 0.6)
            box(f'deck_dash{i}_{k}', g, 'neon_amber', dsz, (p.x, 0.2, p.y), bevel=0)

    # Build pads: one plinth (top painted lighter) with lit corner studs.
    for k, (px, pz) in enumerate(DECK['pads']):
        o = box(f'pad{k}', g, 'concrete_mid', (2.5, 0.3, 2.5), (px, 0, pz), bevel=0.1)
        paint_faces(o, lambda c, n: 'concrete' if n.z > 0.9 else None)
        for sx in (-1, 1):
            for sz in (-1, 1):
                box(f'pad_lamp{k}{sx}{sz}', g, 'lamp', (0.16, 0.05, 0.16), (px + sx * 1.0, 0.3, pz + sz * 1.0), bevel=0)

    # Internet gate where traffic arrives from the bridge.
    gx, gz = pts[0].x + 1.6, pts[0].y
    for sz in (-1, 1):
        box(f'inet_pylon{sz}', g, 'metal_dark', (0.7, 5.2, 0.7), (gx, 0.14, gz + sz * 2.2), bevel=0.08)
        box(f'inet_strip{sz}', g, 'neon_blue', (0.06, 4.6, 0.06), (gx + 0.37, 0.4, gz + sz * 2.2), bevel=0)
    box('inet_lintel', g, 'navy', (0.9, 0.8, 5.3), (gx, 5.3, gz), bevel=0.08)
    box('inet_glow', g, 'neon_blue', (0.95, 0.08, 4.6), (gx, 5.25, gz), bevel=0)
    box('inet_board', g, 'metal_dark', (6.0, 1.5, 0.25), (gx + 1.4, 0.3, gz + 3.9), bevel=0.06)
    text_obj('inet_text', g, 'neon_blue', 'INTERNET', 0.8, (gx + 1.4, 1.05, gz + 4.05))

    # Origin: the data centre the traffic is trying to reach.
    ex, ez = pts[-1].x, pts[-1].y
    bx = ex + 3.0
    box('origin_hall', g, 'navy', (5.6, 4.6, 9.4), (bx, 0.0, ez), bevel=0.12)
    box('origin_roof', g, 'concrete_dark', (6.0, 0.3, 9.8), (bx, 4.6, ez), bevel=0.06)
    box('origin_door', g, 'win_off', (0.08, 2.0, 2.6), (bx - 2.82, 0.14, ez), bevel=0)
    for k in range(3):
        box(f'origin_ac{k}', g, 'metal_dark', (1.3, 0.7, 1.3), (bx - 1.2 + (k % 2) * 2.2, 4.9, ez - 3 + k * 3), bevel=0.06)
    for k in range(5):  # window band on the south face
        box(f'origin_win{k}', g, 'win_cool' if k % 2 == 0 else 'win_warm', (0.8, 0.5, 0.06), (bx - 2.0 + k * 1.0, 3.2, ez + 4.72), bevel=0)
    text_obj('origin_text', g, 'neon_teal', 'ORIGIN', 0.9, (bx, 1.7, ez + 4.78))
    # queue gauge: eight sockets along the roof edge facing the road (lamps are runtime)
    box('q_rail', g, 'metal_dark', (0.7, 0.16, 8.6), (bx - 2.45, 4.9, ez), bevel=0.04)
    for k in range(8):
        box(f'q_socket{k}', g, 'concrete_dark', (0.46, 0.14, 0.46), (bx - 2.45, 5.06, ez - 3.5 + k * 1.0), bevel=0.04)

    # Big title on the far edge.
    box('title_board', g, 'metal_dark', (21.0, 2.4, 0.4), (cx - 4, 0.0, z0 + 1.0), bevel=0.1)
    text_obj('title_text', g, 'neon_amber', 'TRAFFIC DEFENSE', 1.45, (cx - 4, 1.25, z0 + 1.25))

    # Paved aprons at the gate and the data centre.
    box('inet_apron', g, 'paving', (5.0, 0.06, 7.0), (gx + 0.6, 0.0, gz), bevel=0.04)
    box('origin_apron', g, 'paving', (9.0, 0.06, 12.0), (bx - 1.0, 0.0, ez), bevel=0.04)

    # Trees and rocks where nothing is built, so the deck reads as part of the island.
    road_pts = [Vector(p) for p in DECK['road']]

    def dist_road(x, z):
        best = 1e9
        q = Vector((x, z))
        for i in range(len(road_pts) - 1):
            a, b = road_pts[i], road_pts[i + 1]
            ab = b - a
            t = max(0.0, min(1.0, (q - a).dot(ab) / ab.length_squared))
            best = min(best, (q - (a + ab * t)).length)
        return best
    trnd = random.Random(77)
    placed = []
    for _ in range(900):
        x = x0 + 1.0 + trnd.random() * (W - 2.0)
        z = z0 + 1.0 + trnd.random() * (D - 2.0)
        if dist_road(x, z) < 3.2 or any(math.hypot(x - px, z - pz) < 2.6 for px, pz in DECK['pads']):
            continue
        if abs(x - (bx - 1)) < 6 and abs(z - ez) < 7.5 or abs(x - (gx + 0.6)) < 4 and abs(z - gz) < 5:
            continue
        if z < z0 + 2.6 and abs(x - (cx - 4)) < 11.5:
            continue  # title board
        if any(math.hypot(x - px, z - pz) < 2.3 for px, pz in placed):
            continue
        placed.append((x, z))
        if trnd.random() < 0.75:
            tree(f'deck_tree{len(placed)}', x, z, 0.65 + trnd.random() * 0.45, trnd, g)
        else:
            bm = bmesh.new()
            bmesh.ops.create_icosphere(bm, subdivisions=1, radius=0.55)
            for v in bm.verts:
                v.co.z *= 0.6
            o = new_obj(f'deck_rock{len(placed)}', bm, g, 'rock_top')
            o.location = B(x, z, 0.12)
            o.rotation_euler.z = trnd.random() * 6
        if len(placed) >= 46:
            break

    # Lamp posts around the edge.
    lamp_pts = [(x0 + 3 + k * (W - 6) / 4, z) for k in range(5) for z in (z0 + 0.7, z1 - 0.7)]
    for k, (lx, lz) in enumerate(lamp_pts):
        if abs(lz - (z0 + 1.0)) < 1 and abs(lx - (cx - 4)) < 11:
            continue  # behind the title board
        cyl(f'deck_post{k}', g, 'metal_dark', 0.09, 3.6, (lx, 0, lz), verts=8, bevel=0)
        box(f'deck_lamp{k}', g, 'lamp', (0.5, 0.14, 0.5), (lx, 3.6, lz), bevel=0.03)
        deck_light(f'deckL{k}', lx, 3.4, lz, 160)
    deck_light('originL', bx - 3.6, 3.0, ez + 3.0, 260, (0.6, 0.9, 1.0))
    deck_light('inetL', gx + 0.8, 3.0, gz, 200, (0.55, 0.65, 1.0))

    # Bridge from the end of Main Street to the deck.
    bz = BRIDGE_Z
    bx0, bx1 = BRIDGE_X0, x0 + 0.1
    L = bx1 - bx0
    box('bridge_deck', g, 'concrete_mid', (L, 0.5, 3.6), (bx0 + L / 2, -0.36, bz), bevel=0.06)
    box('bridge_road', g, 'navy', (L, 0.06, 2.5), (bx0 + L / 2, 0.14, bz), bevel=0)
    box('bridge_kerbs', g, 'concrete', (L, 0.14, 3.2), (bx0 + L / 2, 0.0, bz), bevel=0)
    for sz in (-1, 1):
        box(f'bridge_glow{sz}', g, 'neon_teal', (L, 0.05, 0.05), (bx0 + L / 2, -0.12, bz + sz * 1.82), bevel=0)
        # suspension: two towers and a cable sagging between them
        for tx in (bx0 + 4, bx1 - 4):
            box(f'bridge_tower{sz}{int(tx)}', g, 'metal_dark', (0.45, 6.0, 0.45), (tx, 0.14, bz + sz * 1.95), bevel=0.05)
        n = 24
        for k in range(n):
            t0, t1 = k / n, (k + 1) / n
            xa, xb = bx0 + 4 + (L - 8) * t0, bx0 + 4 + (L - 8) * t1
            ya = 6.1 - 4.6 * (1 - (2 * t0 - 1) ** 2)
            yb = 6.1 - 4.6 * (1 - (2 * t1 - 1) ** 2)
            seg = math.hypot(xb - xa, yb - ya)
            o = box(f'bridge_cable{sz}_{k}', g, 'steel', (seg, 0.08, 0.08), ((xa + xb) / 2, (ya + yb) / 2 - 0.04, bz + sz * 1.95), bevel=0)
            o.rotation_euler.y = -math.atan2(yb - ya, xb - xa)
            if k % 2 == 0 and 0 < k < n:
                hy = ya
                box(f'bridge_hanger{sz}_{k}', g, 'steel', (0.04, max(0.05, hy - 0.14), 0.04), (xa, 0.14, bz + sz * 1.95), bevel=0)
    # under-bridge truss
    for k in range(int(L / 3)):
        box(f'bridge_rib{k}', g, 'metal_dark', (0.3, 0.9, 3.4), (bx0 + 1.5 + k * 3, -1.25, bz), bevel=0.03)
    deck_light('bridgeL1', bx0 + L * 0.33, 2.6, bz, 90)
    deck_light('bridgeL2', bx0 + L * 0.66, 2.6, bz, 90)


def build_plaza():
    g = 'plaza'
    hx, hz = SCENE['billboard']
    y0 = 0.36
    cyl('holo_base', g, 'metal_dark', 1.9, 0.6, (hx, y0, hz), verts=24, r2=1.5)
    cyl('holo_emitter', g, 'neon_teal', 1.15, 0.1, (hx, y0 + 0.6, hz), verts=24, bevel=0)
    for i in range(4):  # benches
        a = i / 4 * math.pi * 2 + 0.4
        o = box(f'bench{i}', g, 'wood', (2.2, 0.5, 0.6), (hx + math.cos(a) * 5, y0, hz + math.sin(a) * 5), bevel=0.05)
        o.rotation_euler.z = -a


# ─────────────────────────────────────────────────────────────────────────────
# Light, camera, render, bake, export
# ─────────────────────────────────────────────────────────────────────────────
SUN_THREE = Vector((-0.72, 0.30, 0.55)).normalized()  # toward the sun, three coords


def setup_world(preview=True):
    s = bpy.context.scene
    w = bpy.data.worlds.new('dusk')
    s.world = w
    nt = w.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputWorld')
    bg = nt.nodes.new('ShaderNodeBackground')
    geo = nt.nodes.new('ShaderNodeTexCoord')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    nt.links.new(geo.outputs['Generated'], sep.inputs[0])
    # Generated for world = view direction; z in [-1,1] -> ramp position
    mapr = nt.nodes.new('ShaderNodeMapRange')
    mapr.inputs['From Min'].default_value = -1
    mapr.inputs['From Max'].default_value = 1
    nt.links.new(sep.outputs['Z'], mapr.inputs['Value'])
    nt.links.new(mapr.outputs['Result'], ramp.inputs['Fac'])
    cr = ramp.color_ramp
    cr.elements[0].position = 0.35
    cr.elements[0].color = (0.10, 0.05, 0.16, 1)
    cr.elements[1].position = 1.0
    cr.elements[1].color = (0.05, 0.06, 0.22, 1)
    e = cr.elements.new(0.5)
    e.color = (0.85, 0.36, 0.30, 1)  # warm horizon
    e = cr.elements.new(0.58)
    e.color = (0.42, 0.22, 0.52, 1)
    e = cr.elements.new(0.72)
    e.color = (0.16, 0.13, 0.42, 1)
    nt.links.new(ramp.outputs['Color'], bg.inputs['Color'])
    bg.inputs['Strength'].default_value = 0.7
    nt.links.new(bg.outputs[0], out.inputs[0])

    sun = bpy.data.lights.new('sun', 'SUN')
    sun.energy = 4.2
    sun.color = (1.0, 0.56, 0.36)
    sun.angle = math.radians(4)
    so = bpy.data.objects.new('sun', sun)
    coll('lights').objects.link(so)
    d = B(SUN_THREE.x, SUN_THREE.z, SUN_THREE.y).normalized()
    so.rotation_euler = d.to_track_quat('Z', 'Y').to_euler()


def setup_camera(pos3, target3, fov_v=32):
    s = bpy.context.scene
    cam = bpy.data.cameras.new('cam')
    cam.sensor_fit = 'VERTICAL'
    cam.angle_y = math.radians(fov_v)
    cam.clip_end = 3000
    co = bpy.data.objects.new('cam', cam)
    s.collection.objects.link(co)
    p, t = B(pos3[0], pos3[2], pos3[1]), B(target3[0], target3[2], target3[1])
    co.location = p
    co.rotation_euler = (t - p).to_track_quat('-Z', 'Y').to_euler()
    s.camera = co


CAMERAS = {
    'hero': ((74, 64, 122), (2, -4, 2)),
    'station': ((-10, 40, 52), (2, 0, -2)),
    'vault': ((-24, 30, 40), (-36, 2, 0)),
    'arena': ((22, 42, 18), (2, 2, -32)),
    'south': ((0, 22, 92), (0, 2, 20)),
    'top': ((0.1, 230, 0.1), (0, 0, 0)),
    'deck': ((112, 58, 74), (112, 0, 24)),
    'wide': ((150, 120, 210), (40, -8, 10)),
}


def build_all():
    global PAL, MASTER
    bpy.ops.wm.read_factory_settings(use_empty=True)
    PAL = Palette()
    MASTER = master_material()
    build_island()
    build_city()
    build_lamps()
    build_rim_trees()
    build_station()
    build_vault()
    build_arena()
    build_gateway()
    build_poolhall()
    build_arcade()
    build_garden()
    build_plaza()
    build_deck()
    finalize_all()
    setup_world()


def render(out, cam='hero', samples=24, w=1280, h=720):
    s = bpy.context.scene
    s.render.engine = 'CYCLES'
    s.cycles.device = 'CPU'
    s.cycles.samples = samples
    s.cycles.use_denoising = True
    s.cycles.max_bounces = 4
    s.render.resolution_x, s.render.resolution_y = w, h
    s.view_settings.view_transform = 'AgX'
    s.view_settings.look = 'AgX - Punchy'
    s.view_settings.exposure = 0.4
    pos, tgt = CAMERAS[cam]
    setup_camera(pos, tgt)
    s.render.filepath = out
    bpy.ops.render.render(write_still=True)


def stats():
    objs = [o for o in bpy.data.objects if o.type == 'MESH']
    faces = sum(len(o.data.polygons) for o in objs)
    print(f'## objects {len(objs)}, faces {faces}, lamps {len(LAMPS)}')


if __name__ == '__main__':
    mode = sys.argv[1]
    build_all()
    stats()
    if mode == 'preview':
        render(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else 'hero')
    elif mode == 'blend':
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(sys.argv[2]))
    elif mode == 'bake':
        from bake import bake_and_export  # noqa: E402
        bake_and_export(sys.argv[2], quick='--quick' in sys.argv, lamps=LAMPS, pal=PAL, struct_only='--struct-only' in sys.argv)
