"""Shared helpers for the character-pipeline Blender scripts.

Every script is run as
    blender -b --factory-startup --python-exit-code 1 -P <script>.py -- <args.json>
and writes its report to args["report"] as JSON. Blender's world is Z-up with the
character facing -Y, which the glTF exporter maps to glTF +Y up, facing +Z.
"""
import json
import sys
import time

import bmesh
import bpy
import numpy as np
from mathutils import Vector


def load_args():
    argv = sys.argv
    path = argv[argv.index("--") + 1]
    with open(path) as f:
        return json.load(f)


def write_report(args, report):
    with open(args["report"], "w") as f:
        json.dump(report, f, indent=1)


def check(id, passed, value=None, limit=None, detail=None, advisory=False):
    c = {"id": id, "pass": bool(passed)}
    if value is not None:
        c["value"] = round(value, 4) if isinstance(value, float) else value
    if limit is not None:
        c["limit"] = limit
    if detail:
        c["detail"] = detail
    if advisory:
        c["advisory"] = True
    return c


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_glb(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in before]


def mesh_objects():
    return [o for o in bpy.data.objects if o.type == "MESH"]


def join_meshes():
    """Join all meshes into one object with transforms applied; return it."""
    meshes = mesh_objects()
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes:
        o.select_set(True)
        o.parent = None
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    for o in list(bpy.data.objects):
        if o.type == "EMPTY":
            bpy.data.objects.remove(o)
    return obj


def world_coords(obj):
    n = len(obj.data.vertices)
    co = np.empty(n * 3)
    obj.data.vertices.foreach_get("co", co)
    co = co.reshape(n, 3)
    m = np.array(obj.matrix_world)
    return co @ m[:3, :3].T + m[:3, 3]


def triangles(obj):
    obj.data.calc_loop_triangles()
    tris = obj.data.loop_triangles
    idx = np.empty(len(tris) * 3, dtype=np.int64)
    tris.foreach_get("vertices", idx)
    return idx.reshape(-1, 3)


def mesh_stats(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    non_manifold = sum(1 for e in bm.edges if not e.is_manifold)
    bm.verts.ensure_lookup_table()
    seen = np.zeros(len(bm.verts), dtype=bool)
    comps = []
    for v in bm.verts:
        if seen[v.index]:
            continue
        stack = [v]
        seen[v.index] = True
        n = 0
        while stack:
            a = stack.pop()
            n += 1
            for e in a.link_edges:
                b = e.other_vert(a)
                if not seen[b.index]:
                    seen[b.index] = True
                    stack.append(b)
        comps.append(n)
    bm.free()
    obj.data.calc_loop_triangles()
    return {
        "triangles": len(obj.data.loop_triangles),
        "vertices": len(obj.data.vertices),
        "non_manifold_edges": non_manifold,
        "components": sorted(comps, reverse=True),
    }


def rasterize(points2d, tris, res, bounds):
    """Silhouette of a triangle soup projected to 2D, as a res x res bool mask.

    `bounds` = (u0, v0, size): the square window [u0, u0+size] x [v0, v0+size].
    Triangles are filled by dense barycentric sampling (enough at silhouette
    resolutions; every triangle gets at least its centroid and corners).
    """
    u0, v0, size = bounds
    p = (points2d - np.array([u0, v0])) / size * res
    a, b, c = p[tris[:, 0]], p[tris[:, 1]], p[tris[:, 2]]
    area = np.abs((b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (c[:, 0] - a[:, 0]) * (b[:, 1] - a[:, 1])) / 2
    k = np.clip(np.ceil(np.sqrt(area) * 2), 1, 64).astype(np.int64)
    mask = np.zeros((res, res), dtype=bool)
    for kk in np.unique(k):
        sel = k == kk
        g = np.arange(kk + 1) / kk
        uu, vv = np.meshgrid(g, g)
        keep = uu + vv <= 1
        uu, vv = uu[keep], vv[keep]
        pts = (a[sel][:, None, :] + uu[None, :, None] * (b[sel] - a[sel])[:, None, :]
               + vv[None, :, None] * (c[sel] - a[sel])[:, None, :]).reshape(-1, 2)
        ix = np.clip(pts[:, 0].astype(np.int64), 0, res - 1)
        iy = np.clip(pts[:, 1].astype(np.int64), 0, res - 1)
        mask[iy, ix] = True
    return mask


def iou(a, b):
    u = np.logical_or(a, b).sum()
    return float(np.logical_and(a, b).sum() / u) if u else 0.0


def load_image_rgba(path):
    img = bpy.data.images.load(path, check_existing=False)
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    bpy.data.images.remove(img)
    # Blender pixel rows run bottom-to-top.
    return px.reshape(h, w, 4)


def alpha_bbox(rgba):
    ys, xs = np.nonzero(rgba[:, :, 3] > 0.5)
    return xs.min(), ys.min(), xs.max() + 1, ys.max() + 1


def quat_angle(a, b):
    """Smallest rotation angle (radians) between two orientations; q and -q are the same rotation."""
    d = a.rotation_difference(b).angle
    return min(d, 2 * np.pi - d)


def export_character(path, animations):
    """Export Skeleton + Character as a .glb.

    The mesh is unparented first (armature modifier kept): a skinned mesh node
    under the armature node is ignored for transforms by the glTF spec and the
    Khronos validator flags it (NODE_SKINNED_MESH_NON_ROOT)."""
    mesh = bpy.data.objects["Character"]
    world = mesh.matrix_world.copy()
    mesh.parent = None
    mesh.matrix_world = world
    bpy.ops.object.select_all(action="DESELECT")
    for name in ("Character", "Skeleton"):
        bpy.data.objects[name].select_set(True)
    kwargs = {}
    if animations:
        kwargs = dict(
            export_animation_mode="ACTIONS", export_force_sampling=True, export_frame_range=True,
            export_anim_slide_to_zero=True, export_optimize_animation_size=False,
        )
    bpy.ops.export_scene.gltf(
        filepath=path, export_format="GLB", use_selection=True, export_yup=True,
        export_skins=True, export_influence_nb=4, export_def_bones=False,
        export_animations=animations, export_rest_position_armature=True, export_reset_pose_bones=True,
        export_image_format="AUTO", **kwargs,
    )


class Timer:
    def __init__(self):
        self.t0 = time.time()
        self.marks = {}

    def mark(self, name):
        self.marks[name] = round(time.time() - self.t0, 2)
