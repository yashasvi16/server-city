"""Bake lightmaps for the built city and export it for the browser.

Chunks (one lightmap each):
  ground  - terrain, roads, pavement: planar UVs over the island (crisp shadows)
  struct  - buildings, landmarks, props: smart-UV atlas
  nature  - cliff, shards, rim trees and rocks: smart-UV atlas

Bake pass: DIFFUSE with DIRECT + INDIRECT and no COLOR, i.e. pure irradiance.
The browser computes palette(uv0) * lightmap(uv1) * k, so albedo stays crisp
while light stays soft. Output is written to OUT_DIR:
  city.glb, lm-ground.jpg, lm-struct.jpg, lm-nature.jpg, palette.png, emissive.png
"""
import math
import os
import time

import numpy as np
import bpy

PLANAR_KENNEY = ('road-', 'pavement', 'grass')  # flat Kenney tiles (not grass-trees)
GROUND_NAMES = {'ground', 'yard_bed'}


def chunk_of(o):
    n = o.name.split('.')[0]
    cols = {c.name for c in o.users_collection}
    if n in GROUND_NAMES or (o.get('kenney') and n.startswith(PLANAR_KENNEY) and not n.startswith('grass-trees')):
        return 'ground'
    if 'nature' in cols:
        return 'nature'
    return 'struct'


def join(objs, name):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
        if o.data.users > 1:
            o.data = o.data.copy()
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bpy.ops.object.join()
    j = bpy.context.view_layer.objects.active
    j.name = name
    j.data.name = name
    return j


def planar_uv(o, bounds):
    (x0, y0, x1, y1) = bounds
    me = o.data
    lm = me.uv_layers.new(name='Lightmap')
    co = np.zeros(len(me.vertices) * 3, dtype=np.float32)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    vi = np.zeros(len(me.loops), dtype=np.int32)
    me.loops.foreach_get('vertex_index', vi)
    u = (co[vi, 0] - x0) / (x1 - x0)
    v = (co[vi, 1] - y0) / (y1 - y0)
    lm.data.foreach_set('uv', np.stack([u, v], 1).ravel())


def smart_uv(o, margin):
    me = o.data
    lm = me.uv_layers.new(name='Lightmap')
    me.uv_layers.active = lm
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=margin, area_weight=0.0, scale_to_bounds=True)
    bpy.ops.uv.pack_islands(margin=margin, rotate=True)
    bpy.ops.object.mode_set(mode='OBJECT')
    me.uv_layers.active = me.uv_layers['UVMap']


def lightmap_pack(o, margin_div):
    """One rectangle per face, sized by area, packed edge to edge: fills the
    atlas far better than smart-project on thousands of small bevelled parts."""
    me = o.data
    lm = me.uv_layers.new(name='Lightmap')
    me.uv_layers.active = lm
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    t = time.time()
    bpy.ops.uv.lightmap_pack(PREF_CONTEXT='ALL_FACES', PREF_PACK_IN_ONE=True, PREF_NEW_UVLAYER=False,
                             PREF_BOX_DIV=12, PREF_MARGIN_DIV=margin_div)
    bpy.ops.object.mode_set(mode='OBJECT')
    me.uv_layers.active = me.uv_layers['UVMap']
    print(f'## lightmap_pack {o.name} in {time.time() - t:.0f}s', flush=True)


def bake_chunk(o, size, samples, master):
    img = bpy.data.images.new('lm-' + o.name, size, size, alpha=False, float_buffer=True)
    nt = master.node_tree
    node = nt.nodes[master['bake_tex_node']]
    node.image = img
    nt.nodes.active = node
    uvnode = nt.nodes.get('bake_uv') or nt.nodes.new('ShaderNodeUVMap')
    uvnode.name = 'bake_uv'
    uvnode.uv_map = 'Lightmap'
    nt.links.new(uvnode.outputs['UV'], node.inputs['Vector'])
    s = bpy.context.scene
    s.cycles.samples = samples
    s.render.bake.margin = 6
    s.render.bake.use_pass_direct = True
    s.render.bake.use_pass_indirect = True
    s.render.bake.use_pass_color = False
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    t = time.time()
    bpy.ops.object.bake(type='DIFFUSE', pass_filter={'DIRECT', 'INDIRECT'}, uv_layer='Lightmap', use_clear=True, margin=6)
    print(f'## baked {o.name} {size}px {samples}spp in {time.time() - t:.0f}s', flush=True)
    return img


def bake_vertex(o, samples):
    """Bake irradiance into a per-corner colour attribute. Per corner (not
    per vertex), so a flat-shaded box keeps a lit and a shadowed side. For
    thousands of small bevelled parts this beats any atlas: no seams, no
    sub-texel faces, no texture download, and samples are cheap enough to
    take hundreds per corner, so there is no grain."""
    me = o.data
    attr = me.color_attributes.new(name='Bake', type='FLOAT_COLOR', domain='CORNER')
    me.color_attributes.active_color = attr
    me.color_attributes.render_color_index = me.color_attributes.find('Bake')
    s = bpy.context.scene
    s.cycles.samples = samples
    s.render.bake.target = 'VERTEX_COLORS'
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    t = time.time()
    bpy.ops.object.bake(type='DIFFUSE', pass_filter={'DIRECT', 'INDIRECT'}, target='VERTEX_COLORS', use_clear=True)
    s.render.bake.target = 'IMAGE_TEXTURES'
    n = len(attr.data)
    c = np.zeros(n * 4, dtype=np.float32)
    attr.data.foreach_get('color', c)
    c = c.reshape(-1, 4)
    c[:, :3] = np.clip(c[:, :3] / SCALE, 0, 1)
    c[:, 3] = 1
    attr.data.foreach_set('color', c.ravel())
    print(f'## baked {o.name} per-corner ({n} corners) {samples}spp in {time.time() - t:.0f}s', flush=True)


def denoise(img):
    """Edge-safe blur: average with neighbours that are close in value.
    (Cycles has no denoiser for bakes; this removes grain without smearing
    shadow edges or bleeding across UV islands.)"""
    w, h = img.size
    a = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)[..., :3]
    out = a.copy()
    for _ in range(2):
        acc = out.copy()
        wsum = np.ones(out.shape[:2] + (1,), dtype=np.float32)
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (1, 1), (-1, 1), (1, -1)):
            sh = np.roll(np.roll(out, dy, 0), dx, 1)
            lum_diff = np.abs(sh.mean(-1, keepdims=True) - out.mean(-1, keepdims=True))
            wgt = np.exp(-(lum_diff / 0.08) ** 2)
            acc += sh * wgt
            wsum += wgt
        out = acc / wsum
    return out


SCALE = 2.0  # irradiance stored /SCALE so bright spots don't clip; runtime multiplies back


def save_jpg(rgb, path, quality):
    h, w, _ = rgb.shape
    enc = np.clip(rgb / SCALE, 0, 1)
    enc = np.where(enc <= 0.0031308, enc * 12.92, 1.055 * np.power(enc, 1 / 2.4) - 0.055)  # linear -> sRGB
    try:
        from PIL import Image
        Image.fromarray((enc[::-1] * 255 + 0.5).astype(np.uint8)).save(path, quality=quality, optimize=True, progressive=True)
    except ImportError:
        img = bpy.data.images.new('tmp', w, h, alpha=False)
        img.pixels[:] = np.dstack([enc, np.ones((h, w, 1))]).ravel()
        img.filepath_raw = path
        img.file_format = 'JPEG'
        bpy.context.scene.render.image_settings.quality = quality
        img.save()


def bake_and_export(out_dir, quick=False, lamps=(), pal=None, struct_only=False):
    os.makedirs(out_dir, exist_ok=True)
    s = bpy.context.scene
    s.render.engine = 'CYCLES'
    s.cycles.device = 'CPU'
    s.cycles.max_bounces = 4
    master = bpy.data.materials['city']
    groups = {'ground': [], 'struct': [], 'nature': []}
    for o in list(bpy.data.objects):
        if o.type == 'MESH':
            groups[chunk_of(o)].append(o)
    plan = {  # size, samples
        'ground': (512, 8) if quick else (2048, 48),
        'struct': (0, 16) if quick else (0, 256),
        'nature': (512, 8) if quick else (1024, 24),
    }
    if struct_only:  # lightmaps unchanged: reuse the previous ones, re-bake the vertex light only
        plan['ground'] = plan['nature'] = (64, 1)
    chunks = {}
    for name, objs in groups.items():
        j = join(objs, 'lm_' + name)
        if name == 'ground':
            xs = [v.co.x for v in j.data.vertices]
            ys = [v.co.y for v in j.data.vertices]
            pad = 0.5
            planar_uv(j, (min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad))
        elif name == 'struct':
            pass  # per-corner bake, no lightmap UVs
        else:
            smart_uv(j, 0.006)
        chunks[name] = j
        print(f'## chunk {name}: {len(j.data.polygons)} faces', flush=True)
    for name, j in chunks.items():
        size, spp = plan[name]
        if name == 'struct':
            bake_vertex(j, spp)
            continue
        img = bake_chunk(j, size, spp, master)
        rgb = denoise(img)
        save_jpg(rgb, os.path.join(out_dir, f'lm-{name}.jpg'), 88)
    pal.save(out_dir)
    # Export geometry only; the browser builds the material.
    for j in chunks.values():
        j.data.materials.clear()
    bpy.ops.object.select_all(action='DESELECT')
    for j in chunks.values():
        j.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=os.path.join(out_dir, 'city.glb'), use_selection=True, export_format='GLB',
        export_texcoords=True, export_normals=False, export_materials='NONE', export_attributes=False,
        export_vertex_color='ACTIVE', export_all_vertex_colors=False, export_active_vertex_color_when_no_material=True,
        export_yup=True, export_apply=True,
    )
    print('## exported', os.path.join(out_dir, 'city.glb'), flush=True)
