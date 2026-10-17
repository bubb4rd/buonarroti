"""Step 4 — Skeleton + standard mocap (CMU BVH) → AnimClip: an animation set.

args: rigged_blend, clips, fps, out_blend, out_glb, report, budget
  clips: [{name, bvh, bvh_fps, loop, moves, contact, period_s: [lo, hi] (loops) | window_s: [a, b] (one-shots)}]

Retargeting is done in world space, per bone:
    T_t = D_t * C_b * T_0,   D_t = S_t * S_0^-1
S = source bone world rotation (rest S_0, frame t), T = target bone world
rotation, C_b = minimal rotation taking the target rest bone direction onto the
source rest bone direction. The target bone therefore points where the source
bone points at every frame, with the source's twist, regardless of the
T-pose (source) vs A-pose (target) rest difference. Hips/Head have no single
child direction and take D_t only.

Both skeletons are first turned so the body faces -Y (Blender forward): along
the hips' travel for clips that move (walk, run), along the hip joints' mean
facing for those that stay put (idle, jump). The hips' vertical motion is
scaled by the leg-length ratio and horizontal travel is removed.

Loops (`-loop` names; Godot imports those looping): the cycle is cut where the
pose repeats best within `period_s`, resampled to `fps`, the remaining seam is
spread across the cycle so it closes exactly, and every frame is ground-locked
(lowest vertex on z = 0).

One-shots (jump): `window_s` of the trial, resampled. Horizontal hips motion is
pinned to start and end on the rest position (no drift). Frames where a source
foot is on its floor are ground-locked; airborne frames put the lowest vertex at
the source's foot clearance scaled by the leg ratio, so the flight survives.

`contact` clips also plant each foot the source has down: two-bone leg IK pulls
its lowest vertex onto the floor (actor and character stand differently, so a
plain lock leaves one foot hovering).

Each clip is its own action on the Skeleton (fake user); the .glb carries all.
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
SIDES = ("Left", "Right")
# A source foot is down when its lowest joint is within this fraction of the
# actor's leg length of the trial's floor (CMU standing jitter is ~2%).
GROUNDED_LEG_FRAC = 0.05
# Planting never straightens a leg past this fraction of its length (a locked
# knee pops); beyond it the hips drop instead.
MAX_REACH = 0.995
PLANT_ITERATIONS = 2


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
    return C.quat_angle(a.to_quaternion(), b.to_quaternion())


def find_cycle(s_rot, bones, bvh_fps, period_s, step):
    """(start, length) in source frames of the window whose end pose best matches its start."""
    Q = np.array([[list(m.to_quaternion()) for m in s_rot[sb]] for sb in bones])  # (bones, frames, 4)
    n = Q.shape[1]
    margin = int(0.15 * n)
    best = (np.inf, 0, 0)
    for P in range(int(period_s[0] * bvh_fps), int(period_s[1] * bvh_fps), step):
        i = np.arange(margin, n - margin - P, 2)
        if not len(i):
            continue
        dots = np.abs(np.sum(Q[:, i] * Q[:, i + P], axis=-1)).clip(0, 1)
        d = (2 * np.arccos(dots)).sum(0)
        k = int(np.argmin(d))
        if d[k] < best[0]:
            best = (d[k], int(i[k]), P)
    if not np.isfinite(best[0]):
        raise RuntimeError(f"trial too short for a {period_s[0]}–{period_s[1]} s cycle")
    _, i0, P = best
    return i0, P - P % step


def mean_rot(mats):
    qs = [m.to_quaternion() for m in mats]
    acc = Quaternion((0, 0, 0, 0))
    for qq in qs:
        acc = acc + (qq if qq.dot(qs[0]) >= 0 else -qq)
    return acc.normalized().to_matrix()


def foot_vertices(mesh):
    """Vertex indices per side whose strongest influence is that foot or its toes."""
    names = {g.index: g.name for g in mesh.vertex_groups}
    side = {"Left": [], "Right": []}
    for v in mesh.data.vertices:
        if not v.groups:
            continue
        g = names[max(v.groups, key=lambda x: x.weight).group]
        for s in side:
            if g in (f"{s}Foot", f"{s}Toes"):
                side[s].append(v.index)
    return {s: np.array(ix, dtype=np.int64) for s, ix in side.items()}


def retarget_clip(spec, args, tgt, mesh, rig, t):
    """Bake one BVH trial onto the Skeleton as its own action; returns (clip info, checks)."""
    b = args["budget"]
    fps = args["fps"]
    short = spec["name"].removesuffix("-loop")
    loop = spec["loop"]

    bpy.ops.object.select_all(action="DESELECT")
    bpy.ops.import_anim.bvh(filepath=spec["bvh"], axis_forward="-Z", axis_up="Y",
                            update_scene_fps=False, update_scene_duration=False, rotate_mode="NATIVE")
    src = bpy.context.active_object
    src_action = src.animation_data.action
    f0, f1 = (int(x) for x in src_action.frame_range)
    frames = list(range(f0, f1 + 1))
    s_rot, s_pos, s_tail = sample_source(src, frames)
    r_rot, r_head, r_tail = source_rest(src)
    # The BVH action must go: the exporter's ACTIONS mode would otherwise also
    # export it onto the target (matching bone names), as an extra clip.
    src_data = src.data
    bpy.data.objects.remove(src)
    bpy.data.armatures.remove(src_data)
    bpy.data.actions.remove(src_action)
    t.mark(f"{short}.sample")

    # Frames used: one cycle (loops) or the trial window (one-shots).
    n = len(frames)
    bvh_fps = spec["bvh_fps"]
    step = max(1, round(bvh_fps / fps))
    src_limbs = [CMU_MAP[tb][0] for tb in LIMBS]
    if loop:
        i0, P = find_cycle(s_rot, src_limbs, bvh_fps, spec["period_s"], step)
        idx = list(range(i0, i0 + P + 1, step))
    else:
        a, z = spec["window_s"]
        idx = list(range(round(a * bvh_fps), min(n - 1, round(z * bvh_fps)) + 1, step))
    seam_before = max(math.degrees(angle_between(s_rot[sb][idx[0]], s_rot[sb][idx[-1]])) for sb in src_limbs)

    # Turn source rest and every source frame to face -Y.
    Y_rest = facing_yaw(r_head["LeftUpLeg"], r_head["RightUpLeg"])
    if spec["moves"]:
        travel = s_pos["Hips"][-1] - s_pos["Hips"][0]
        Y_src = Vector((travel[0], travel[1], 0)).normalized().rotation_difference(Vector((0, -1, 0))).to_matrix()
    else:
        Y_src = facing_yaw(s_pos["LeftUpLeg"][idx].mean(0), s_pos["RightUpLeg"][idx].mean(0))
    Ys = np.array(Y_src)
    for k in s_rot:
        s_rot[k] = [Y_src @ m for m in s_rot[k]]
        s_pos[k] = s_pos[k] @ Ys.T
        s_tail[k] = s_tail[k] @ Ys.T
    r_rot = {k: Y_rest @ m for k, m in r_rot.items()}
    Yr = np.array(Y_rest)
    r_head = {k: Yr @ v for k, v in r_head.items()}
    r_tail = {k: Yr @ v for k, v in r_tail.items()}
    t_rest, t_head, t_tail = rig["rest"], rig["head"], rig["tail"]

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

    # Reference orientation per source bone: the BVH rest for aligned limbs; for
    # D-only bones the mean orientation over the clip, so only the oscillation
    # transfers (a mocap rest is not a neutral pose: CMU's head sits ~20° off).
    ref = {tb: (r_rot[sb] if child else mean_rot([s_rot[sb][i] for i in idx])) for tb, (sb, child) in CMU_MAP.items()}
    q = {tb: [((s_rot[sb][i] @ ref[tb].inverted()) @ align[tb] @ t_rest[tb]).normalized().to_quaternion() for i in idx]
         for tb, (sb, _) in CMU_MAP.items()}

    # Hips path: vertical scaled by leg length ratio; horizontal travel removed.
    leg_t = np.linalg.norm(t_head["LeftUpperLeg"] - t_head["LeftLowerLeg"]) + np.linalg.norm(t_head["LeftLowerLeg"] - t_head["LeftFoot"])
    leg_s = np.linalg.norm(r_head["LeftUpLeg"] - r_head["LeftLeg"]) + np.linalg.norm(r_head["LeftLeg"] - r_head["LeftFoot"])
    scale = leg_t / leg_s
    hips_src = s_pos["Hips"][idx]
    N = len(idx) - 1
    k = np.arange(N + 1)
    if loop:
        trend = np.polyfit(k, hips_src[:, :2], 1)
        sway = hips_src[:, :2] - (np.outer(k, trend[0]) + trend[1])
    else:
        sway = hips_src[:, :2] - (hips_src[0, :2] + np.outer(k / N, hips_src[-1, :2] - hips_src[0, :2]))
    hips = np.zeros((N + 1, 3))
    hips[:, :2] = t_head["Hips"][:2] + scale * sway
    hips[:, 2] = t_head["Hips"][2] + scale * (hips_src[:, 2] - r_head["Hips"][2])

    if loop:
        # Spread the remaining seam across the cycle so frame N == frame 0 exactly.
        for tb in CMU_MAP:
            resid = q[tb][-1].rotation_difference(q[tb][0])
            if resid.w < 0:
                resid.negate()  # shortest way round
            for j in range(N + 1):
                q[tb][j] = (q[tb][j] @ Quaternion().slerp(resid, j / N)).normalized()
        hips += np.outer(k / N, hips[0] - hips[-1])

    # Per-foot height above the trial's floor (lowest of ankle, toe joint, toe tip):
    # a foot is down near the floor; in flight the lower foot's clearance, scaled
    # by the leg ratio, is what the target keeps (not the hips' rise, which on
    # big-footed, short-legged characters is eaten by the pointed toes).
    foot_src = {s: np.min([s_pos[f"{s}Foot"][idx, 2], s_pos[f"{s}ToeBase"][idx, 2], s_tail[f"{s}ToeBase"][idx, 2]], axis=0)
                for s in SIDES}
    floor = min(float(v.min()) for v in foot_src.values())
    down = {s: v - floor < GROUNDED_LEG_FRAC * leg_s for s, v in foot_src.items()}
    grounded = np.ones(N + 1, dtype=bool) if loop else down["Left"] | down["Right"]
    clearance_t = scale * (np.minimum(foot_src["Left"], foot_src["Right"]) - floor)
    plant = {s: down[s] & grounded if spec.get("contact") else np.zeros(N + 1, dtype=bool) for s in SIDES}
    t.mark(f"{short}.solve")

    # World rotations -> pose-bone basis, parents first.
    order = [bn.name for bn in tgt.data.bones]  # Blender lists parents before children
    action = bpy.data.actions.new(spec["name"])
    action.use_fake_user = True  # unassigned clips must survive the save
    tgt.animation_data.action = action
    feet = rig["feet"]
    prev = {}

    def pose(j):
        arm_m = {}
        for name in order:
            bone = tgt.data.bones[name]
            pb = tgt.pose.bones[name]
            rest_rel = bone.matrix_local if bone.parent is None else bone.parent.matrix_local.inverted() @ bone.matrix_local
            base = (arm_m[bone.parent.name] if bone.parent else Matrix.Identity(4)) @ rest_rel
            if name in q:
                want = q[name][j].to_matrix().to_4x4()
                want.translation = Vector(hips[j]) if name == "Hips" else base.translation
                basis = base.inverted() @ want
                rot = basis.to_quaternion()
                if name in prev and prev[name].dot(rot) < 0:
                    rot.negate()
                prev[name] = rot
                pb.rotation_quaternion = rot
                pb.location = basis.translation if name == "Hips" else (0, 0, 0)
                basis = Matrix.Translation(pb.location) @ rot.to_matrix().to_4x4()
            else:
                pb.rotation_quaternion = Quaternion()
                pb.location = (0, 0, 0)
                basis = Matrix.Identity(4)
            arm_m[name] = base @ basis
        bpy.context.view_layer.update()

    def lock(j, height=0.0):
        """Ground lock: lowest vertex at `height` above z = 0."""
        hips[j][2] += height - float(R.evaluated_coords(mesh)[:, 2].min())
        pose(j)

    def solve_leg(j, s, goal):
        """Two-bone IK in world rotations: knee bend for the hip–ankle distance, then a
        swing about the hip onto the goal. The foot keeps its world rotation."""
        pbs = tgt.pose.bones
        H, K, A = (Vector(pbs[f"{s}{n}"].head) for n in ("UpperLeg", "LowerLeg", "Foot"))
        L1, L2 = (K - H).length, (A - K).length
        D = min(max((goal - H).length, abs(L1 - L2) + 1e-4), MAX_REACH * (L1 + L2))
        theta = (H - K).angle(A - K)
        theta_new = math.acos(max(-1.0, min(1.0, (L1 * L1 + L2 * L2 - D * D) / (2 * L1 * L2))))
        axis = (K - H).cross(A - K)
        if axis.length < 1e-6:  # straight leg: the bone's X is the knee hinge
            axis = q[f"{s}UpperLeg"][j].to_matrix().col[0]
        bend = Quaternion(axis.normalized(), theta - theta_new)
        swing = (K + bend @ (A - K) - H).rotation_difference(goal - H)
        q[f"{s}LowerLeg"][j] = (swing @ bend @ q[f"{s}LowerLeg"][j]).normalized()
        q[f"{s}UpperLeg"][j] = (swing @ q[f"{s}UpperLeg"][j]).normalized()

    def settle(j):
        """Ground-lock frame j, then pull every planted foot down onto the floor
        (hips drop first if a straightened leg could not reach)."""
        pose(j)
        lock(j)
        sides = [s for s in SIDES if plant[s][j]]
        for _ in range(PLANT_ITERATIONS if sides else 0):
            co = R.evaluated_coords(mesh)
            pbs = tgt.pose.bones
            goal = {s: Vector(pbs[f"{s}Foot"].head) - Vector((0, 0, float(co[feet[s], 2].min()))) for s in sides}
            drop = max(0.0, max((goal[s] - Vector(pbs[f"{s}UpperLeg"].head)).length
                                - MAX_REACH * (pbs[f"{s}UpperLeg"].length + pbs[f"{s}LowerLeg"].length) for s in sides))
            hips[j][2] -= drop
            pose(j)
            for s in sides:
                solve_leg(j, s, goal[s])
            pose(j)
            lock(j)

    lowest, foot_low, foot_xy, stretch_max = [], [], [], 0.0
    for j in range(N + 1):
        if grounded[j]:
            settle(j)
        else:
            pose(j)
            lock(j, float(clearance_t[j]))
        co = R.evaluated_coords(mesh)
        lowest.append(float(co[:, 2].min()))
        foot_low.append([float(co[feet[s], 2].min()) for s in SIDES])
        foot_xy.append(co[np.concatenate([feet["Left"], feet["Right"]]), :2].mean(0))
        s_max, _ = R.stretch(rig["rest_co"], co, rig["edges"])
        stretch_max = max(stretch_max, s_max)
        for name in q:
            tgt.pose.bones[name].keyframe_insert("rotation_quaternion", frame=j)
        tgt.pose.bones["Hips"].keyframe_insert("location", frame=j)
    action.use_frame_range = True
    action.frame_start, action.frame_end = 0, N
    t.mark(f"{short}.bake")

    lowest, foot_low = np.array(lowest), np.array(foot_low)
    ground_err = float(np.abs(lowest[grounded]).max())
    checks = [
        C.check(f"anim.{short}.ground", ground_err <= b["maxFootGroundOffsetM"], round(ground_err, 4), b["maxFootGroundOffsetM"],
                "lowest vertex distance from the floor, worst frame" + ("" if loop else " with the source's feet down")),
        C.check(f"anim.{short}.edge_stretch", stretch_max <= b["maxEdgeStretch"], round(stretch_max, 3), b["maxEdgeStretch"],
                "worst edge stretch over the clip (tearing / candy-wrapper)"),
    ]
    info = {"name": spec["name"], "source": os.path.basename(spec["bvh"]), "frames": N + 1, "fps": fps, "loop": loop,
            "source_frames": [frames[idx[0]], frames[idx[-1]]], "step": step, "leg_scale": round(float(scale), 4),
            "max_stretch": round(stretch_max, 3)}
    if loop:
        # Loop closure after baking: evaluated pose of frame 0 vs frame N.
        scene = bpy.context.scene

        def pose_at(frame):
            scene.frame_set(frame)
            return {name: tgt.pose.bones[name].matrix.to_quaternion() for name in q}
        first, last = pose_at(0), pose_at(N)
        seam_after = max(math.degrees(C.quat_angle(first[nm], last[nm])) for nm in q)
        lo, hi = spec["period_s"]
        checks += [
            C.check(f"anim.{short}.cycle.length", lo <= N / fps <= hi, round(N / fps, 3), [lo, hi], "seconds per cycle"),
            C.check(f"anim.{short}.loop.seam_source", seam_before <= 25, round(seam_before, 2), 25,
                    "worst bone mismatch between cut points before closing (picked cycle quality)", advisory=True),
            C.check(f"anim.{short}.loop.seam", seam_after <= b["maxLoopSeamDeg"], round(seam_after, 3), b["maxLoopSeamDeg"]),
        ]
        info["loop_seam_deg"] = round(seam_after, 3)
    if spec.get("contact"):
        planted = np.stack([plant[s] for s in SIDES], axis=1)
        contact = float(foot_low[planted].max()) if planted.any() else 0.0
        checks.append(C.check(f"anim.{short}.feet_down", contact <= b["maxFootGroundOffsetM"], round(contact, 4),
                              b["maxFootGroundOffsetM"], f"planted foot's lowest vertex above the floor, worst of "
                              f"{int(planted.sum())} foot-frames the source has on the floor"))
    if not loop:
        clearance = float(foot_low.min(1).max())
        ends = float(max(foot_low[0].max(), foot_low[-1].max()))
        drift = float(np.linalg.norm(foot_xy[-1] - foot_xy[0]))
        checks += [
            C.check(f"anim.{short}.airborne", clearance >= b["minJumpClearanceM"], round(clearance, 4), b["minJumpClearanceM"],
                    "lower foot's lowest vertex above the floor at the apex, meters (both feet leave the ground)"),
            C.check(f"anim.{short}.lands", ends <= b["maxFootGroundOffsetM"], round(ends, 4), b["maxFootGroundOffsetM"],
                    "both feet on the floor at the first and last frame, meters"),
            C.check(f"anim.{short}.drift", drift <= b["maxJumpDriftM"], round(drift, 4), b["maxJumpDriftM"],
                    "feet centre at landing vs take-off, horizontal, meters (in place)"),
        ]
        info.update(airborne_frames=int((~grounded).sum()), clearance_m=round(clearance, 4),
                    start_end_deg=round(seam_before, 2))
    return info, checks


def main():
    args = C.load_args()
    t = C.Timer()
    bpy.ops.wm.open_mainfile(filepath=args["rigged_blend"])
    tgt = bpy.data.objects["Skeleton"]
    mesh = bpy.data.objects["Character"]
    addon_utils.enable("io_anim_bvh", default_set=True)
    scene = bpy.context.scene
    scene.render.fps = args["fps"]
    bpy.context.preferences.edit.keyframe_new_interpolation_type = "LINEAR"
    tgt.animation_data_create()
    for pb in tgt.pose.bones:
        pb.rotation_mode = "QUATERNION"
    rig = {
        "rest": {bn.name: bn.matrix_local.to_3x3().normalized() for bn in tgt.data.bones},
        "head": {bn.name: np.array(bn.head_local) for bn in tgt.data.bones},
        "tail": {bn.name: np.array(bn.tail_local) for bn in tgt.data.bones},
        "rest_co": R.evaluated_coords(mesh), "edges": R.edge_array(mesh), "feet": foot_vertices(mesh),
    }
    clips, checks = [], []
    for spec in args["clips"]:
        info, cks = retarget_clip(spec, args, tgt, mesh, rig, t)
        clips.append(info)
        checks += cks
    # The first clip stays assigned: it is what the preview and a plain viewer show.
    first = bpy.data.actions[args["clips"][0]["name"]]
    tgt.animation_data.action = first
    scene.frame_start, scene.frame_end = (int(x) for x in first.frame_range)
    bpy.ops.wm.save_as_mainfile(filepath=args["out_blend"])
    C.export_character(args["out_glb"], animations=True)
    t.mark("export")
    C.write_report(args, {"clips": clips, "checks": checks, "timings": t.marks})


if __name__ == "__main__":
    main()
