"""Dump the UE5 mannequin's reference pose from the engine's own assets.

Run inside Unreal (UnrealEditor-Cmd <project> -run=pythonscript -script=<this>)
with BNR_OUT set to the output JSON path. Writes every bone of SKM_Manny_Simple:
parent, and the reference-pose transform in component space (UE units: cm,
Z up, X forward, left-handed) as translation + quaternion (x, y, z, w).
scripts/game/unreal/manny_ref.json is this script's output, checked in so the
Blender export can match Manny's bone orientations without Unreal installed.
"""
import json
import os

import unreal

MESH = "/Game/Characters/Mannequins/Meshes/SKM_Manny_Simple"

mesh = unreal.load_asset(MESH)
pose = unreal.AnimPoseExtensions.get_reference_pose(mesh.skeleton)
bones = {}
for name in unreal.AnimPoseExtensions.get_bone_names(pose):
    t = unreal.AnimPoseExtensions.get_ref_bone_pose(pose, name, unreal.AnimPoseSpaces.WORLD)
    parent = mesh.get_bone_parent(name)
    q = t.rotation
    bones[str(name)] = {
        "parent": str(parent) if str(parent) not in ("None", "") else None,
        "t": [t.translation.x, t.translation.y, t.translation.z],
        "q": [q.x, q.y, q.z, q.w],
    }
with open(os.environ["BNR_OUT"], "w") as f:
    json.dump({"mesh": MESH, "engine": unreal.SystemLibrary.get_engine_version(), "bones": bones}, f, indent=1)
unreal.log("BNR dumped %d bones" % len(bones))
