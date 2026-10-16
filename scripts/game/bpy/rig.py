"""Step 3 — static Mesh → Skeleton (rigged mesh in A-pose).

args: mesh_glb, out_blend, out_glb, report, budget

The mesh contract from mesh_prepare (feet at z=0, facing -Y, A-pose, arms and
legs separated) makes joint placement a geometry problem: horizontal cross
sections of the surface give the leg columns, the crotch (where the legs merge),
the armpits (highest slice where the arms separate from the torso) and the arm
centre lines. Joint ratios along limbs follow standard human proportions.
Bone names follow Godot's SkeletonProfileHumanoid so Godot needs no BoneMap.

Weights: Blender bone heat on the welded mesh (glTF seam copies merged). When
it leaves vertices unweighted (self-intersecting or non-manifold input),
weights are solved on a voxel-remeshed proxy and transferred back. Then: side
and height fades per bone, world-space smoothing, at most 4 influences,
normalised.
"""
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402


class RigError(Exception):
    pass


def section(co, tris, z):
    """Cross-section of the surface at height z as segments, shape (N, 2, 3)."""
    a, b, c = co[tris[:, 0]], co[tris[:, 1]], co[tris[:, 2]]
    pts, hit = [], []
    for p, q in ((a, b), (b, c), (c, a)):
        dp, dq = p[:, 2] - z, q[:, 2] - z
        m = dp * dq < 0
        t = np.where(m, dp / np.where(m, dp - dq, 1), 0)
        pts.append(p + t[:, None] * (q - p))
        hit.append(m)
    pts, hit = np.stack(pts, 1), np.stack(hit, 1)
    two = hit.sum(1) == 2
    pts, hit = pts[two], hit[two]
    # The two crossed edges of each triangle, in edge order.
    first = np.argmax(hit, 1)
    second = 2 - np.argmax(hit[:, ::-1], 1)
    idx = np.arange(len(pts))
    return np.stack([pts[idx, first], pts[idx, second]], 1)


def intervals(segs, gap):
    """Union of the segments' x-extents: separate loops of the cross-section
    (legs, arms, torso) become separate intervals when more than `gap` apart."""
    if len(segs) == 0:
        return []
    x0 = segs[:, :, 0].min(1)
    x1 = segs[:, :, 0].max(1)
    order = np.argsort(x0)
    out = []
    cur = None
    for i in order:
        if cur is not None and x0[i] <= cur["x1"] + gap:
            cur["x1"] = max(cur["x1"], x1[i])
            cur["ys"].append(segs[i, :, 1])
            cur["xs"].append(segs[i, :, 0])
        else:
            cur = {"x0": x0[i], "x1": x1[i], "ys": [segs[i, :, 1]], "xs": [segs[i, :, 0]]}
            out.append(cur)
    for iv in out:
        ys, xs = np.concatenate(iv.pop("ys")), np.concatenate(iv.pop("xs"))
        iv.update({"cx": float((iv["x0"] + iv["x1"]) / 2), "y0": float(ys.min()), "y1": float(ys.max()),
                   "cy": float((ys.min() + ys.max()) / 2), "n": len(xs)})
    return out


def central(ivs):
    for iv in ivs:
        if iv["x0"] < 0 < iv["x1"]:
            return iv
    return None


def fit_line(points):
    """Least-squares line through 3D points: (centroid, unit direction)."""
    c = points.mean(0)
    _, _, vt = np.linalg.svd(points - c)
    return c, vt[0]


def estimate_joints(co, tris):
    H = float(co[:, 2].max())
    gap = 0.004 * H
    zs = np.linspace(0.02 * H, 0.97 * H, 300)
    secs = [(float(z), intervals(section(co, tris, z), gap)) for z in zs]
    found = {}

    # Crotch: lowest slice above the shins where one interval spans x = 0.
    seen_split = False
    z_crotch = None
    for z, ivs in secs:
        if z < 0.08 * H:
            continue
        mid = central(ivs)
        left = [iv for iv in ivs if iv["x0"] > 0]
        right = [iv for iv in ivs if iv["x1"] < 0]
        if mid is None and left and right:
            seen_split = True
        elif mid is not None and seen_split:
            z_crotch = z
            break
    if z_crotch is None:
        raise RigError("legs are not separated (no crotch found): fused legs, skirt or robe")
    found["crotch_z"] = z_crotch

    # Armpit: top of the longest run of slices showing arm | torso | arm. Taking
    # the first such slice from the top picks up anything sticking out beside
    # the head (pauldron spikes, ears, horns) as "arms".
    def arms_apart(ivs):
        mid = central(ivs)
        return bool(mid) and any(iv["x0"] > mid["x1"] for iv in ivs) and any(iv["x1"] < mid["x0"] for iv in ivs)

    best_run, run = (0, None), (0, None)
    for z, ivs in reversed(secs):
        if z < z_crotch:
            break
        if arms_apart(ivs):
            run = (run[0] + 1, run[1] if run[1] is not None else z)
            if run[0] > best_run[0]:
                best_run = run
        else:
            run = (0, None)
    z_armpit = best_run[1]
    if z_armpit is None or best_run[0] < 6:
        raise RigError("arms are not separated from the torso (no armpit found): not an A-pose")
    found["armpit_z"] = z_armpit

    joints = {}
    arm_info = {}
    for side, sgn in (("Left", 1.0), ("Right", -1.0)):
        # Arm centre line: outermost interval on this side, from the armpit down.
        centres = []
        for z, ivs in reversed(secs):
            if z > z_armpit:
                continue
            mine = sorted([iv for iv in ivs if sgn * iv["cx"] > 0 and not (iv["x0"] < 0 < iv["x1"])],
                          key=lambda iv: sgn * iv["cx"])
            mid = central(ivs)
            if mid is not None:
                outer = [iv for iv in mine if (iv["x0"] > mid["x1"] if sgn > 0 else iv["x1"] < mid["x0"])]
            else:
                outer = mine[1:] if len(mine) >= 2 else []
            if not outer:
                if centres:
                    break
                continue
            iv = outer[-1]
            centres.append((iv["cx"], iv["cy"], z))
        if len(centres) < 6:
            raise RigError(f"{side.lower()} arm too short to trace ({len(centres)} slices)")
        centres = np.array(centres)
        c, d = fit_line(centres)
        if d[2] > 0:
            d = -d                       # point down the arm
        if sgn * d[0] < 0:
            raise RigError(f"{side.lower()} arm does not point outward")
        # Hand tip: furthest surface point along the arm axis near the line.
        rel = co - c
        along = rel @ d
        radial = np.linalg.norm(rel - np.outer(along, d), axis=1)
        near = (radial < 0.06 * H) & (sgn * co[:, 0] > 0)
        tip = co[near][np.argmax(along[near])]
        z_sh = z_armpit + 0.035 * H
        t_sh = (z_sh - c[2]) / d[2]
        shoulder = c + t_sh * d
        arm_len = float(np.linalg.norm(tip - shoulder))
        wrist = tip - 0.25 * arm_len * d
        elbow = shoulder + 0.54 * (wrist - shoulder) + np.array([0, 0.008 * H, 0])
        joints[f"{side}UpperArm"] = shoulder
        joints[f"{side}LowerArm"] = elbow
        joints[f"{side}Hand"] = wrist
        joints[f"{side}Hand_tip"] = tip
        arm_info[side] = math.degrees(math.atan2(-d[2], abs(d[0])))

        # Leg column: interval on this side below the crotch.
        leg = []
        for z, ivs in secs:
            if not (0.1 * H < z < z_crotch):
                continue
            mine = sorted([iv for iv in ivs if sgn * iv["cx"] > 0], key=lambda iv: sgn * iv["cx"])
            if mine:
                leg.append((mine[0]["cx"], mine[0]["cy"], z))
        if len(leg) < 5:
            raise RigError(f"{side.lower()} leg too short to trace")
        leg = np.array(leg)
        top = leg[leg[:, 2] > np.percentile(leg[:, 2], 70)]
        hip = np.array([top[:, 0].mean(), top[:, 1].mean(), z_crotch + 0.03 * H])
        foot_pts = co[(co[:, 2] < 0.05 * H) & (sgn * co[:, 0] > 0)]
        if len(foot_pts) < 10:
            raise RigError(f"{side.lower()} foot not found near the ground")
        toe_y, heel_y = float(foot_pts[:, 1].min()), float(foot_pts[:, 1].max())
        foot_len = heel_y - toe_y
        z_ank = float(np.clip(0.28 * foot_len, 0.03 * H, 0.09 * H))
        low = leg[leg[:, 2] < np.percentile(leg[:, 2], 20)]
        ankle = np.array([low[:, 0].mean(), heel_y - 0.25 * foot_len, z_ank])
        ball = np.array([ankle[0], heel_y - 0.72 * foot_len, 0.3 * z_ank])
        toe = np.array([ankle[0], toe_y, 0.3 * z_ank])
        knee_z = (hip[2] + ankle[2]) / 2
        kl = leg[np.argmin(np.abs(leg[:, 2] - knee_z))]
        knee = np.array([kl[0], kl[1] - 0.01 * H, knee_z])
        joints[f"{side}UpperLeg"] = hip
        joints[f"{side}LowerLeg"] = knee
        joints[f"{side}Foot"] = ankle
        joints[f"{side}Toes"] = ball
        joints[f"{side}Toes_tip"] = toe

    # Spine: fixed fractions between the hips and the neck base (Mixamo-like proportions).
    def torso_y(z):
        _, ivs = min(secs, key=lambda s: abs(s[0] - z))
        mid = central(ivs)
        return float(mid["y0"] + 0.55 * (mid["y1"] - mid["y0"])) if mid else 0.0

    hip_z = (joints["LeftUpperLeg"][2] + joints["RightUpperLeg"][2]) / 2
    z_hips = hip_z + 0.01 * H
    z_sh = (joints["LeftUpperArm"][2] + joints["RightUpperArm"][2]) / 2
    z_neck = z_sh + 0.03 * H
    z_head = z_neck + 0.25 * (H - z_neck)
    hips_y = (joints["LeftUpperLeg"][1] + joints["RightUpperLeg"][1]) / 2
    for name, f in (("Spine", 0.23), ("Chest", 0.47), ("UpperChest", 0.73)):
        z = z_hips + f * (z_neck - z_hips)
        joints[name] = np.array([0.0, torso_y(z), z])
    joints["Hips"] = np.array([0.0, hips_y, z_hips])
    joints["Neck"] = np.array([0.0, torso_y(z_neck), z_neck])
    joints["Head"] = np.array([0.0, torso_y(z_head), z_head])
    joints["Head_tip"] = np.array([0.0, joints["Head"][1], H])
    for side, sgn in (("Left", 1.0), ("Right", -1.0)):
        sh = joints[f"{side}UpperArm"]
        joints[f"{side}Shoulder"] = np.array([0.3 * sh[0], joints["UpperChest"][1], z_sh + 0.01 * H])
    found["height"] = H
    return joints, arm_info, found


BONES = [
    # name, head joint, tail joint, parent, connected
    ("Hips", "Hips", "Spine", "Root", False),
    ("Spine", "Spine", "Chest", "Hips", True),
    ("Chest", "Chest", "UpperChest", "Spine", True),
    ("UpperChest", "UpperChest", "Neck", "Chest", True),
    ("Neck", "Neck", "Head", "UpperChest", True),
    ("Head", "Head", "Head_tip", "Neck", True),
]
for _s in ("Left", "Right"):
    BONES += [
        (f"{_s}Shoulder", f"{_s}Shoulder", f"{_s}UpperArm", "UpperChest", False),
        (f"{_s}UpperArm", f"{_s}UpperArm", f"{_s}LowerArm", f"{_s}Shoulder", True),
        (f"{_s}LowerArm", f"{_s}LowerArm", f"{_s}Hand", f"{_s}UpperArm", True),
        (f"{_s}Hand", f"{_s}Hand", f"{_s}Hand_tip", f"{_s}LowerArm", True),
        (f"{_s}UpperLeg", f"{_s}UpperLeg", f"{_s}LowerLeg", "Hips", False),
        (f"{_s}LowerLeg", f"{_s}LowerLeg", f"{_s}Foot", f"{_s}UpperLeg", True),
        (f"{_s}Foot", f"{_s}Foot", f"{_s}Toes", f"{_s}LowerLeg", True),
        (f"{_s}Toes", f"{_s}Toes", f"{_s}Toes_tip", f"{_s}Foot", True),
    ]


def build_armature(joints, H):
    data = bpy.data.armatures.new("Skeleton")
    arm = bpy.data.objects.new("Skeleton", data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    eb = data.edit_bones
    root = eb.new("Root")
    root.head = (0, 0, 0)
    root.tail = (0, 0.1 * H, 0)
    root.use_deform = False
    for name, h, t, parent, connected in BONES:
        b = eb.new(name)
        b.head = Vector(joints[h])
        b.tail = Vector(joints[t])
        b.parent = eb[parent]
        b.use_connect = connected
    bpy.ops.armature.select_all(action="SELECT")
    bpy.ops.armature.calculate_roll(type="GLOBAL_NEG_Y")
    root.roll = 0
    bpy.ops.object.mode_set(mode="OBJECT")
    return arm


def skin(obj, arm, H):
    """Bone heat; voxel-proxy fallback when vertices are left unweighted."""
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    method = "bone_heat"
    if unweighted(obj) > 0:
        method = "voxel_proxy"
        for g in list(obj.vertex_groups):
            obj.vertex_groups.remove(g)
        proxy = obj.copy()
        proxy.data = obj.data.copy()
        proxy.modifiers.clear()
        bpy.context.scene.collection.objects.link(proxy)
        rm = proxy.modifiers.new("remesh", "REMESH")
        rm.mode = "VOXEL"
        rm.voxel_size = 0.008 * H
        bpy.context.view_layer.objects.active = proxy
        bpy.ops.object.modifier_apply(modifier=rm.name)
        bpy.ops.object.select_all(action="DESELECT")
        proxy.select_set(True)
        arm.select_set(True)
        bpy.context.view_layer.objects.active = arm
        bpy.ops.object.parent_set(type="ARMATURE_AUTO")
        for b in arm.data.bones:
            if b.use_deform and b.name not in obj.vertex_groups:
                obj.vertex_groups.new(name=b.name)
        dt = obj.modifiers.new("weights", "DATA_TRANSFER")
        dt.object = proxy
        dt.use_vert_data = True
        dt.data_types_verts = {"VGROUP_WEIGHTS"}
        dt.vert_mapping = "POLYINTERP_NEAREST"
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.datalayout_transfer(modifier=dt.name)
        bpy.ops.object.modifier_move_to_index(modifier=dt.name, index=0)
        bpy.ops.object.modifier_apply(modifier=dt.name)
        bpy.data.objects.remove(proxy)
    # Lateral exclusivity: a limb bone may only pull vertices on its own side.
    # Bone heat leaks the far thigh into cloth hanging between the legs; with the
    # legs swinging in opposite directions that leak stretches aprons and skirts.
    # The cut is a linear fade across a midline band (0 at -band, 1 at +band on
    # the bone's side), not a step: a step at the midline is itself a seam
    # (measured 3.2x on an apron with a hard 2%-of-height band).
    band = 0.03 * H
    limbs = ("UpperArm", "LowerArm", "Hand", "UpperLeg", "LowerLeg", "Foot", "Toes")
    names = {g.index: g.name for g in obj.vertex_groups}
    side_of = {gi: (1.0 if n.startswith("Left") else -1.0) for gi, n in names.items()
               if n.startswith(("Left", "Right")) and n.endswith(limbs)}
    # Legs also fade out vertically, from the Hips joint (1) to the Chest joint
    # (0): bone heat let a thigh pull the belly 30 cm above the hip, which the
    # stride then drags sideways. Shin, foot and toe bones fade out above their
    # own head joint (+4% to +12% of height): an apron hanging to the boots got
    # 43% Toes weight at knee height (6x stretch).
    legs = {gi for gi, n in names.items() if n.endswith(("UpperLeg", "LowerLeg", "Foot", "Toes"))}
    z_lo = arm.data.bones["Hips"].head_local.z
    z_hi = arm.data.bones["Chest"].head_local.z
    distal = {gi: arm.data.bones[n].head_local.z for gi, n in names.items()
              if n.endswith(("LowerLeg", "Foot", "Toes")) and n in arm.data.bones}
    # Clavicles fade out downwards the same way, from the UpperChest joint (1) to
    # the Chest joint (0). Bone heat spread Shoulder weight down a knight's
    # breastplate to the waist (z 0.30H, joint at 0.57H); there it became the
    # 5th influence beside the thigh, and the 4-influence merge kept the thigh on
    # one vertex and the clavicle on its neighbour: 2.6x stretch mid-stride.
    shoulders = {gi for gi, n in names.items() if n.endswith("Shoulder")}
    s_lo = arm.data.bones["Chest"].head_local.z
    s_hi = arm.data.bones["UpperChest"].head_local.z
    # Thighs fade out below the knee, to 0 halfway down the shin. Once the seams
    # were welded, heat flowed from trousers into boots: a dwarf's mid-shin got
    # 27% thigh beside 29% foot, and the knee bend of the swing stretched it 3x.
    # Shin-relative, not height-relative: a dwarf's shin is 9% of height.
    thighs = {}
    for gi, n in names.items():
        if n.endswith("UpperLeg"):
            side = n[: -len("UpperLeg")]
            knee = arm.data.bones[side + "LowerLeg"].head_local.z
            shin = knee - arm.data.bones[side + "Foot"].head_local.z
            thighs[gi] = (knee - 0.5 * shin, 0.5 * shin)

    def exclusive(vertical):
        for v in obj.data.vertices:
            up = min(1.0, max(0.0, (z_hi - v.co.z) / (z_hi - z_lo)))
            down = min(1.0, max(0.0, (v.co.z - s_lo) / (s_hi - s_lo)))
            for g in v.groups:
                sgn = side_of.get(g.group)
                if sgn is not None:
                    g.weight *= min(1.0, max(0.0, 0.5 + sgn * v.co.x / (2 * band)))
                if not vertical:
                    continue
                if g.group in legs:
                    g.weight *= up
                if g.group in shoulders:
                    g.weight *= down
                head_z = distal.get(g.group)
                if head_z is not None:
                    g.weight *= min(1.0, max(0.0, (head_z + 0.12 * H - v.co.z) / (0.08 * H)))
                ramp = thighs.get(g.group)
                if ramp is not None:
                    g.weight *= min(1.0, max(0.0, (v.co.z - ramp[0]) / ramp[1]))

    exclusive(vertical=True)
    # Then spread the remaining weight transitions over more of the surface:
    # bone heat leaves steep leg->spine gradients at the buttocks/hem (2.8x
    # stretch on the knight) and across the kneecap. Smoothing can leak across
    # the midline again, so the lateral cut is re-applied before the influence
    # cap. The vertical fades are not: applied twice they square, and the
    # squared knee ramp alone was a 2.5x stretch over the kneecap.
    smooth_world(obj, 0.02 * H)
    exclusive(vertical=False)
    limit_by_hierarchy(obj, arm, 4, 0.01)
    return method


def smooth_world(obj, sigma):
    """Gaussian-average every vertex's weights over vertices within 2 sigma, by
    world distance.

    Blender's vertex_group_smooth averages over edge hops, so dense patches
    (5 mm edges at a kneecap vs 25 mm on the shin) stayed 5x sharper: 0.2 of
    thigh weight changed across one 5 mm edge, 2.8x stretch in the swing.
    Neighbours facing away (normals > 120 degrees apart) are skipped, so the
    inner thighs, or an arm and the torso side it hangs against, don't mix;
    a 90 degree gate also cut armour plates off at their rims (2.8x stretch).
    """
    from mathutils.kdtree import KDTree
    verts = obj.data.vertices
    n = len(verts)
    co = np.empty(n * 3)
    verts.foreach_get("co", co)
    co = co.reshape(-1, 3)
    nor = np.empty(n * 3)
    verts.foreach_get("normal", nor)
    nor = nor.reshape(-1, 3)
    kd = KDTree(n)
    for i, p in enumerate(co):
        kd.insert(p, i)
    kd.balance()
    rows, cols, dist = [], [], []
    for i, p in enumerate(co):
        for _, j, d in kd.find_range(p, 2 * sigma):
            rows.append(i)
            cols.append(j)
            dist.append(d)
    rows, cols, dist = np.array(rows), np.array(cols), np.array(dist)
    k = np.exp(-0.5 * (dist / sigma) ** 2) * ((nor[rows] * nor[cols]).sum(1) > -0.5)

    groups = obj.vertex_groups
    W = np.zeros((n, len(groups)))
    for v in verts:
        for g in v.groups:
            W[v.index, g.group] = g.weight
    out = np.zeros_like(W)
    np.add.at(out, rows, W[cols] * k[:, None])
    norm = np.zeros(n)
    np.add.at(norm, rows, k)
    out /= norm[:, None]  # every vertex is its own neighbour, norm > 0
    for gi in range(len(groups)):
        old, new = W[:, gi], out[:, gi]
        gone = np.nonzero((old > 0) & (new <= 1e-4))[0]
        if len(gone):
            groups[gi].remove(gone.tolist())
        for i in np.nonzero(new > 1e-4)[0]:
            groups[gi].add([int(i)], float(new[i]), "REPLACE")


def limit_by_hierarchy(obj, arm, k, floor):
    """Cap influences at k by merging, not dropping.

    Dropping the smallest weights is a seam wherever neighbouring vertices
    disagree on which bone is 5th (one keeps the thigh, the next keeps the
    clavicle). Subtracting the 5th weight from the rest is continuous but
    amplifies the difference between neighbours (measured: 0.03 of thigh weight
    became a 0.12 jump, 2.9x stretch on the knight's waist). Instead the
    smallest weight is handed to the kept bone nearest to it in the skeleton
    tree (clavicle -> chest), which moves almost the same way, so neighbours
    that disagree on the set still deform alike. Weights under `floor` are
    merged the same way, then everything is normalised.
    """
    names = {g.index: g.name for g in obj.vertex_groups}
    index = {n: i for i, n in names.items()}
    chain = {}
    for b in arm.data.bones:
        path, p = [], b
        while p is not None:
            path.append(p.name)
            p = p.parent
        chain[b.name] = path

    def tree_distance(a, b):
        pa, pb = chain[a], chain[b]
        common = next(x for x in pa if x in pb)
        return pa.index(common) + pb.index(common)

    groups = obj.vertex_groups
    for v in obj.data.vertices:
        w = {names[g.group]: g.weight for g in v.groups if g.weight > 0 and names[g.group] in chain}
        total = sum(w.values())
        if total <= 0:
            continue
        w = {n: x / total for n, x in w.items()}
        while len(w) > 1 and (len(w) > k or min(w.values()) < floor):
            small = min(w, key=w.get)
            share = w.pop(small)
            near = min(w, key=lambda n: (tree_distance(small, n), -w[n]))
            w[near] += share
        # Read the ids first: removing a group shifts v.groups under a live iterator.
        for gi in [g.group for g in v.groups]:
            if names[gi] not in w:
                groups[gi].remove([v.index])
        for n, x in w.items():
            groups[index[n]].add([v.index], x, "REPLACE")


def weights_table(obj):
    names = {g.index: g.name for g in obj.vertex_groups}
    table = []
    for v in obj.data.vertices:
        table.append([(names[g.group], g.weight) for g in v.groups if g.weight > 0])
    return table


def unweighted(obj):
    return sum(1 for w in weights_table(obj) if sum(x for _, x in w) < 1e-6)


def evaluated_coords(obj):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    m = ev.to_mesh()
    co = np.empty(len(m.vertices) * 3)
    m.vertices.foreach_get("co", co)
    ev.to_mesh_clear()
    return co.reshape(-1, 3)


def edge_array(obj):
    e = np.empty(len(obj.data.edges) * 2, dtype=np.int64)
    obj.data.edges.foreach_get("vertices", e)
    return e.reshape(-1, 2)


def stretch(rest, posed, edges):
    """(max ratio, fraction > 1.5) of posed/rest edge length. Edges shorter than
    a third of the median are skipped: near-degenerate slivers make ratios
    meaningless without any visible tearing."""
    lr = np.linalg.norm(rest[edges[:, 0]] - rest[edges[:, 1]], axis=1)
    lp = np.linalg.norm(posed[edges[:, 0]] - posed[edges[:, 1]], axis=1)
    ok = lr > np.median(lr) / 3
    r = lp[ok] / lr[ok]
    return float(r.max()), float(np.mean(r > 1.5))


def rotate_world(arm, bone_name, axis, degrees):
    """Pose `bone_name` by a world-space rotation about its head (parent left in rest)."""
    pb = arm.pose.bones[bone_name]
    pb.rotation_mode = "QUATERNION"
    B = arm.data.bones[bone_name].matrix_local.to_3x3()
    R = Matrix.Rotation(math.radians(degrees), 3, axis)
    pb.rotation_quaternion = (B.inverted() @ R @ B).to_quaternion()


def stress_test(obj, arm, edges):
    """Walk-range extremes plus a margin: arms down to the sides, stride, knee bend, torso twist."""
    rest = evaluated_coords(obj)
    rotate_world(arm, "LeftUpperArm", "Y", 35)
    rotate_world(arm, "RightUpperArm", "Y", -35)
    rotate_world(arm, "LeftUpperLeg", "X", -30)
    rotate_world(arm, "RightUpperLeg", "X", 20)
    rotate_world(arm, "LeftLowerLeg", "X", 45)
    rotate_world(arm, "Spine", "Z", 15)
    bpy.context.view_layer.update()
    posed = evaluated_coords(obj)
    for pb in arm.pose.bones:
        pb.rotation_quaternion = Quaternion()
    bpy.context.view_layer.update()
    return stretch(rest, posed, edges)


def main():
    args = C.load_args()
    b = args["budget"]
    t = C.Timer()
    C.reset_scene()
    # Welded: glTF stores one vertex per UV island at every seam (~600 islands
    # per mesh). Skinned apart, the copies got different weights and the seams
    # opened 1-2% of height mid-stride; bone heat and smoothing also stopped at
    # every island border. The exporter re-splits with one weight set per vertex.
    C.import_glb(args["mesh_glb"], merge_vertices=True)
    obj = C.join_meshes()
    obj.name = "Character"
    co = C.world_coords(obj)
    tris = C.triangles(obj)
    H = float(co[:, 2].max())
    checks = []
    report = {"checks": checks}
    try:
        joints, arm_angles, found = estimate_joints(co, tris)
    except RigError as e:
        checks.append(C.check("rig.joints", False, detail=str(e)))
        C.write_report(args, report)
        return
    t.mark("joints")
    arm = build_armature(joints, H)
    method = skin(obj, arm, H)
    t.mark("skin")

    table = weights_table(obj)
    n = len(table)
    infl = [len(w) for w in table]
    sums = np.array([sum(x for _, x in w) for w in table])
    side_bleed = 0
    for v, w in zip(obj.data.vertices, table):
        x = v.co.x
        if abs(x) < 0.06 * H:
            continue
        wrong = "Right" if x > 0 else "Left"
        if sum(val for name, val in w if name.startswith(wrong)) > 0.1:
            side_bleed += 1
    # Hand-to-thigh bleed: vertices below the crotch pulled by arm bones.
    arm_bones = ("UpperArm", "LowerArm", "Hand")
    thigh_bleed = sum(
        1 for v, w in zip(obj.data.vertices, table)
        if v.co.z < found["crotch_z"] and sum(val for name, val in w if name.endswith(arm_bones)) > 0.1
        and min(abs(v.co.x - joints[s + "Hand_tip"][0]) for s in ("Left", "Right")) > 0.1 * H
    )
    edges = edge_array(obj)
    max_stretch, frac_stretched = stress_test(obj, arm, edges)
    t.mark("tests")

    bones = [bn.name for bn in arm.data.bones]
    missing = [r for r in b["requiredBones"] if r not in bones]
    sym = abs(arm_angles["Left"] - arm_angles["Right"])
    min_z = float(C.world_coords(obj)[:, 2].min())
    checks += [
        C.check("skel.bones.required", not missing, len(bones), len(b["requiredBones"]),
                f"missing: {', '.join(missing)}" if missing else "Godot SkeletonProfileHumanoid names"),
        C.check("skel.bones.max", len(bones) <= b["maxBones"], len(bones), b["maxBones"]),
        C.check("skin.unweighted", int((sums < 1e-6).sum()) == 0, int((sums < 1e-6).sum()), 0),
        C.check("skin.max_influences", max(infl) <= b["maxInfluences"], max(infl), b["maxInfluences"]),
        C.check("skin.weight_sum", float(np.abs(sums - 1).max()) <= b["weightSumTolerance"],
                float(np.abs(sums - 1).max()), b["weightSumTolerance"]),
        C.check("skin.side_bleed", side_bleed <= 0.005 * n, side_bleed, int(0.005 * n),
                "vertices pulled by the opposite side's bones (fused legs / arms)"),
        C.check("skin.hand_thigh_bleed", thigh_bleed <= 0.005 * n, thigh_bleed, int(0.005 * n),
                "thigh vertices pulled by arm bones"),
        C.check("skin.stress_stretch", max_stretch <= b["maxEdgeStretch"], max_stretch, b["maxEdgeStretch"],
                "max edge stretch in a stress pose (arms down, stride, twist)"),
        C.check("rest.arm_angle.left", b["aPoseArmDeg"][0] <= arm_angles["Left"] <= b["aPoseArmDeg"][1],
                arm_angles["Left"], b["aPoseArmDeg"]),
        C.check("rest.arm_angle.right", b["aPoseArmDeg"][0] <= arm_angles["Right"] <= b["aPoseArmDeg"][1],
                arm_angles["Right"], b["aPoseArmDeg"]),
        C.check("rest.arm_symmetry", sym <= b["aPoseSymmetryDeg"], sym, b["aPoseSymmetryDeg"]),
        C.check("rest.feet_on_ground", abs(min_z) <= b["maxFootGroundOffsetM"], abs(min_z), b["maxFootGroundOffsetM"]),
    ]
    report.update({
        "bones": bones,
        "skin_method": method,
        "arm_angle_deg": {k: round(v, 2) for k, v in arm_angles.items()},
        "landmarks": {k: round(v, 4) for k, v in found.items()},
        "joints": {k: [round(float(x), 4) for x in v] for k, v in joints.items()},
        "max_influences": max(infl),
        "stress": {"max_stretch": round(max_stretch, 3), "frac_edges_over_1_5": round(frac_stretched, 5)},
        "timings": t.marks,
    })

    bpy.ops.wm.save_as_mainfile(filepath=args["out_blend"])
    C.export_character(args["out_glb"], animations=False)
    C.write_report(args, report)


if __name__ == "__main__":
    main()
