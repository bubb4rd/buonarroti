"""Measure what Unreal made of an exported character.

args: mesh_fbx, own (import_check.py report: the mesh on its own skeleton, with
our clips), manny (import_check.py report: the mesh imported onto
SK_Mannequin, with Manny's clips), rest (unreal_export.py's rest frames),
manny_skeleton, report, budget

Unreal's poses are applied to the mesh with the weights read from the FBX
(linear blend skinning, as Unreal's default skin cache does), and every frame is
measured the way the Blender and Godot checks are: worst edge stretch against
the rest mesh, and the lowest vertex. Unreal axes: cm, Z up, left-handed; a
Blender point (x, y, z) in meters is (100x, -100y, 100z).
"""
import json
import os
import sys

import bpy
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

FLIP = np.array([1.0, -1.0, 1.0])


def qmat(q):
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def mat4(tr):
    m = np.eye(4)
    m[:3, :3] = qmat(tr["q"])
    m[:3, 3] = tr["t"]
    return m


def main():
    args = C.load_args()
    b = args["budget"]
    with open(args["own"]) as f:
        own = json.load(f)
    with open(args["manny"]) as f:
        manny = json.load(f)
    with open(args["rest"]) as f:
        rest = json.load(f)

    C.reset_scene()
    bpy.ops.import_scene.fbx(filepath=args["mesh_fbx"])
    mesh = C.mesh_objects()[0]
    co = C.world_coords(mesh) * 100 * FLIP
    names = [g.name for g in mesh.vertex_groups]
    W = np.zeros((len(co), len(names)))
    for v in mesh.data.vertices:
        for g in v.groups:
            W[v.index, g.group] = g.weight
    edges = np.array([e.vertices[:] for e in mesh.data.edges])
    rest_len = np.linalg.norm(co[edges[:, 0]] - co[edges[:, 1]], axis=1)
    measured = rest_len > np.median(rest_len) / 3
    h = np.c_[co, np.ones(len(co))]

    def measure(frames, ref):
        inv = {n: np.linalg.inv(mat4(ref[n])) for n in names}
        worst, low = 0.0, np.inf
        for fr in frames:
            p = np.zeros_like(co)
            for j, n in enumerate(names):
                if W[:, j].any():
                    p += W[:, j, None] * (h @ (mat4(fr[n]) @ inv[n]).T)[:, :3]
            r = np.linalg.norm(p[edges[:, 0]] - p[edges[:, 1]], axis=1)[measured] / rest_len[measured]
            worst = max(worst, float(r.max()))
            low = min(low, float(p[:, 2].min()))
        return worst, low / 100  # stretch, lowest vertex in meters

    checks = []
    counts = own.get("counts", {})
    checks.append(C.check("unreal.import.mesh", not own["errors"] and counts.get("skeletal_meshes") == 1 and counts.get("textures", 0) >= 1,
                          f"{counts.get('skeletal_meshes', 0)} mesh, {counts.get('textures', 0)} texture", None,
                          "; ".join(own["errors"]) or "skeletal mesh, skeleton and albedo texture created"))
    ref = own.get("bones", {})
    pos_err = rot_err = 0.0
    for n, m in rest.items():
        if n not in ref:
            pos_err = np.inf
            continue
        want_p = np.array(m)[:3, 3] * 100 * FLIP
        want_r = np.diag(FLIP) @ np.array(m)[:3, :3] @ np.diag(FLIP)
        pos_err = max(pos_err, float(np.linalg.norm(np.array(ref[n]["t"]) - want_p)))
        cos = (np.trace(want_r.T @ qmat(ref[n]["q"])) - 1) / 2
        rot_err = max(rot_err, float(np.degrees(np.arccos(np.clip(cos, -1, 1)))))
    checks.append(C.check("unreal.bind_pose", pos_err <= 0.5 and rot_err <= 1.0, round(pos_err, 3), 0.5,
                          f"cm from our rest pose, worst bone (rotation {rot_err:.2f}°): the skin is bound where it was exported"))
    for clip, info in own.get("clips", {}).items():
        frames = own["poses"].get(clip, {}).get("frames", [])
        if not frames:
            checks.append(C.check(f"unreal.{clip.removesuffix('-loop')}.imported", False, detail=f"no animation from {clip}"))
            continue
        s, low = measure(frames, ref)
        short = clip.removesuffix("-loop")
        checks.append(C.check(f"unreal.{short}.engine_stretch", s <= b["maxEdgeStretch"], round(s, 3), b["maxEdgeStretch"],
                              f"worst edge stretch over {len(frames)} frames as Unreal poses the skeleton"))
    mm = manny.get("counts", {})
    on_manny = not manny["errors"] and mm.get("skeletal_meshes") == 1 and mm.get("skeletons") == 0 \
        and manny.get("skeleton", "").split(".")[0] == args["manny_skeleton"]
    checks.append(C.check("unreal.manny.skeleton", on_manny, manny.get("skeleton"), args["manny_skeleton"],
                          "Unreal accepts the mesh onto SK_Mannequin itself (no skeleton of its own): Manny's animations apply"))
    manny_stats = {}
    for path, p in manny.get("poses", {}).items():
        s, low = measure(p["frames"], ref)
        name = path.rsplit("/", 1)[-1]
        manny_stats[name] = {"stretch": round(s, 3), "lowest_m": round(low, 4)}
        checks.append(C.check(f"unreal.manny.{name}.edge_stretch", s <= b["maxEdgeStretch"], round(s, 3), b["maxEdgeStretch"],
                              f"Manny's {name} on this character; lowest vertex {low * 100:.1f} cm (no foot IK)", advisory=True))
    C.write_report(args, {"checks": checks, "manny": manny_stats})


if __name__ == "__main__":
    main()
