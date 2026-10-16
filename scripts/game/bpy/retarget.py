"""Step 4 — Skeleton + a standard mocap walk (CMU BVH) → AnimClip.

args: rigged_blend, bvh, clip_name, fps, out_blend, out_glb, report, budget

Retargeting is done in world space, per bone:
    T_t = D_t * C_b * T_0,   D_t = S_t * S_0^-1
S = source bone world rotation (rest S_0, frame t), T = target bone world
rotation, C_b = minimal rotation taking the target rest bone direction onto the
source rest bone direction. The target bone therefore points where the source
bone points at every frame, with the source's twist, regardless of the
T-pose (source) vs A-pose (target) rest difference. Hips/Head have no single
child direction and take D_t only.

Both skeletons are first turned so the body faces -Y (Blender forward). The
hips' vertical motion is scaled by the leg-length ratio, horizontal travel is
removed (in-place loop), and every frame is ground-locked so the lowest vertex
sits on z = 0. One gait cycle is cut where the pose repeats best, resampled to
`fps`, and the remaining seam is spread across the cycle so the loop closes exactly.
"""
import math
import os
import sys

import addon_utils
import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402
import rig as R  # noqa: E402

# target bone -> (source bone, source child joint giving the bone direction).
# None = transfer the rotation change only (D_t, no rest alignment). Used for the
# spine, neck, head and clavicles: both rests have them roughly in the same
# place, and aligning to CMU's rest directions would impose the actor's rest
# lean / raised clavicles on every frame (measured: 4.6x edge stretch at the
# chest from a constant ~20° clavicle offset). Limbs need the alignment because
# the rests differ (CMU T-pose arms vs our A-pose).
CMU_MAP = {
    "Hips": ("Hips", None),
    "Spine": ("LowerBack", None),
    "Chest": ("Spine", None),
    "UpperChest": ("Spine1", None),
    "Neck": ("Neck", None),
    "Head": ("Head", None),
}
for _s in ("Left", "Right"):
    CMU_MAP.update({
        f"{_s}Shoulder": (f"{_s}Shoulder", None),
        f"{_s}UpperArm": (f"{_s}Arm", f"{_s}ForeArm"),
        f"{_s}LowerArm": (f"{_s}ForeArm", f"{_s}Hand"),
        # CMU's FingerBase sits on the wrist (zero offset); Index1 gives the hand direction.
        f"{_s}Hand": (f"{_s}Hand", f"{_s}HandIndex1"),
        f"{_s}UpperLeg": (f"{_s}UpLeg", f"{_s}Leg"),
        f"{_s}LowerLeg": (f"{_s}Leg", f"{_s}Foot"),
        f"{_s}Foot": (f"{_s}Foot", f"{_s}ToeBase"),
        f"{_s}Toes": (f"{_s}ToeBase", "@tail"),
    })

LIMBS = [b for b in CMU_MAP if b not in ("Hips",)]


def facing_yaw(left_hip, right_hip):
    """Rotation about Z that turns a body with these hip joints to face -Y."""
    lr = Vector(left_hip) - Vector(right_hip)
    fwd = lr.cross(Vector((0, 0, 1)))
    fwd.z = 0
    fwd.normalize()
    return fwd.rotation_difference(Vector((0, -1, 0))).to_matrix()


def sample_source(src, frames):
    """World rotations (3x3) and head positions of every source bone per frame."""
    scene = bpy.context.scene
    mw = src.matrix_world
    rot, pos, tail = {}, {}, {}
    for f in frames:
        scene.frame_set(f)
        for pb in src.pose.bones:
            m = mw @ pb.matrix
            rot.setdefault(pb.name, []).append(m.to_3x3().normalized())
            pos.setdefault(pb.name, []).append(np.array(m.translation))
            tail.setdefault(pb.name, []).append(np.array(mw @ pb.tail))
    return rot, {k: np.array(v) for k, v in pos.items()}, {k: np.array(v) for k, v in tail.items()}


def source_rest(src):
    mw = src.matrix_world
    rot = {b.name: (mw.to_3x3() @ b.matrix_local.to_3x3()).normalized() for b in src.data.bones}
    head = {b.name: np.array(mw @ b.head_local) for b in src.data.bones}
    tail = {b.name: np.array(mw @ b.tail_local) for b in src.data.bones}
    return rot, head, tail


def angle_between(a, b):
    return a.to_quaternion().rotation_difference(b.to_quaternion()).angle


def main():
    args = C.load_args()
    b = args["budget"]
    t = C.Timer()
    bpy.ops.wm.open_mainfile(filepath=args["rigged_blend"])
    tgt = bpy.data.objects["Skeleton"]
    mesh = bpy.data.objects["Character"]
    addon_utils.enable("io_anim_bvh", default_set=True)
    bpy.ops.import_anim.bvh(filepath=args["bvh"], axis_forward="-Z", axis_up="Y",
                            update_scene_fps=False, update_scene_duration=False, rotate_mode="NATIVE")
    src = bpy.context.active_object
    action = src.animation_data.action
    f0, f1 = (int(x) for x in action.frame_range)
    frames = list(range(f0, f1 + 1))
    s_rot, s_pos, s_tail = sample_source(src, frames)
    r_rot, r_head, r_tail = source_rest(src)
    t.mark("sample")

    # Turn source rest and every source frame to face -Y.
    Y_rest = facing_yaw(r_head["LeftUpLeg"], r_head["RightUpLeg"])
    travel = s_pos["Hips"][-1] - s_pos["Hips"][0]
    Y_walk = Vector((travel[0], travel[1], 0)).normalized().rotation_difference(Vector((0, -1, 0))).to_matrix()
    Yw = np.array(Y_walk)
    for k in s_rot:
        s_rot[k] = [Y_walk @ m for m in s_rot[k]]
        s_pos[k] = s_pos[k] @ Yw.T
        s_tail[k] = s_tail[k] @ Yw.T
    r_rot = {k: Y_rest @ m for k, m in r_rot.items()}
    Yr = np.array(Y_rest)
    r_head = {k: Yr @ v for k, v in r_head.items()}
    r_tail = {k: Yr @ v for k, v in r_tail.items()}

    # Target rest.
    t_rest = {bn.name: bn.matrix_local.to_3x3().normalized() for bn in tgt.data.bones}
    t_head = {bn.name: np.array(bn.head_local) for bn in tgt.data.bones}
    t_tail = {bn.name: np.array(bn.tail_local) for bn in tgt.data.bones}

    def src_dir_rest(sb, child):
        end = r_tail[sb] if child == "@tail" else r_head[child]
        d = Vector(end - r_head[sb])
        if d.length < 1e-3 * abs(r_head["Head"][2] - r_head["LeftFoot"][2]):
            raise RuntimeError(f"source bone {sb} has no direction towards {child}")
        return d.normalized()

    align = {}
    for tb, (sb, child) in CMU_MAP.items():
        if child is None:
            align[tb] = Matrix.Identity(3)
        else:
            d_t = Vector(t_tail[tb] - t_head[tb]).normalized()
            align[tb] = d_t.rotation_difference(src_dir_rest(sb, child)).to_matrix()

    # Gait cycle: the pair of source frames (i, i + P) whose limb poses match best.
    n = len(frames)
    src_limbs = [CMU_MAP[tb][0] for tb in LIMBS]
    bvh_fps = args.get("bvh_fps", 120)
    step = max(1, round(bvh_fps / args["fps"]))
    margin = int(0.15 * n)
    best = (1e9, 0, 0)
    for P in range(int(0.8 * bvh_fps), int(1.5 * bvh_fps), step):
        for i in range(margin, n - margin - P, 2):
            d = sum(angle_between(s_rot[sb][i], s_rot[sb][i + P]) for sb in src_limbs)
            if d < best[0]:
                best = (d, i, P)
    _, i0, P = best
    P -= P % step
    idx = list(range(i0, i0 + P + 1, step))
    seam_before = max(math.degrees(angle_between(s_rot[sb][idx[0]], s_rot[sb][idx[-1]])) for sb in src_limbs)
    t.mark("cycle")

    # Reference orientation per source bone: the BVH rest for aligned limbs; for
    # D-only bones the mean orientation over the cycle, so only the oscillation
    # transfers (a mocap rest is not a neutral pose: CMU's head sits ~20° off).
    def mean_rot(mats):
        qs = [m.to_quaternion() for m in mats]
        acc = Quaternion((0, 0, 0, 0))
        for qq in qs:
            acc = acc + (qq if qq.dot(qs[0]) >= 0 else -qq)
        return acc.normalized().to_matrix()

    ref = {}
    for tb, (sb, child) in CMU_MAP.items():
        ref[tb] = r_rot[sb] if child else mean_rot([s_rot[sb][i] for i in idx])

    # Per-frame target world rotations.
    w_rot = {tb: [] for tb in CMU_MAP}
    for i in range(n):
        for tb, (sb, _) in CMU_MAP.items():
            D = s_rot[sb][i] @ ref[tb].inverted()
            w_rot[tb].append((D @ align[tb] @ t_rest[tb]).normalized())
    t.mark("cycle")

    # Hips path: in place, vertical scaled by leg length ratio.
    leg_t = np.linalg.norm(t_head["LeftUpperLeg"] - t_head["LeftLowerLeg"]) + np.linalg.norm(t_head["LeftLowerLeg"] - t_head["LeftFoot"])
    leg_s = np.linalg.norm(r_head["LeftUpLeg"] - r_head["LeftLeg"]) + np.linalg.norm(r_head["LeftLeg"] - r_head["LeftFoot"])
    scale = leg_t / leg_s
    hips_src = s_pos["Hips"][idx]
    k = np.arange(len(idx))
    trend = np.polyfit(k, hips_src[:, :2], 1)
    sway = hips_src[:, :2] - (np.outer(k, trend[0]) + trend[1])
    hips = np.zeros((len(idx), 3))
    hips[:, :2] = t_head["Hips"][:2] + scale * sway
    hips[:, 2] = t_head["Hips"][2] + scale * (hips_src[:, 2] - r_head["Hips"][2])

    # Spread the remaining seam across the cycle so frame N == frame 0 exactly.
    q = {tb: [w_rot[tb][j].to_quaternion() for j in idx] for tb in CMU_MAP}
    N = len(idx) - 1
    for tb in CMU_MAP:
        resid = q[tb][-1].rotation_difference(q[tb][0])
        if resid.w < 0:
            resid.negate()  # shortest way round
        for j in range(N + 1):
            q[tb][j] = (q[tb][j] @ Quaternion().slerp(resid, j / N)).normalized()
    hips_resid = hips[0] - hips[-1]
    hips += np.outer(np.arange(N + 1) / N, hips_resid)

    # World rotations -> pose-bone basis, parents first.
    order = [bn.name for bn in tgt.data.bones]  # Blender lists parents before children
    action_t = bpy.data.actions.new(args["clip_name"])
    tgt.animation_data_create()
    tgt.animation_data.action = action_t
    scene = bpy.context.scene
    scene.render.fps = args["fps"]
    scene.frame_start, scene.frame_end = 0, N
    bpy.context.preferences.edit.keyframe_new_interpolation_type = "LINEAR"
    for pb in tgt.pose.bones:
        pb.rotation_mode = "QUATERNION"
    prev = {}
    rest_co = R.evaluated_coords(mesh)
    edges = R.edge_array(mesh)
    ground, stretch_max = [], 0.0
    for j in range(N + 1):
        arm_m = {}
        for name in order:
            bone = tgt.data.bones[name]
            pb = tgt.pose.bones[name]
            rest_rel = bone.matrix_local if bone.parent is None else bone.parent.matrix_local.inverted() @ bone.matrix_local
            parent_m = arm_m[bone.parent.name] if bone.parent else Matrix.Identity(4)
            base = parent_m @ rest_rel
            if name in q:
                want = q[name][j].to_matrix().to_4x4()
                want.translation = Vector(hips[j]) if name == "Hips" else (base @ Matrix.Identity(4)).translation
                basis = base.inverted() @ want
                rot = basis.to_quaternion()
                if name in prev and prev[name].dot(rot) < 0:
                    rot.negate()
                prev[name] = rot
                pb.rotation_quaternion = rot
                if name == "Hips":
                    pb.location = basis.translation
                else:
                    pb.location = (0, 0, 0)
                basis = Matrix.Translation(pb.location) @ rot.to_matrix().to_4x4()
            else:
                pb.rotation_quaternion = Quaternion()
                pb.location = (0, 0, 0)
                basis = Matrix.Identity(4)
            arm_m[name] = base @ basis
        bpy.context.view_layer.update()
        # Ground lock: lowest vertex on z = 0.
        co = R.evaluated_coords(mesh)
        lift = -float(co[:, 2].min())
        hp = tgt.pose.bones["Hips"]
        hips_rest = tgt.data.bones["Hips"].matrix_local.to_3x3()
        hp.location = hp.location + hips_rest.inverted() @ Vector((0, 0, lift))
        bpy.context.view_layer.update()
        co = R.evaluated_coords(mesh)
        ground.append(float(co[:, 2].min()))
        s_max, _ = R.stretch(rest_co, co, edges)
        stretch_max = max(stretch_max, s_max)
        for name in q:
            pbn = tgt.pose.bones[name]
            pbn.keyframe_insert("rotation_quaternion", frame=j)
        hp.keyframe_insert("location", frame=j)
    t.mark("bake")

    # Loop closure after baking: evaluated world rotations of frame 0 vs frame N.
    def pose_at(frame):
        scene.frame_set(frame)
        return {name: tgt.pose.bones[name].matrix.to_quaternion() for name in q}
    first, last = pose_at(0), pose_at(N)
    seam_after = max(math.degrees(first[nm].rotation_difference(last[nm]).angle) for nm in q)

    # The BVH action must go too: the exporter's ACTIONS mode would otherwise
    # also export it onto the target (matching bone names), as a second clip.
    bpy.data.objects.remove(src)
    for act in list(bpy.data.actions):
        if act != action_t:
            bpy.data.actions.remove(act)
    bpy.ops.wm.save_as_mainfile(filepath=args["out_blend"])
    C.export_character(args["out_glb"], animations=True)
    t.mark("export")

    ground_err = max(abs(g) for g in ground)
    checks = [
        C.check("anim.cycle.length", 0.7 <= N / args["fps"] <= 1.6, round(N / args["fps"], 3), [0.7, 1.6],
                "seconds per gait cycle (two steps)"),
        C.check("anim.loop.seam_source", seam_before <= 25, round(seam_before, 2), 25,
                "worst bone mismatch between cut points before closing (picked cycle quality)", advisory=True),
        C.check("anim.loop.seam", seam_after <= b["maxLoopSeamDeg"], round(seam_after, 3), b["maxLoopSeamDeg"]),
        C.check("anim.ground", ground_err <= b["maxFootGroundOffsetM"], round(ground_err, 4), b["maxFootGroundOffsetM"],
                "lowest vertex distance from the floor, worst frame"),
        C.check("anim.edge_stretch", stretch_max <= b["maxEdgeStretch"], round(stretch_max, 3), b["maxEdgeStretch"],
                "worst edge stretch over the clip (tearing / candy-wrapper)"),
    ]
    C.write_report(args, {
        "clip": args["clip_name"], "frames": N + 1, "fps": args["fps"],
        "source": {"bvh": os.path.basename(args["bvh"]), "cycle_start": frames[i0], "cycle_frames": P, "step": step,
                   "leg_scale": round(float(scale), 4)},
        "checks": checks, "timings": t.marks,
    })


if __name__ == "__main__":
    main()
