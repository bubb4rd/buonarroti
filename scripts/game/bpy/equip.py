"""Equip a handheld prop: parent it to the character's RightHand bone at the fist.

args: anim_blend (rigged character + clips, from the walk step), prop_glb (a Prop:
      grip centre at the origin, handle along glTF +Y = Blender +Z, width along X),
      hand_weight, out_glb, report

The rig has no finger bones: the fist is the end of the RightHand bone, drawn
closed by the pose template (pose_template.py FIST_REACH) and sized by rig.py
(HAND_FRAC["fist"]: the wrist sits 12% of the arm back from the knuckles). So
the grip is taken from the mesh, in the rest pose:

- grip centre: centroid of the vertices weighted >= hand_weight to RightHand
  (the fist itself, wrist to knuckles);
- grip axis: the character's forward direction with its component along the
  hand bone removed. A closed fist hanging palm-in holds a handle through it
  front to back, thumb side forward, so the business end points forward;
- the item's width (its X: a sword's guard, an axe's blade, a hammer's head)
  along the hand bone, wrist to knuckles, the way a blade's edge leads.

The prop is parented to the bone keeping that rest placement, so glTF writes
it as a child node of the RightHand joint (Godot: a BoneAttachment3D).
"""
import os
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

BONE = "RightHand"


def main():
    args = C.load_args()
    bpy.ops.wm.open_mainfile(filepath=args["anim_blend"])
    arm = bpy.data.objects["Skeleton"]
    body = bpy.data.objects["Character"]
    arm.data.pose_position = "REST"
    bpy.context.view_layer.update()

    g = body.vertex_groups[BONE].index
    fist = np.array([list(body.matrix_world @ v.co) for v in body.data.vertices
                     if any(x.group == g and x.weight >= args["hand_weight"] for x in v.groups)])
    bone = arm.data.bones[BONE]
    head, tail = arm.matrix_world @ bone.head_local, arm.matrix_world @ bone.tail_local
    along = (tail - head).normalized()
    forward = Vector((0, -1, 0))
    grip_axis = (forward - forward.dot(along) * along).normalized()
    centre = Vector(fist.mean(0))
    rot = Matrix((along, grip_axis.cross(along), grip_axis)).transposed()  # columns: X, Y, Z

    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=args["prop_glb"])
    new = [o for o in bpy.data.objects if o not in before]
    prop = next(o for o in new if o.type == "MESH" and not o.name.endswith("colonly"))
    for o in new:
        if o is not prop:
            bpy.data.objects.remove(o)
    prop.parent = None
    prop.name = "Prop"
    prop.matrix_world = Matrix.Translation(centre) @ rot.to_4x4()
    bpy.context.view_layer.update()
    world = prop.matrix_world.copy()
    prop.parent = arm
    prop.parent_type = "BONE"
    prop.parent_bone = BONE
    prop.matrix_world = world
    bpy.context.view_layer.update()
    arm.data.pose_position = "POSE"

    # The walk is the clip the Godot check plays; keep it active for the preview.
    walk = next((a for a in bpy.data.actions if a.name.startswith("walk")), None)
    if walk is not None:
        arm.animation_data.action = walk
    C.export_character(args["out_glb"], animations=True, extra=("Prop",))
    C.write_report(args, {
        "fist_vertices": len(fist),
        "grip_centre": [round(float(x), 4) for x in centre],
        "grip_axis": [round(float(x), 4) for x in grip_axis],
        "hand_axis": [round(float(x), 4) for x in along],
        "clips": [a.name for a in bpy.data.actions],
        "walk": walk.name if walk else None,
        "checks": [
            C.check("equip.fist.found", len(fist) > 0, len(fist), detail=f"vertices weighted >= {args['hand_weight']} to {BONE}"),
            C.check("equip.walk.present", walk is not None, walk.name if walk else None, "walk-loop"),
        ],
    })


if __name__ == "__main__":
    main()
