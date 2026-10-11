"""
Blender (bpy) clean-up for downloaded models, run headless:

    python tools/assets/process.py <asset> <in.glb> <out.glb>

For cars it produces a game-ready layout: metres, facing +z (glTF), origin on
the ground under the middle of the body, one `body` mesh (one draw call per
material) and four `wheel_FL/FR/RL/RR` meshes whose origins sit on their axles
so the game can spin and steer them. Rigs, animations and stray helpers are
dropped and everything is baked to static meshes.
"""
import json
import math
import re
import struct
import sys

import bpy
import mathutils

ASSETS = {
    # Wheel regexes match a node or any of its ancestors in the source glTF;
    # `front` tells which of those wheels are at the front.
    'charger': {
        'wheels': r'Wheel1A_(LF|RF|LR|RR)',
        'front': r'_(LF|RF)',
    },
    'skyline': {
        'wheels': r'3DWheel (Front|Rear) [LR]',
        'front': r'Front',
        'drop': r'^Icosphere',
        # Simplify the 200k-triangle body a little; wheels are already light.
        'body_ratio': 0.6,
    },
    'police': {
        'wheels': r'CrownVic\.Wheel\.(Ft|Bk)\.[LR]$',
        'front': r'\.Ft\.',
        # Modelled about 1.24x too big: a Crown Victoria is 5.39 m long.
        'length': 5.39,
        # Up to ten cruisers on screen: about 40k triangles each.
        'body_ratio': 0.25,
        'wheel_ratio': 0.1,
    },
    'christ': {},
}


def gltf_chains(path):
    """Node name -> names of the node and its ancestors, from the source glTF."""
    b = open(path, 'rb').read()
    clen = struct.unpack('<I', b[12:16])[0]
    j = json.loads(b[20:20 + clen])
    parent = {}
    for i, n in enumerate(j['nodes']):
        for c in n.get('children', []):
            parent[c] = i
    chains = {}
    owner = ''
    for i, n in enumerate(j['nodes']):
        names, k = [], i
        while k is not None:
            names.append(j['nodes'][k].get('name', ''))
            k = parent.get(k)
        # Rigged exports flatten mesh nodes under the skeleton, but keep each one right
        # after the transform it came from: remember that as a pseudo-ancestor too.
        if 'mesh' not in n:
            owner = n.get('name', '')
        else:
            names.append(owner)
        chains[n.get('name', '')] = names
    return chains


def bake(objs):
    """Static copies of mesh objects with deformation and world transforms applied."""
    dg = bpy.context.evaluated_depsgraph_get()
    col = bpy.data.collections.new('baked')
    bpy.context.scene.collection.children.link(col)
    out = []
    for o in objs:
        e = o.evaluated_get(dg)
        me = bpy.data.meshes.new_from_object(e, preserve_all_data_layers=True, depsgraph=dg)
        me.transform(e.matrix_world)
        n = bpy.data.objects.new('baked', me)
        col.objects.link(n)
        out.append((o.name, n))
    for o in list(bpy.context.scene.objects):
        if o.users_collection and col not in o.users_collection:
            bpy.data.objects.remove(o, do_unlink=True)
    # Now the originals are gone the copies can take their names.
    for name, n in out:
        n.name = name
    return [n for _, n in out]


def bounds(objs):
    lo = mathutils.Vector((math.inf,) * 3)
    hi = mathutils.Vector((-math.inf,) * 3)
    for o in objs:
        for v in o.data.vertices:
            w = o.matrix_world @ v.co
            lo = mathutils.Vector(map(min, lo, w))
            hi = mathutils.Vector(map(max, hi, w))
    return lo, hi


def transform_all(objs, m):
    for o in objs:
        o.data.transform(m)
        o.data.update()


def join(objs, name):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    o.name = o.data.name = name
    return o


def decimate(o, ratio):
    if not ratio or ratio >= 1:
        return
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    mod = o.modifiers.new('decimate', 'DECIMATE')
    mod.ratio = ratio
    bpy.ops.object.modifier_apply(modifier=mod.name)


def tris(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


def main():
    name, src, dst = sys.argv[-3:]
    cfg = ASSETS[name]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=src)
    chains = gltf_chains(src)

    # Parts without a material are export helpers (a 2 m sphere in several Sketchfab files).
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH' and any(o.data.materials)]
    if cfg.get('drop'):
        meshes = [o for o in meshes if not re.search(cfg['drop'], o.name)]
    # Which wheel (if any) each mesh belongs to, from the source hierarchy.
    wheel_of = {}
    if cfg.get('wheels'):
        for o in meshes:
            names = list(chains.get(re.sub(r'\.\d{3}$', '', o.name), [o.name]))
            # Skinned parts belong to whichever bone moves most of their vertices.
            if o.vertex_groups:
                weight = {}
                for v in o.data.vertices:
                    for g in v.groups:
                        weight[g.group] = weight.get(g.group, 0) + g.weight
                if weight:
                    names.append(o.vertex_groups[max(weight, key=weight.get)].name)
            hit = next((n for n in names if re.search(cfg['wheels'], n)), None)
            if hit:
                wheel_of[o.name] = hit
    objs = bake(meshes)

    # Some exports carry an extra 1/100 scale on their rig: back to metres.
    lo, hi = bounds(objs)
    if max(hi - lo) < 1:
        transform_all(objs, mathutils.Matrix.Scale(100, 4))

    if not cfg.get('wheels'):
        lo, hi = bounds(objs)
        transform_all(objs, mathutils.Matrix.Translation((-(lo.x + hi.x) / 2, -(lo.y + hi.y) / 2, -lo.z)))
        body = join(objs, 'model')
        print(f'{name}: {tris(body)} tris')
        export(dst)
        return

    groups = {}
    body_parts = []
    for o in objs:
        w = wheel_of.get(o.name)
        (groups.setdefault(w, []) if w else body_parts).append(o)
    assert len(groups) == 4, f'expected 4 wheels, found {sorted(groups)}'

    # Face +z in glTF (Blender -Y): front axle ahead of the rear one.
    def centre(parts):
        lo, hi = bounds(parts)
        return (lo + hi) / 2

    front = [centre(p) for k, p in groups.items() if re.search(cfg['front'], k)]
    rear = [centre(p) for k, p in groups.items() if not re.search(cfg['front'], k)]
    fwd = sum(front, mathutils.Vector()) / len(front) - sum(rear, mathutils.Vector()) / len(rear)
    angle = math.atan2(fwd.x, -fwd.y)  # rotation that takes fwd onto -Y
    transform_all(objs, mathutils.Matrix.Rotation(angle, 4, 'Z'))
    if cfg.get('length'):
        lo, hi = bounds(body_parts)
        transform_all(objs, mathutils.Matrix.Scale(cfg['length'] / (hi.y - lo.y), 4))

    # Origin on the ground (tyre bottoms) under the middle of the body.
    wl, _ = bounds([o for p in groups.values() for o in p])
    lo, hi = bounds(body_parts)
    transform_all(objs, mathutils.Matrix.Translation((-(lo.x + hi.x) / 2, -(lo.y + hi.y) / 2, -wl.z)))

    body = join(body_parts, 'body')
    decimate(body, cfg.get('body_ratio'))
    total = tris(body)
    for parts in groups.values():
        c = centre(parts)
        # glTF +x is the car's left; Blender -Y is forward.
        label = ('F' if c.y < 0 else 'R') + ('L' if c.x > 0 else 'R')
        wheel = join(parts, f'wheel_{label}')
        decimate(wheel, cfg.get('wheel_ratio'))
        # Pivot on the axle so the game can spin and steer it.
        bpy.ops.object.select_all(action='DESELECT')
        wheel.select_set(True)
        bpy.context.view_layer.objects.active = wheel
        bpy.ops.object.origin_set(type='ORIGIN_GEOMETRY', center='BOUNDS')
        total += tris(wheel)
        print(f'{name}: {wheel.name} at {tuple(round(v, 2) for v in wheel.location)}')
    lo, hi = bounds(bpy.context.scene.objects)
    print(f'{name}: {total} tris, size {hi.x - lo.x:.2f} x {hi.y - lo.y:.2f} x {hi.z - lo.z:.2f} m')
    export(dst)


def export(dst):
    bpy.ops.export_scene.gltf(
        filepath=dst,
        export_format='GLB',
        export_yup=True,
        export_apply=True,
        export_animations=False,
        export_skins=False,
        export_morph=False,
        export_extras=False,
    )


main()
