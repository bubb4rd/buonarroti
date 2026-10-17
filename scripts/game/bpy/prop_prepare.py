"""Prop step — raw image-to-3D output → game-ready static prop with a collision hull.

args: raw (glb), views {front, side, back: png}, category ("handheld" | "pickup"),
      size_m (item height at the sheet's ruler scale), grip_frac + grip_half_frac
      (handheld: grip box centre / half height as fractions of the item's height
      from its lower end), grip_diameter_m, target_tris, texel_density (px/m),
      texture_sizes [ascending], name, out_glb, out_albedo, budget (PROP_BUDGET with
      the category's ranges resolved), report

The character steps in mesh_prepare.py are reused as they are (cleaning, the
side-view orientation, decimation, projection of the conformed drawings, bake);
what differs is everything a prop needs instead of feet on the ground:

- scale: handheld items are scaled so the handle inside the grip box has
  `grip_diameter_m` (mean of its front and side widths) — the image model drew
  every handheld item about as long as the template's ruler whatever it was, but
  a handle that fits the fist is what equipping needs; pickups keep the ruler's
  scale.
- pivot: handheld at the grip centre, handle along +Z (glTF +Y), front towards
  -Y (glTF +Z), width along X; pickup at the centre of its footprint, lowest
  point at z = 0.
- texel density: UV islands are scaled down to the reference character's px/m
  in the smallest allowed texture that holds them, so the prop is as sharp as
  the hand holding it (a sword at 1024 px would be ~4x sharper than the ranger).
- collision: a convex hull of at most `maxHullPoints` vertices, exported as a
  separate `<name>Collision-convcolonly` node (Godot: StaticBody3D +
  ConvexPolygonShape3D, no mesh), scaled about its centre until it contains
  every vertex of the visual mesh.
"""
import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402
import mesh_prepare as M  # noqa: E402

GRIP_SLICES = 9


def slice_points(co, tris, z):
    """Points where the surface crosses the plane at height z (segment ends), shape (N, 3)."""
    a, b, c = co[tris[:, 0]], co[tris[:, 1]], co[tris[:, 2]]
    pts = []
    for p, q in ((a, b), (b, c), (c, a)):
        hit = (p[:, 2] - z) * (q[:, 2] - z) < 0
        t = (z - p[hit, 2]) / (q[hit, 2] - p[hit, 2])
        pts.append(p[hit] + t[:, None] * (q[hit] - p[hit]))
    return np.concatenate(pts) if pts else np.zeros((0, 3))


def runs_1d(values, gap):
    """Number of clusters of sorted 1-D values separated by more than `gap`."""
    if len(values) == 0:
        return 0
    v = np.sort(values)
    return int(1 + np.sum(np.diff(v) > gap))


def measure_grip(co, tris, z_lo, z_hi, height):
    """Handle across the grip box: per slice its x / y widths, centre, and how many
    separate parts the slice crosses (1 = only the handle). Medians over the slices."""
    widths, centres, parts = [], [], []
    for z in np.linspace(z_lo, z_hi, GRIP_SLICES):
        p = slice_points(co, tris, z)
        if len(p) < 6:
            continue
        lo, hi = p.min(0), p.max(0)
        widths.append((hi[0] - lo[0], hi[1] - lo[1]))
        centres.append(((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2))
        parts.append(max(runs_1d(p[:, 0], 0.02 * height), runs_1d(p[:, 1], 0.02 * height)))
    if not widths:
        return None
    w, c = np.median(np.array(widths), 0), np.median(np.array(centres), 0)
    return {"width_x": float(w[0]), "width_y": float(w[1]), "diameter": float(w.mean()),
            "centre": (float(c[0]), float(c[1])), "parts": int(np.median(parts)), "slices": len(widths)}


def surface_and_uv_area(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.transform(obj.matrix_world)
    uv = bm.loops.layers.uv.active
    area, uv_area = 0.0, 0.0
    for f in bm.faces:
        area += f.calc_area()
        l = [x[uv].uv for x in f.loops]
        for i in range(1, len(l) - 1):
            uv_area += abs((l[i].x - l[0].x) * (l[i + 1].y - l[0].y) - (l[i + 1].x - l[0].x) * (l[i].y - l[0].y)) / 2
    bm.free()
    return area, uv_area


def fit_texel_density(obj, target, sizes):
    """Smallest texture side in `sizes` whose packed islands, scaled down, give
    `target` px/m; the islands are scaled about the UV origin. Returns
    (size, density reached, uv coverage)."""
    area, uv_area = surface_and_uv_area(obj)
    size, s = sizes[-1], 1.0
    for t in sizes:
        need = area * (target / t) ** 2
        if need <= uv_area:
            size, s = t, math.sqrt(need / uv_area)
            break
    uvs = obj.data.uv_layers.active.data
    flat = np.empty(len(uvs) * 2)
    uvs.foreach_get("uv", flat)
    uvs.foreach_set("uv", flat * s)
    return size, size * math.sqrt(uv_area * s * s / area), uv_area * s * s


def hull_object(obj, name, max_points):
    """Convex hull of the mesh, reduced to at most `max_points` vertices (its
    extreme vertex along evenly spread directions plus the six axes, so a blade
    keeps its thickness), then scaled about its centre until every mesh vertex
    is inside (a smaller hull would let the item sink into the floor)."""
    co = C.world_coords(obj)
    bm = bmesh.new()
    for p in co:
        bm.verts.new(p)
    res = bmesh.ops.convex_hull(bm, input=bm.verts, use_existing_faces=False)
    keep = {v for v in res["geom"] if isinstance(v, bmesh.types.BMVert)}
    pts = np.array([v.co[:] for v in keep])
    bm.free()
    if len(pts) > max_points:
        n = max_points - 6
        i = np.arange(n) + 0.5
        phi, z = np.pi * (1 + 5 ** 0.5) * i, 1 - 2 * i / n
        dirs = np.stack([np.sqrt(1 - z * z) * np.cos(phi), np.sqrt(1 - z * z) * np.sin(phi), z], 1)
        dirs = np.concatenate([dirs, np.eye(3), -np.eye(3)])
        pts = pts[np.unique(np.argmax(pts @ dirs.T, axis=0))]
    bm = bmesh.new()
    for p in pts:
        bm.verts.new(p)
    bmesh.ops.convex_hull(bm, input=bm.verts, use_existing_faces=False)
    for v in [v for v in bm.verts if not v.link_faces]:
        bm.verts.remove(v)
    bm.normal_update()
    centre = np.array([v.co[:] for v in bm.verts]).mean(0)
    scale = 1.0
    for f in bm.faces:
        n = np.array(f.normal[:])
        h = float(n @ (np.array(f.verts[0].co[:]) - centre))
        if h < 0:  # bmesh's hull winding is not guaranteed outward
            n, h = -n, -h
        if h > 1e-9:
            scale = max(scale, float(((co - centre) @ n).max()) / h)
    for v in bm.verts:
        v.co = Vector(centre + (np.array(v.co[:]) - centre) * scale)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    hull = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(hull)
    return hull, len(me.vertices), scale


def main():
    args = C.load_args()
    b = args["budget"]
    handheld = args["category"] == "handheld"
    t = C.Timer()
    C.reset_scene()
    C.import_glb(args["raw"])
    obj = C.join_meshes()
    raw = C.mesh_stats(obj)
    spikes = M.clean(obj)
    views = {k: C.load_image_rgba(p) for k, p in args["views"].items()}
    view_masks = {k: M.view_silhouette(v) for k, v in views.items()}
    turned, _, _ = M.orient(obj, view_masks)
    t.mark("clean")

    # Ruler scale first: lower end at z = 0, footprint centred.
    co = C.world_coords(obj)
    lo, hi = co.min(0), co.max(0)
    k = args["size_m"] / (hi[2] - lo[2])
    obj.location = (-(lo[0] + hi[0]) / 2 * k, -(lo[1] + hi[1]) / 2 * k, -lo[2] * k)
    obj.scale = (k, k, k)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    co = C.world_coords(obj)
    tris = C.triangles(obj)
    height = float(co[:, 2].max())
    grip = None
    if handheld:
        zg = args["grip_frac"] * height
        half = args["grip_half_frac"] * height
        grip = measure_grip(co, tris, zg - half, zg + half, height)
        if grip is None:
            pivot, s = (0.0, 0.0, 0.0), 1.0
        else:
            pivot, s = (grip["centre"][0], grip["centre"][1], zg), args["grip_diameter_m"] / grip["diameter"]
    else:
        foot = co[co[:, 2] < 0.02 * height]
        pivot, s = (float(foot[:, 0].mean()), float(foot[:, 1].mean()), 0.0), 1.0
    for v in obj.data.vertices:
        v.co = (v.co - Vector(pivot)) * s
    obj.data.update()
    t.mark("normalise")

    M.decimate(obj, args["target_tris"])
    projections, sil = M.fit_projections(obj, views, view_masks)
    t.mark("silhouettes")
    M.unwrap(obj)
    size, density, coverage = fit_texel_density(obj, args["texel_density"], args["texture_sizes"])
    M.bake(obj, projections, size, args["out_albedo"])
    tex = M.texture_checks(projections)
    t.mark("bake")

    name = args["name"]
    obj.name = obj.data.name = name
    hull, hull_points, hull_scale = hull_object(obj, f"{name}Collision-convcolonly", b["maxHullPoints"])
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    hull.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=args["out_glb"], export_format="GLB", use_selection=True,
        export_yup=True, export_texcoords=True, export_normals=True,
        export_materials="EXPORT", export_image_format="AUTO", export_animations=False,
    )
    t.mark("export")

    final = C.mesh_stats(obj)
    co = C.world_coords(obj)
    lo, hi = co.min(0), co.max(0)
    length = float(hi[2] - lo[2])
    mats = len([m for m in obj.data.materials if m])
    ref, tol = b["texelDensity"]["ref"], b["texelDensity"]["tolerance"]
    t_lo, t_hi = b["triangles"]
    s_lo, s_hi = b["sizeM"]
    x_lo, x_hi = b["textureSize"]
    checks = [
        C.check("prop.triangles", t_lo <= final["triangles"] <= t_hi, final["triangles"], [t_lo, t_hi]),
        C.check("prop.size_m", s_lo <= length <= s_hi, round(length, 4), [s_lo, s_hi],
                "length along the handle" if handheld else "height"),
        C.check("prop.texture.size", x_lo <= size <= x_hi and size & (size - 1) == 0, size, [x_lo, x_hi], "power of two"),
        C.check("prop.materials", mats <= b["maxMaterials"], mats, b["maxMaterials"]),
        C.check("prop.texel_density", abs(density - ref) <= tol * ref, round(density, 1), [round(ref * (1 - tol), 1), round(ref * (1 + tol), 1)],
                f"albedo px per metre of surface; UV coverage {coverage:.3f} of the {size}² texture"),
        C.check("prop.components", len(final["components"]) == 1, len(final["components"]), 1, advisory=True),
        C.check("prop.non_manifold", final["non_manifold_edges"] == 0, final["non_manifold_edges"], 0, advisory=True),
        C.check("prop.hull.points", hull_points <= b["maxHullPoints"], hull_points, b["maxHullPoints"],
                f"convex collision hull, grown x{hull_scale:.3f} to contain the mesh"),
    ]
    if handheld:
        checks.append(C.check("prop.grip.found", grip is not None, grip["slices"] if grip else 0, GRIP_SLICES,
                              "surface crossings inside the grip box"))
        if grip is not None:
            checks.append(C.check("prop.grip.single_part", grip["parts"] == 1, grip["parts"], 1,
                                  "the grip box crosses the handle only (not a guard, head or blade beside it)"))
    for view, score in sil.items():
        limit = b["minSilhouetteIoU"][view]
        checks.append(C.check(f"prop.silhouette.{view}", score >= limit, score, limit, "mesh outline vs sheet view"))
    C.write_report(args, {
        "raw": {**{k: (v[:5] if k == "components" else v) for k, v in raw.items()}, "spike_faces": spikes},
        "final": {**{k: (v[:5] if k == "components" else v) for k, v in final.items()},
                  "size_m": round(length, 4), "texture_size": size, "texel_density": round(density, 1),
                  "bbox": [[round(float(x), 4) for x in lo], [round(float(x), 4) for x in hi]]},
        "turned_180": turned,
        "grip": grip, "grip_scale": round(s, 4), "ruler_size_m": args["size_m"],
        "hull": {"points": hull_points, "scale": round(hull_scale, 4)},
        "silhouette_iou": sil,
        "texture_vs_sheet": tex,
        "checks": checks,
        "timings": t.marks,
    })


if __name__ == "__main__":
    main()
