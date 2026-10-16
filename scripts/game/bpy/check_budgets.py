"""Independent budget check of a finished character .glb (fresh Blender import).

args: glb, report, budget (CHARACTER_BUDGET + requiredBones from lib/game/artifacts.ts)

Nothing from the pipeline's own reports is trusted: triangles, textures,
materials, height, bone names/count, influences, weight sums, A-pose angles and
the loop seam are all re-measured from the file.
"""
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402


def main():
    args = C.load_args()
    b = args["budget"]
    C.reset_scene()
    C.import_glb(args["glb"])
    meshes = [o for o in C.mesh_objects() if o.find_armature() is not None]
    arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]
    checks = []
    if len(meshes) != 1 or len(arms) != 1:
        checks.append(C.check("file.structure", False, f"{len(meshes)} skinned meshes, {len(arms)} armatures", "1/1"))
        C.write_report(args, {"checks": checks})
        return
    mesh, arm = meshes[0], arms[0]

    mesh.data.calc_loop_triangles()
    tris = len(mesh.data.loop_triangles)
    images = [img for img in bpy.data.images if img.size[0] > 0]
    tex = max((max(img.size) for img in images), default=0)
    pot = all((img.size[0] & (img.size[0] - 1)) == 0 and (img.size[1] & (img.size[1] - 1)) == 0 for img in images)
    mats = len([m for m in mesh.data.materials if m])
    co = C.world_coords(mesh)
    height = float(co[:, 2].max() - co[:, 2].min())

    bones = [bn.name for bn in arm.data.bones]
    missing = [r for r in b["requiredBones"] if r not in bones]
    names = {g.index: g.name for g in mesh.vertex_groups}
    deform = set(bones)
    infl, sums, unweighted = 0, [], 0
    for v in mesh.data.vertices:
        ws = [g.weight for g in v.groups if g.weight > 0 and names.get(g.group) in deform]
        infl = max(infl, len(ws))
        s = sum(ws)
        sums.append(s)
        unweighted += s < 1e-6
    sum_err = float(np.max(np.abs(np.array(sums) - 1))) if sums else 1.0

    def head(name):
        return arm.matrix_world @ arm.data.bones[name].head_local

    angles = {}
    for side in ("Left", "Right"):
        d = head(f"{side}LowerArm") - head(f"{side}UpperArm")
        angles[side] = math.degrees(math.atan2(-d.z, math.hypot(d.x, d.y)))

    anim = arm.animation_data.action if arm.animation_data else None
    seam = None
    if anim:
        # The importer maps glTF seconds to frames at the scene fps, so the clip end
        # is generally fractional; sample it exactly rather than a rounded frame.
        f0, f1 = anim.frame_range
        scene = bpy.context.scene
        scene.frame_set(int(f0), subframe=f0 - int(f0))
        a = {pb.name: pb.matrix.to_quaternion() for pb in arm.pose.bones}
        scene.frame_set(int(f1), subframe=f1 - int(f1))
        z = {pb.name: pb.matrix.to_quaternion() for pb in arm.pose.bones}
        seam = max(math.degrees(C.quat_angle(a[n], z[n])) for n in a)

    checks += [
        C.check("budget.triangles", b["minTriangles"] <= tris <= b["maxTriangles"], tris, [b["minTriangles"], b["maxTriangles"]]),
        C.check("budget.texture_size", 0 < tex <= b["maxTextureSize"], tex, b["maxTextureSize"]),
        C.check("budget.texture_pot", pot or not b["requirePowerOfTwoTextures"], pot, True),
        C.check("budget.materials", mats <= b["maxMaterials"], mats, b["maxMaterials"]),
        C.check("budget.height_m", b["heightM"][0] <= height <= b["heightM"][1], round(height, 4), b["heightM"]),
        C.check("budget.bones.required", not missing, len(bones), len(b["requiredBones"]),
                f"missing: {', '.join(missing)}" if missing else None),
        C.check("budget.bones.max", len(bones) <= b["maxBones"], len(bones), b["maxBones"]),
        C.check("budget.influences", infl <= b["maxInfluences"], infl, b["maxInfluences"]),
        C.check("budget.unweighted", unweighted == 0, int(unweighted), 0),
        C.check("budget.weight_sum", sum_err <= b["weightSumTolerance"], round(sum_err, 6), b["weightSumTolerance"]),
        C.check("budget.apose.left", b["aPoseArmDeg"][0] <= angles["Left"] <= b["aPoseArmDeg"][1], round(angles["Left"], 2), b["aPoseArmDeg"]),
        C.check("budget.apose.right", b["aPoseArmDeg"][0] <= angles["Right"] <= b["aPoseArmDeg"][1], round(angles["Right"], 2), b["aPoseArmDeg"]),
        C.check("budget.apose.symmetry", abs(angles["Left"] - angles["Right"]) <= b["aPoseSymmetryDeg"],
                round(abs(angles["Left"] - angles["Right"]), 2), b["aPoseSymmetryDeg"]),
        C.check("budget.animation", anim is not None, anim.name if anim else None, "one clip"),
        C.check("budget.loop_seam", seam is not None and seam <= b["maxLoopSeamDeg"],
                round(seam, 3) if seam is not None else None, b["maxLoopSeamDeg"]),
    ]
    C.write_report(args, {"checks": checks, "measured": {
        "triangles": tris, "texture": tex, "materials": mats, "height_m": round(height, 4), "bones": len(bones),
        "max_influences": infl, "arm_angle_deg": {k: round(v, 2) for k, v in angles.items()},
        "clip": anim.name if anim else None, "seam_deg": seam}})


if __name__ == "__main__":
    main()
