"""Step 5 (Unreal) — AnimClip → FBX on a UE5 mannequin skeleton.

args: anim_blend, manny (scripts/game/unreal/manny.json), manny_ref (scripts/game/unreal/manny_ref.json),
      clips (action names), out_fbx, report, budget

The rig keeps Godot's humanoid bones; this rebuilds the same character on the
UE5 mannequin's bone names and parent chain (a subset of SK_Mannequin), so in
Unreal the mesh can share Manny's Skeleton asset and Manny-targeted animation
plays on it. Our one spine chain (Spine, Chest, UpperChest) becomes Manny's
five spine bones and the neck becomes two, spread evenly along it; their
weights and motion are split from the source by position along the chain.
Every clip is re-baked onto the new skeleton in world space, so it is the same
motion, and exported as its own FBX take. Then: at most 4 influences, each
clip's edge stretch re-measured on the new weights, FBX export, and the FBX
read back to check what landed in it (bones, frames per take, height).
"""
import json
import os
import sys

import bpy
import numpy as np
from bpy_extras import anim_utils
from mathutils import Matrix, Quaternion, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402
import rig as R  # noqa: E402


def polyline(points):
    p = np.array(points, dtype=float)
    seg = np.linalg.norm(np.diff(p, axis=0), axis=1)
    return p, np.concatenate([[0.0], np.cumsum(seg)]) / max(seg.sum(), 1e-9)


def at(p, s, t):
    """Point at arc fraction t along polyline (p, s)."""
    i = int(np.clip(np.searchsorted(s, t, side="right") - 1, 0, len(s) - 2))
    f = (t - s[i]) / max(s[i + 1] - s[i], 1e-9)
    return p[i] + f * (p[i + 1] - p[i])


def project(p, s, q):
    """Arc fraction of the polyline point nearest each row of q."""
    best_d = np.full(len(q), np.inf)
    best_t = np.zeros(len(q))
    for i in range(len(p) - 1):
        a, b = p[i], p[i + 1]
        ab = b - a
        u = np.clip(((q - a) @ ab) / max(ab @ ab, 1e-12), 0, 1)
        d = np.linalg.norm(q - (a + u[:, None] * ab), axis=1)
        better = d < best_d
        best_d[better] = d[better]
        best_t[better] = s[i] + u[better] * (s[i + 1] - s[i])
    return best_t


def to_centimeters(arm, mesh, actions):
    """Scene unit 1 cm; armature, mesh and the actions' location keys 100x."""
    bpy.context.scene.unit_settings.scale_length = 0.01
    world = mesh.matrix_world.copy()
    mesh.parent = None
    mesh.matrix_world = world
    for ob in (arm, mesh):
        bpy.ops.object.select_all(action="DESELECT")
        ob.select_set(True)
        bpy.context.view_layer.objects.active = ob
        ob.scale = (100, 100, 100)
        ob.location = ob.location * 100
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    for act in actions:
        for slot in act.slots:
            bag = anim_utils.action_get_channelbag_for_slot(act, slot)
            for fc in (bag.fcurves if bag else []):
                if fc.data_path.endswith(".location"):
                    for kp in fc.keyframe_points:
                        kp.co.y *= 100
                        kp.handle_left.y *= 100
                        kp.handle_right.y *= 100
                    fc.update()
    mesh.parent = arm  # both now at identity: no parent inverse needed
    for m in mesh.modifiers:
        if m.type == "ARMATURE":
            m.object = arm


def main():
    args = C.load_args()
    b = args["budget"]
    t = C.Timer()
    bpy.ops.wm.open_mainfile(filepath=args["anim_blend"])
    with open(args["manny"]) as f:
        spec = json.load(f)
    src = bpy.data.objects["Skeleton"]
    mesh = bpy.data.objects["Character"]
    sb = src.data.bones
    mw = src.matrix_world

    def head(n):
        return np.array(mw @ sb[n].head_local)

    def tail(n):
        return np.array(mw @ sb[n].tail_local)

    # ── Chains: polyline through the source bones, target bones spread along it.
    chains = {}
    for cname, c in spec["chains"].items():
        pts = [head(n) for n in c["from"]] + [tail(c["from"][-1])]
        p, s = polyline(pts)
        # Source bone j spans arc [s_j, s_j+1]; its centre carries its motion.
        chains[cname] = {"p": p, "s": s, "src": c["from"], "n": c["count"],
                         "src_centres": (s[:-1] + s[1:]) / 2}

    # ── Target armature, placed at our joints.
    data = bpy.data.armatures.new("Armature")
    tgt = bpy.data.objects.new("Armature", data)  # Unreal drops an FBX node named "Armature"
    bpy.context.scene.collection.objects.link(tgt)
    bpy.context.view_layer.objects.active = tgt
    bpy.ops.object.mode_set(mode="EDIT")
    eb = data.edit_bones
    H = float(max(v.co.z for v in mesh.data.vertices))
    for bone in spec["bones"]:
        e = eb.new(bone["name"])
        if "chain" in bone:
            c = chains[bone["chain"]]
            k, n = bone["index"], c["n"]
            e.head = Vector(at(c["p"], c["s"], k / n))
            e.tail = Vector(at(c["p"], c["s"], (k + 1) / n))
        elif bone["from"] == "Root":
            e.head, e.tail = (0, 0, 0), (0, 0.1 * H, 0)
        else:
            e.head, e.tail = Vector(head(bone["from"])), Vector(tail(bone["from"]))
        if bone["parent"]:
            e.parent = eb[bone["parent"]]
    # Bone orientations: Manny's, each turned only so it points along our limb.
    # Animation is stored as local rotations, so a Manny clip only drives our
    # bones like his if each of our bones has his local axes; matching names
    # alone twists limbs. Measured on an import into Unreal 5.8 with the export
    # settings below: R_unreal = M @ R_blender @ M for every bone, M = diag(1, -1, 1)
    # (Unreal's left-handed axes), so the Blender rest is M @ R_target @ M.
    with open(args["manny_ref"]) as f:
        ref = json.load(f)["bones"]
    M = Matrix(((1, 0, 0), (0, -1, 0), (0, 0, 1)))

    def ue_rot(name):
        x, y, z, w = ref[name]["q"]
        return Quaternion((w, x, y, z)).to_matrix()

    # The turn takes Manny's bone-to-child vector onto ours (pelvis → spine_01,
    # foot → ball, …). A bone's X axis is not always that vector: Manny's foot X
    # points up the shin, so aligning X to our foot → toe direction tipped the
    # foot 65° under his walk. End bones (head, hands, balls) have no child here
    # and align his X axis, in the same sense, with our bone.
    kids = {x["name"]: [y["name"] for y in spec["bones"] if y["parent"] == x["name"]] for x in spec["bones"]}
    along = {}  # +1 where Manny's X axis points from the bone to its child, -1 where back (his right side)
    for bone in spec["bones"]:
        n = bone["name"]
        if kids[n]:
            d = Vector(ref[kids[n][0]]["t"]) - Vector(ref[n]["t"])
            along[n] = 1.0 if (ue_rot(n) @ Vector((1, 0, 0))).dot(d) >= 0 else -1.0
        else:
            along[n] = along.get(bone["parent"], 1.0)
    for bone in spec["bones"]:
        n = bone["name"]
        e = eb[n]
        e.use_connect = False
        if n == "root":
            continue
        if kids[n]:
            ours = (M @ (eb[kids[n][0]].head - e.head)).normalized()          # Unreal axes
            his = (Vector(ref[kids[n][0]]["t"]) - Vector(ref[n]["t"])).normalized()
        else:
            ours = (M @ (e.tail - e.head)).normalized()
            his = along[n] * (ue_rot(n) @ Vector((1, 0, 0)))
        target = his.rotation_difference(ours).to_matrix() @ ue_rot(n)
        rest = (M @ target @ M).to_4x4()
        rest.translation = e.head
        e.matrix = rest
    bpy.ops.object.mode_set(mode="OBJECT")
    order = [x["name"] for x in spec["bones"]]
    by_name = {x["name"]: x for x in spec["bones"]}
    t.mark("skeleton")

    # ── Weights: 1:1 bones copy, chain bones split by position along the chain.
    co = C.world_coords(mesh)
    names = {g.index: g.name for g in mesh.vertex_groups}
    W = np.zeros((len(co), len(order)))
    col = {n: i for i, n in enumerate(order)}
    src_w = {n: np.zeros(len(co)) for n in names.values()}
    for v in mesh.data.vertices:
        for g in v.groups:
            src_w[names[g.group]][v.index] = g.weight
    for bone in spec["bones"]:
        if "from" in bone and bone["from"] in src_w:
            W[:, col[bone["name"]]] += src_w[bone["from"]]
    for cname, c in chains.items():
        total = sum(src_w.get(n, 0) for n in c["src"])
        if not np.any(total):
            continue
        n = c["n"]
        tv = np.clip(project(c["p"], c["s"], co), 0.5 / n, 1 - 0.5 / n)
        centres = (np.arange(n) + 0.5) / n
        hat = np.clip(1 - np.abs(tv[:, None] - centres[None, :]) * n, 0, None)
        hat /= hat.sum(1, keepdims=True)
        for bone in spec["bones"]:
            if bone.get("chain") == cname:
                W[:, col[bone["name"]]] += total * hat[:, bone["index"]]
    for g in list(mesh.vertex_groups):
        mesh.vertex_groups.remove(g)
    for n in order:
        mesh.vertex_groups.new(name=n)
    for j, n in enumerate(order):
        g = mesh.vertex_groups[n]
        for i in np.nonzero(W[:, j] > 1e-4)[0]:
            g.add([int(i)], float(W[i, j]), "REPLACE")
    R.limit_by_hierarchy(mesh, tgt, 4, 0.01)
    t.mark("weights")

    # ── Motion: world-space rotation change of the source bone(s), per frame.
    src_rest = {x.name: (mw.to_3x3() @ x.matrix_local.to_3x3()).normalized() for x in sb}
    tgt_rest = {x.name: x.matrix_local.copy() for x in tgt.data.bones}   # tgt at identity
    rel = {n: (tgt_rest[by_name[n]["parent"]].inverted() @ tgt_rest[n]) if by_name[n]["parent"] else tgt_rest[n]
           for n in order}
    scene = bpy.context.scene
    tgt.animation_data_create()
    for pb in tgt.pose.bones:
        pb.rotation_mode = "QUATERNION"
    hips_rest = Vector(head("Hips"))
    baked = {}  # clip name -> (target action, first frame, last frame)
    for clip in args["clips"]:
        sa = bpy.data.actions[clip]
        src.animation_data.action = sa
        if src.animation_data.action_slot is None and sa.slots:
            src.animation_data.action_slot = sa.slots[0]
        f0, f1 = (int(x) for x in sa.frame_range)
        ta = bpy.data.actions.new(f"ue.{clip}")  # renamed to the clip once the source actions are gone
        tgt.animation_data.action = ta
        for fr in range(f0, f1 + 1):
            scene.frame_set(fr)
            delta = {}
            for pb in src.pose.bones:
                m = (mw @ pb.matrix).to_3x3().normalized()
                delta[pb.name] = (m @ src_rest[pb.name].inverted()).to_quaternion()
            hips_pos = mw @ src.pose.bones["Hips"].head
            posed = {}
            for n in order:
                bone = by_name[n]
                if "chain" in bone:
                    c = chains[bone["chain"]]
                    ctr = (bone["index"] + 0.5) / c["n"]
                    sc = c["src_centres"]
                    j = int(np.clip(np.searchsorted(sc, ctr) - 1, 0, max(len(sc) - 2, 0)))
                    if len(sc) == 1:
                        d = delta[c["src"][0]]
                    else:
                        f = float(np.clip((ctr - sc[j]) / (sc[j + 1] - sc[j]), 0, 1))
                        d = delta[c["src"][j]].slerp(delta[c["src"][j + 1]], f)
                elif bone["from"] == "Root":
                    d = None
                else:
                    d = delta[bone["from"]]
                parent_world = posed[bone["parent"]] if bone["parent"] else Matrix.Identity(4)
                base = parent_world @ rel[n]                       # where the bone sits if it doesn't rotate
                if d is None:
                    want = base
                else:
                    rot = (d.to_matrix() @ tgt_rest[n].to_3x3()).to_4x4()
                    loc = base.translation
                    if n == "pelvis":
                        loc = tgt_rest[n].translation + (hips_pos - hips_rest)
                    want = Matrix.Translation(loc) @ rot
                posed[n] = want
                pb = tgt.pose.bones[n]
                basis = base.inverted() @ want
                pb.location = basis.translation
                pb.rotation_quaternion = basis.to_quaternion()
                pb.keyframe_insert("rotation_quaternion", frame=fr)
                if n == "pelvis":
                    pb.keyframe_insert("location", frame=fr)
        ta.use_fake_user = True
        ta.use_frame_range = True
        ta.frame_start, ta.frame_end = f0, f1
        baked[clip] = (ta, f0, f1)
    t.mark("bake")

    # ── Swap the deforming armature, drop the source rig and its actions.
    world = mesh.matrix_world.copy()
    mesh.parent = tgt
    mesh.matrix_world = world
    for m in mesh.modifiers:
        if m.type == "ARMATURE":
            m.object = tgt
    bpy.data.objects.remove(src)
    keep = {ta for ta, _, _ in baked.values()}
    for a in list(bpy.data.actions):
        if a not in keep:
            bpy.data.actions.remove(a)
    for clip, (ta, _, _) in baked.items():
        ta.name = clip

    # Stretch over every clip on the new weights (same measure as anim.<clip>.edge_stretch).
    edges = R.edge_array(mesh)
    tgt.data.pose_position = "REST"
    bpy.context.view_layer.update()
    rest_co = R.evaluated_coords(mesh)
    tgt.data.pose_position = "POSE"
    stretch = {}
    for clip, (ta, f0, f1) in baked.items():
        tgt.animation_data.action = ta
        stretch[clip] = 0.0
        for fr in range(f0, f1 + 1):
            scene.frame_set(fr)
            s_max, _ = R.stretch(rest_co, R.evaluated_coords(mesh), edges)
            stretch[clip] = max(stretch[clip], s_max)
    # Export from the rest pose with no action active: the exporter bakes every
    # action as its own take regardless, and Unreal rebuilds a bind pose it
    # finds inconsistent from the scene's time-zero pose, which must then be the rest.
    tgt.animation_data.action = None
    for pb in tgt.pose.bones:
        pb.location, pb.rotation_quaternion, pb.scale = (0, 0, 0), (1, 0, 0, 0), (1, 1, 1)
    scene.frame_set(0)
    # Texture: written next to the FBX and referenced by file name.
    out_dir = os.path.dirname(args["out_fbx"])
    base = os.path.splitext(os.path.basename(args["out_fbx"]))[0]
    for slot in mesh.material_slots:
        for node in (slot.material.node_tree.nodes if slot.material and slot.material.node_tree else []):
            if node.type == "TEX_IMAGE" and node.image:
                node.image.filepath_raw = os.path.join(out_dir, f"{base}_albedo.png")
                node.image.file_format = "PNG"
                node.image.save()
    table = R.weights_table(mesh)
    infl = max(len(w) for w in table)
    unweighted = sum(1 for w in table if sum(x for _, x in w) < 1e-6)
    t.mark("tests")

    mesh.name = "Character"
    # Centimeters, in the data itself: exported in meters, Unreal put the 100x on
    # the root bone (scale 100, every local translation in meters). Animation
    # retargeting reads those local lengths, so a Manny clip collapsed our
    # skeleton to 1% of its size. Scene unit = 1 cm, objects scaled 100x and
    # applied, location keys scaled too (the only translated bone is the pelvis).
    to_centimeters(tgt, mesh, [ta for ta, _, _ in baked.values()])
    # Mesh and animations go in separate files (the usual Unreal hand-off: one
    # skeletal mesh FBX, one FBX per clip imported onto its skeleton). Unreal 5.8's
    # Interchange reads Blender's bind pose as invalid and rebinds the skin to the
    # scene's time-zero pose, which in a file with takes is the first take's first
    # frame: the farmer's mesh got bound in his idle pose (11-33 cm off). In a
    # file with no takes, time zero is the rest pose.
    fbx_opts = dict(
        use_selection=True, apply_unit_scale=True, apply_scale_options="FBX_SCALE_NONE",
        axis_forward="-Z", axis_up="Y", add_leaf_bones=False, primary_bone_axis="Y", secondary_bone_axis="X",
        use_armature_deform_only=False, armature_nodetype="NULL",
    )
    bpy.ops.object.select_all(action="DESELECT")
    tgt.select_set(True)
    mesh.select_set(True)
    bpy.context.view_layer.objects.active = tgt
    bpy.ops.export_scene.fbx(
        filepath=args["out_fbx"], object_types={"ARMATURE", "MESH"}, use_mesh_modifiers=False,
        mesh_smooth_type="FACE", bake_anim=False,
        # The texture goes next to the FBX, not inside it: Unreal 5.8's Interchange
        # FBX reader fails on Blender's embedded textures ("couldn't retrieve a payload").
        path_mode="STRIP", embed_textures=False, **fbx_opts,
    )
    stem = os.path.splitext(args["out_fbx"])[0]
    anim_files = {}
    mesh.select_set(False)
    for clip, (ta, f0, f1) in baked.items():
        tgt.animation_data.action = ta
        scene.frame_start, scene.frame_end = f0, f1
        anim_files[clip] = f"{stem}_{clip.removesuffix('-loop')}.fbx"
        bpy.ops.export_scene.fbx(
            filepath=anim_files[clip], object_types={"ARMATURE"}, bake_anim=True,
            bake_anim_use_all_actions=False, bake_anim_use_nla_strips=False, bake_anim_force_startend_keying=True,
            bake_anim_step=1.0, bake_anim_simplify_factor=0.0, **fbx_opts,
        )
    t.mark("export")

    # Read them back: names, parents and height from the mesh file, frames from each clip file.
    C.reset_scene()
    bpy.ops.import_scene.fbx(filepath=args["out_fbx"])
    arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]
    got = {x.name: (x.parent.name if x.parent else None) for x in arms[0].data.bones} if arms else {}
    want_parents = {x["name"]: x["parent"] for x in spec["bones"]}
    wrong_parent = sorted(n for n, p in want_parents.items() if got.get(n, "<missing>") != p)
    extra = sorted(set(got) - set(want_parents))
    meshes = C.mesh_objects()
    height = float(C.world_coords(meshes[0])[:, 2].max() - C.world_coords(meshes[0])[:, 2].min()) if meshes else 0.0
    mesh_takes = len(bpy.data.actions)
    frames = {}
    for clip, path in anim_files.items():
        C.reset_scene()
        bpy.ops.import_scene.fbx(filepath=path)
        acts = list(bpy.data.actions)
        frames[clip] = int(round(acts[0].frame_range[1] - acts[0].frame_range[0])) + 1 if len(acts) == 1 else 0
    want_frames = {clip: f1 - f0 + 1 for clip, (_, f0, f1) in baked.items()}
    bad_frames = [c for c, n in want_frames.items() if frames.get(c) != n]
    checks = [
        C.check("unreal.bones.hierarchy", not wrong_parent and not extra, len(got), len(want_parents),
                f"wrong/missing: {', '.join(wrong_parent)}" if wrong_parent else
                (f"unexpected: {', '.join(extra)}" if extra else "UE5 mannequin names and parent chain")),
        C.check("unreal.mesh.no_takes", mesh_takes == 0, mesh_takes, 0,
                "the mesh file carries no animation, so Unreal binds the skin in the rest pose"),
        C.check("unreal.clip.frames", not bad_frames, sum(frames.values()), sum(want_frames.values()),
                "frames per clip file: " + ", ".join(f"{c} {frames.get(c, 0)}/{n}" for c, n in want_frames.items())),
        C.check("unreal.skin.unweighted", unweighted == 0, unweighted, 0),
        C.check("unreal.skin.max_influences", infl <= b["maxInfluences"], infl, b["maxInfluences"]),
        C.check("unreal.fbx.height", abs(height - H) <= 0.02 * H, round(height, 4), round(H, 4),
                "mesh height read back from the FBX vs the rig's, meters (Blender's FBX reader applies the unit scale)"),
    ] + [
        C.check(f"unreal.{clip.removesuffix('-loop')}.edge_stretch", s <= b["maxEdgeStretch"], round(s, 3), b["maxEdgeStretch"],
                "worst edge stretch over the clip on the UE skeleton's weights")
        for clip, s in stretch.items()
    ]
    C.write_report(args, {"bones": order,
                          "clips": [{"name": c, "frames": n, "fbx_frames": frames.get(c, 0), "fbx": anim_files[c]}
                                    for c, n in want_frames.items()],
                          "fbx_bones": got, "checks": checks, "timings": t.marks,
                          # Rest frames in Blender space (armature at identity): how the export maps to Unreal.
                          "rest": {n: [list(r) for r in tgt_rest[n]] for n in order}})


if __name__ == "__main__":
    main()
