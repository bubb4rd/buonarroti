"""Import a character into Unreal and report what the engine made of it.

Run inside Unreal (UnrealEditor-Cmd <project> -run=pythonscript -script=<this>)
with BNR_ARGS pointing at a JSON file:
    {"fbx": <mesh FBX>, "anim_fbx": {<clip>: <FBX>, ...}, "dest": "/Game/Import/<name>",
     "report": ..., "skeleton": <Skeleton asset path> (optional),
     "anims": [<AnimSequence asset path>, ...] (optional), "fps": 30}
The mesh FBX is imported first (onto "skeleton" when given: the
Manny-compatibility test, since Unreal refuses a mesh whose bones don't fit
that skeleton), then every clip FBX onto the mesh's skeleton, the way a user
imports animations. The report lists created assets and import messages, the
mesh's bones (parent, reference pose in component space), bounds, material
and texture counts, each imported clip's length, and for each imported clip
and each asset in "anims" the component-space pose of every bone per frame,
evaluated by Unreal on the imported mesh.
"""
import json
import os

import unreal

with open(os.environ["BNR_ARGS"]) as f:
    args = json.load(f)
report = {"engine": unreal.SystemLibrary.get_engine_version(), "errors": [], "clips": {}}


def transform(t):
    q = t.rotation
    return {"t": [t.translation.x, t.translation.y, t.translation.z], "q": [q.x, q.y, q.z, q.w]}


def import_fbx(path, dest, skeleton=None, only_animations=False):
    task = unreal.AssetImportTask()
    task.filename = path
    task.destination_path = dest
    task.automated = True
    task.replace_existing = True
    task.save = False
    if skeleton is not None:
        pipeline = unreal.InterchangeGenericAssetsPipeline()
        common = pipeline.get_editor_property("common_skeletal_meshes_and_animations_properties")
        common.set_editor_property("skeleton", skeleton)
        common.set_editor_property("import_only_animations", only_animations)
        stack = unreal.InterchangePipelineStackOverride()
        stack.add_pipeline(pipeline)
        task.options = stack
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])
    return [unreal.load_asset(str(p)) for p in task.imported_object_paths]


def poses(anim, mesh, names, fps):
    opts = unreal.AnimPoseEvaluationOptions()
    opts.set_editor_property("evaluation_type", unreal.AnimDataEvalType.RAW)
    opts.set_editor_property("optional_skeletal_mesh", mesh)
    length = anim.get_play_length()
    frames = []
    for i in range(int(round(length * fps)) + 1):
        p = unreal.AnimPoseExtensions.get_anim_pose_at_time(anim, min(i / fps, length), opts)
        frames.append({n: transform(unreal.AnimPoseExtensions.get_bone_pose(p, n, unreal.AnimPoseSpaces.WORLD)) for n in names})
    return {"length": length, "frames": frames}


try:
    unreal.EditorAssetLibrary.delete_directory(args["dest"])
    base_skeleton = unreal.load_asset(args["skeleton"]) if args.get("skeleton") else None
    assets = import_fbx(args["fbx"], args["dest"], base_skeleton)
    report["imported"] = [a.get_path_name() for a in assets]
    meshes = [a for a in assets if isinstance(a, unreal.SkeletalMesh)]
    report["counts"] = {
        "skeletal_meshes": len(meshes),
        "skeletons": len([a for a in assets if isinstance(a, unreal.Skeleton)]),
        "anim_sequences": len([a for a in assets if isinstance(a, unreal.AnimSequence)]),
        "textures": len([a for a in assets if isinstance(a, unreal.Texture)]),
    }
    if meshes:
        mesh = meshes[0]
        report["skeleton"] = mesh.skeleton.get_path_name()
        ref = unreal.AnimPoseExtensions.get_reference_pose(mesh.skeleton)
        names = [str(n) for n in unreal.AnimPoseExtensions.get_bone_names(ref)]
        report["bones"] = {}
        for n in names:
            p = mesh.get_bone_parent(n)
            report["bones"][n] = {"parent": str(p) if str(p) not in ("None", "") else None,
                                  **transform(unreal.AnimPoseExtensions.get_ref_bone_pose(ref, n, unreal.AnimPoseSpaces.WORLD))}
        b = mesh.get_bounds()
        report["bounds"] = {"origin": [b.origin.x, b.origin.y, b.origin.z], "extent": [b.box_extent.x, b.box_extent.y, b.box_extent.z]}
        report["materials"] = len(mesh.materials)
        fps = args.get("fps", 30)
        report["poses"] = {}
        for clip, path in args.get("anim_fbx", {}).items():
            got = import_fbx(path, args["dest"], mesh.skeleton, only_animations=True)
            anims = [a for a in got if isinstance(a, unreal.AnimSequence)]
            report["clips"][clip] = {"assets": [a.get_path_name() for a in got],
                                     "length": anims[0].get_play_length() if anims else None}
            if anims:
                report["poses"][clip] = poses(anims[0], mesh, names, fps)
        for path in args.get("anims", []):
            report["poses"][path] = poses(unreal.load_asset(path), mesh, names, fps)
except Exception as e:  # noqa: BLE001 - every failure belongs in the report
    report["errors"].append(repr(e))
with open(args["report"], "w") as f:
    json.dump(report, f, indent=1)
unreal.log("BNR import_check done: %s" % args["report"])
