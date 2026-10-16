"""Step 2b — raw image-to-3D output → game-ready static Mesh.

args: raw (glb), views {front, side, back: png path}, height_m, target_tris,
      texture_size, out_glb, preview_dir, report

1. join, drop floaters (components under 1% of the vertices)
2. orient: the side view decides which way the character faces (-Y in Blender)
3. normalise: feet at z=0, centred on x/y, scaled to height_m
4. decimate to target_tris, smart-UV unwrap
5. texture: orthographic projection of the three sheet views, blended by face
   normal, baked into one albedo map (the sheet is the only source of colour,
   so the back of the mesh shows the drawn back, never a hallucinated one)
6. silhouette IoU of the mesh against each sheet view (back-side / view drift)
"""
import math
import os
import sys

import bmesh
import bpy
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

RES = 256          # silhouette comparison grid
FILL = 0.9         # figure height as a fraction of the comparison window
SHIFT = 4          # silhouette alignment search around the centroid match, +/- grid px


def projected(co, view):
    if view == "front":
        return np.stack([co[:, 0], co[:, 2]], 1)
    if view == "back":
        return np.stack([-co[:, 0], co[:, 2]], 1)
    return np.stack([co[:, 1], co[:, 2]], 1)  # side: left profile, screen-right = +Y


def mesh_silhouette(co, tris, view):
    p = projected(co, view)
    lo, hi = p.min(0), p.max(0)
    height = hi[1] - lo[1]
    size = height / FILL
    cu = (lo[0] + hi[0]) / 2
    bounds = (cu - size / 2, lo[1] - (size - height) / 2, size)
    return C.rasterize(p, tris, RES, bounds), {"cu": float(cu), "v0": float(lo[1]), "height": float(height)}


def view_silhouette(rgba):
    x0, y0, x1, y1 = C.alpha_bbox(rgba)
    hp = y1 - y0
    size = hp / FILL
    cx = (x0 + x1) / 2
    gx = cx - size / 2 + (np.arange(RES) + 0.5) * size / RES
    gy = y0 - (size - hp) / 2 + (np.arange(RES) + 0.5) * size / RES
    ix, iy = np.meshgrid(gx.astype(np.int64), gy.astype(np.int64))
    inside = (ix >= 0) & (iy >= 0) & (ix < rgba.shape[1]) & (iy < rgba.shape[0])
    mask = np.zeros((RES, RES), dtype=bool)
    mask[inside] = rgba[iy[inside], ix[inside], 3] > 0.5
    return mask, {"cx": float(cx), "y0": float(y0), "hp": float(hp), "size_px": float(size)}


def best_alignment(mesh_mask, view_mask):
    """(IoU, dx, dy): shift of the view mask that best overlays the mesh mask.
    Starts from the centroid match, then searches +/- SHIFT around it."""
    def centroid(m):
        ys, xs = np.nonzero(m)
        return (xs.mean(), ys.mean()) if len(xs) else (0.0, 0.0)
    (mx, my), (vx, vy) = centroid(mesh_mask), centroid(view_mask)
    cx, cy = int(round(mx - vx)), int(round(my - vy))
    best = (-1.0, 0, 0)
    for dy in range(cy - SHIFT, cy + SHIFT + 1):
        for dx in range(cx - SHIFT, cx + SHIFT + 1):
            shifted = np.roll(np.roll(view_mask, dy, 0), dx, 1)
            s = C.iou(mesh_mask, shifted)
            if s > best[0]:
                best = (s, dx, dy)
    return best


def dilate_rgba(rgba, iterations=48):
    """Push opaque colours outward into transparent pixels so projections never sample the background."""
    rgb = rgba[:, :, :3].copy()
    known = rgba[:, :, 3] > 0.5
    rgb[~known] = 0
    for _ in range(iterations):
        if known.all():
            break
        acc = np.zeros_like(rgb)
        cnt = np.zeros(known.shape, dtype=np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            k = np.roll(np.roll(known, dy, 0), dx, 1)
            acc += np.roll(np.roll(rgb, dy, 0), dx, 1) * k[:, :, None]
            cnt += k
        grow = (~known) & (cnt > 0)
        rgb[grow] = acc[grow] / cnt[grow][:, None]
        known = known | grow
    out = np.ones_like(rgba)
    out[:, :, :3] = rgb
    return out


def new_image(name, rgba):
    h, w = rgba.shape[:2]
    img = bpy.data.images.new(name, w, h, alpha=True)
    img.pixels.foreach_set(rgba.astype(np.float32).ravel())
    return img


def build_projection_material(obj, projections, bake_img):
    """Emission shader = normal-weighted blend of the three orthographic projections."""
    mat = bpy.data.materials.new("projection")
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    N = nt.nodes.new
    L = nt.links.new

    tex = N("ShaderNodeTexCoord")
    pos = N("ShaderNodeSeparateXYZ")
    L(tex.outputs["Object"], pos.inputs[0])
    geo = N("ShaderNodeNewGeometry")
    nrm = N("ShaderNodeSeparateXYZ")
    L(geo.outputs["True Normal"], nrm.inputs[0])

    def math(op, a, b=None, c=None):
        m = N("ShaderNodeMath")
        m.operation = op
        for i, x in enumerate((a, b, c)):
            if x is None:
                continue
            if isinstance(x, (int, float)):
                m.inputs[i].default_value = x
            else:
                L(x, m.inputs[i])
        return m.outputs[0]

    axis = {"x": pos.outputs[0], "y": pos.outputs[1], "z": pos.outputs[2]}
    colors, weights = [], []
    for p in projections:
        u = math("MULTIPLY_ADD", axis[p["u_axis"]], p["ku"], p["bu"])
        v = math("MULTIPLY_ADD", axis["z"], p["kv"], p["bv"])
        vec = N("ShaderNodeCombineXYZ")
        L(u, vec.inputs[0])
        L(v, vec.inputs[1])
        img = N("ShaderNodeTexImage")
        img.image = p["image"]
        img.extension = "EXTEND"
        img.interpolation = "Linear"
        L(vec.outputs[0], img.inputs[0])
        colors.append(img.outputs["Color"])
        comp = {"front": nrm.outputs[1], "back": nrm.outputs[1], "side": nrm.outputs[0]}[p["view"]]
        if p["view"] == "front":
            facing = math("MAXIMUM", math("MULTIPLY", comp, -1.0), 0.0)
        elif p["view"] == "back":
            facing = math("MAXIMUM", comp, 0.0)
        else:
            facing = math("ABSOLUTE", comp)
        weights.append(math("ADD", math("POWER", facing, 4.0), 1e-4))

    total = math("ADD", math("ADD", weights[0], weights[1]), weights[2])
    acc = None
    for col, w in zip(colors, weights):
        scaled = N("ShaderNodeVectorMath")
        scaled.operation = "SCALE"
        L(col, scaled.inputs[0])
        L(math("DIVIDE", w, total), scaled.inputs["Scale"])
        if acc is None:
            acc = scaled.outputs[0]
        else:
            add = N("ShaderNodeVectorMath")
            add.operation = "ADD"
            L(acc, add.inputs[0])
            L(scaled.outputs[0], add.inputs[1])
            acc = add.outputs[0]
    emit = N("ShaderNodeEmission")
    L(acc, emit.inputs["Color"])
    out = N("ShaderNodeOutputMaterial")
    L(emit.outputs[0], out.inputs["Surface"])
    target = N("ShaderNodeTexImage")
    target.image = bake_img
    nt.nodes.active = target
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    return mat


def final_material(obj, albedo):
    mat = bpy.data.materials.new("character")
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Metallic"].default_value = 0.0
    bsdf.inputs["Roughness"].default_value = 0.85
    img = nt.nodes.new("ShaderNodeTexImage")
    img.image = albedo
    nt.links.new(img.outputs["Color"], bsdf.inputs["Base Color"])
    obj.data.materials.clear()
    obj.data.materials.append(mat)


def main():
    args = C.load_args()
    t = C.Timer()
    C.reset_scene()
    C.import_glb(args["raw"])
    obj = C.join_meshes()
    raw = C.mesh_stats(obj)
    t.mark("import")

    # Spikes: marching-cubes output can carry a few huge triangles reaching to a
    # far vertex; they wreck the bounding box (and so scaling and alignment).
    # Then floaters: keep components with at least 1% of the vertices.
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    lengths = np.array([e.calc_length() for e in bm.edges])
    spike_limit = 20 * float(np.median(lengths))
    spikes = [f for f in bm.faces if max(e.calc_length() for e in f.edges) > spike_limit]
    bmesh.ops.delete(bm, geom=spikes, context="FACES")
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context="VERTS")
    spike_count = len(spikes)
    keep_min = max(1, int(0.01 * len(bm.verts)))
    bm.verts.index_update()
    bm.verts.ensure_lookup_table()
    seen = set()
    drop = []
    for v in bm.verts:
        if v.index in seen:
            continue
        comp, stack = [], [v]
        seen.add(v.index)
        while stack:
            a = stack.pop()
            comp.append(a)
            for e in a.link_edges:
                b = e.other_vert(a)
                if b.index not in seen:
                    seen.add(b.index)
                    stack.append(b)
        if len(comp) < keep_min:
            drop.extend(comp)
    bmesh.ops.delete(bm, geom=drop, context="VERTS")
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bm.to_mesh(obj.data)
    bm.free()
    t.mark("floaters")

    views = {k: C.load_image_rgba(p) for k, p in args["views"].items()}
    view_masks = {k: view_silhouette(v) for k, v in views.items()}

    # Orientation: the side view is a left profile facing screen-left (-Y when the
    # character faces -Y). If the flipped mesh matches better, turn it 180 degrees.
    co = C.world_coords(obj)
    tris = C.triangles(obj)
    side_mask = view_masks["side"][0]
    score_as_is = best_alignment(mesh_silhouette(co, tris, "side")[0], side_mask)[0]
    flipped = co * np.array([-1, -1, 1])
    score_flip = best_alignment(mesh_silhouette(flipped, tris, "side")[0], side_mask)[0]
    turned = score_flip > score_as_is
    if turned:
        obj.rotation_euler = (0, 0, math.pi)
        bpy.ops.object.transform_apply(rotation=True)

    co = C.world_coords(obj)
    lo, hi = co.min(0), co.max(0)
    scale = args["height_m"] / (hi[2] - lo[2])
    obj.location = (-(lo[0] + hi[0]) / 2 * scale, -(lo[1] + hi[1]) / 2 * scale, -lo[2] * scale)
    obj.scale = (scale, scale, scale)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    t.mark("orient")

    # Decimate.
    obj.data.calc_loop_triangles()
    n_tris = len(obj.data.loop_triangles)
    if n_tris > args["target_tris"]:
        dec = obj.modifiers.new("decimate", "DECIMATE")
        dec.decimate_type = "COLLAPSE"
        dec.ratio = args["target_tris"] / n_tris
        dec.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=dec.name)
    tri = obj.modifiers.new("triangulate", "TRIANGULATE")
    bpy.ops.object.modifier_apply(modifier=tri.name)
    bpy.ops.object.shade_smooth()
    t.mark("decimate")

    # Silhouettes after decimation: these are the drift numbers that gate the mesh.
    co = C.world_coords(obj)
    tris = C.triangles(obj)
    projections = []
    sil = {}
    for name in ("front", "side", "back"):
        mmask, mgeo = mesh_silhouette(co, tris, name)
        vmask, vgeo = view_masks[name]
        score, dx, dy = best_alignment(mmask, vmask)
        sil[name] = round(score, 4)
        # Texture mapping: mesh (u, z) -> view pixel -> image UV, honouring the alignment shift.
        k = vgeo["hp"] / mgeo["height"]                 # px per meter
        px_per_cell = vgeo["size_px"] / RES
        shift_x, shift_y = -dx * px_per_cell, -dy * px_per_cell
        h_img, w_img = views[name].shape[:2]
        projections.append({
            "view": name,
            "u_axis": {"front": "x", "back": "x", "side": "y"}[name],
            "ku": (-k if name == "back" else k) / w_img,
            "bu": (vgeo["cx"] + shift_x - mgeo["cu"] * k) / w_img,
            "kv": k / h_img,
            "bv": (vgeo["y0"] + shift_y - mgeo["v0"] * k) / h_img,
            "image": new_image(f"view_{name}", dilate_rgba(views[name])),
        })
    t.mark("silhouettes")

    # UVs and bake.
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.004)
    bpy.ops.object.mode_set(mode="OBJECT")
    size = args["texture_size"]
    albedo = bpy.data.images.new("albedo", size, size, alpha=False)
    build_projection_material(obj, projections, albedo)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 1
    scene.render.bake.margin = 16
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.bake(type="EMIT")
    albedo.file_format = "PNG"
    albedo.filepath_raw = os.path.join(os.path.dirname(args["out_glb"]), "albedo.png")
    albedo.save()
    final_material(obj, albedo)
    t.mark("bake")

    obj.name = "Character"
    obj.data.name = "Character"
    bpy.ops.export_scene.gltf(
        filepath=args["out_glb"], export_format="GLB", use_selection=True,
        export_yup=True, export_texcoords=True, export_normals=True,
        export_materials="EXPORT", export_image_format="AUTO", export_animations=False,
    )
    t.mark("export")

    final = C.mesh_stats(obj)
    co = C.world_coords(obj)
    lo, hi = co.min(0), co.max(0)
    b = args["budget"]
    checks = [
        C.check("mesh.triangles.max", final["triangles"] <= b["maxTriangles"], final["triangles"], b["maxTriangles"]),
        C.check("mesh.triangles.min", final["triangles"] >= b["minTriangles"], final["triangles"], b["minTriangles"]),
        C.check("mesh.components", len(final["components"]) == 1, len(final["components"]), 1,
                "one connected surface (floaters and detached parts break skinning)"),
        C.check("mesh.non_manifold", final["non_manifold_edges"] == 0, final["non_manifold_edges"], 0, advisory=True),
        C.check("mesh.height", b["heightM"][0] <= hi[2] - lo[2] <= b["heightM"][1], float(hi[2] - lo[2]), b["heightM"]),
        C.check("mesh.texture.size", size <= b["maxTextureSize"], size, b["maxTextureSize"]),
    ]
    for name, score in sil.items():
        limit = b["minSilhouetteIoU"][name]
        checks.append(C.check(f"mesh.silhouette.{name}", score >= limit, score, limit,
                              "mesh outline vs sheet view (view drift / missing parts)"))
    C.write_report(args, {
        "raw": {**{k: (v[:5] if k == "components" else v) for k, v in raw.items()}, "spike_faces": spike_count},
        "final": {**{k: (v[:5] if k == "components" else v) for k, v in final.items()},
                  "height_m": round(float(hi[2] - lo[2]), 4), "texture_size": size},
        "turned_180": turned,
        "orientation_scores": {"as_is": round(score_as_is, 4), "flipped": round(score_flip, 4)},
        "silhouette_iou": sil,
        "checks": checks,
        "timings": t.marks,
    })


if __name__ == "__main__":
    main()
