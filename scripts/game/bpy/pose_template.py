"""Render a pose template: a neutral mannequin turnaround (front, left profile,
back) in the exact pose, scale and layout the character pipeline needs.

args: out_png, arm_deg (upper-arm angle below horizontal), stance (feet centre
distance / height), build (one entry of scripts/game/poses/builds.json), width,
height, report

The turnaround step hands this image to the image model as the pose/layout
reference, so the pose is specified by geometry instead of by words, and every
sheet comes back in the layout `lib/game/sheet.ts` splits. The mannequin's
proportions leak into the drawing (an average mannequin made a "stout" knight
slim), so the build is part of the template: a stocky character is drawn over a
stocky mannequin. Costume, colours and style still come from the concept.
"""
import math
import os
import sys

import bpy
from mathutils import Euler, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

# build: fractions of height. head: head height; hip / shoulder: joint heights;
# shoulder_x: half shoulder width; arm: shoulder to wrist; girth / limb: radius scales.
# Hands are closed fists: a fist gives every character the same grip for
# equipping a weapon, which the rig (no finger bones) could not close an open
# hand around. FIST_REACH: wrist to knuckles, in height units at limb scale 1.
FIST_REACH = 0.045


def mannequin(b, arm_deg, stance):
    """One mannequin facing -Y, feet on z = 0, height 1. Returns its objects."""
    a = math.radians(arm_deg)
    g, lm = b["girth"], b["limb"]
    sh = Vector((b["shoulder_x"], 0, b["shoulder"]))
    arm = Vector((math.cos(a), 0, -math.sin(a)))
    elbow = sh + 0.52 * b["arm"] * arm
    wrist = sh + b["arm"] * arm
    fx = stance / 2
    hip, ankle = b["hip"], 0.05
    knee = ankle + 0.48 * (hip - ankle)
    pts = {
        "pelvis": ((0, 0, hip + 0.01), (0.09 * g, 0.065 * g)),
        "chest": ((0, 0, hip + 0.6 * (b["shoulder"] - hip)), (0.105 * g, 0.07 * g)),
        "neck": ((0, 0, b["shoulder"] + 0.01), (0.035 * lm, 0.035 * lm)),
        "hipL": ((0.06 * g, 0, hip), (0.06 * lm, 0.06 * lm)),
        "kneeL": ((0.06 * g + 0.7 * (fx - 0.06 * g), 0, knee), (0.042 * lm, 0.042 * lm)),
        "ankleL": ((fx, 0, ankle), (0.03 * lm, 0.03 * lm)),
        "shL": (tuple(sh), (0.04 * lm, 0.04 * lm)),
        "elbowL": (tuple(elbow), (0.032 * lm, 0.032 * lm)),
        "wristL": (tuple(wrist), (0.024 * lm, 0.024 * lm)),
    }
    for k in list(pts):
        if k.endswith("L"):
            (x, y, z), r = pts[k]
            pts[k[:-1] + "R"] = ((-x, y, z), r)
    edges = [("pelvis", "chest"), ("chest", "neck")]
    for s in "LR":
        edges += [("pelvis", "hip" + s), ("hip" + s, "knee" + s), ("knee" + s, "ankle" + s),
                  ("chest", "sh" + s), ("sh" + s, "elbow" + s), ("elbow" + s, "wrist" + s)]
    names = list(pts)
    me = bpy.data.meshes.new("body")
    me.from_pydata([pts[n][0] for n in names], [(names.index(p), names.index(q)) for p, q in edges], [])
    body = bpy.data.objects.new("body", me)
    bpy.context.scene.collection.objects.link(body)
    body.modifiers.new("skin", "SKIN")
    for i, n in enumerate(names):
        me.skin_vertices[0].data[i].radius = pts[n][1]
    me.skin_vertices[0].data[names.index("pelvis")].use_root = True
    body.modifiers.new("subsurf", "SUBSURF").levels = 2
    parts = [body]

    def blob(loc, scale, tilt_y=0.0):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, location=loc)
        o = bpy.context.active_object
        o.scale = scale
        o.rotation_euler.y = tilt_y
        parts.append(o)

    hh = b["head"]
    blob((0, 0, 1 - hh / 2), (0.4 * hh, 0.42 * hh, hh / 2))                  # head
    blob((0, -0.4 * hh, 1 - 0.55 * hh), (0.07 * hh, 0.08 * hh, 0.09 * hh))  # nose: which way it faces
    for sgn in (1, -1):
        w = Vector((sgn * wrist.x, 0, wrist.z))
        # Fist continues the forearm, palm facing the thigh; it overlaps the
        # wrist because the subsurf rounds the skin's arm end inward.
        blob(tuple(w + 0.015 * lm * Vector((sgn * arm.x, 0, arm.z))), (0.026 * lm, 0.034 * lm, 0.03 * lm),
             tilt_y=-sgn * (math.pi / 2 - a))
        blob((sgn * fx, -0.03, 0.025), (0.035 * lm, 0.075 * lm, 0.028))  # foot, toes forward
    return parts


def main():
    args = C.load_args()
    C.reset_scene()
    scene = bpy.context.scene
    b = args["build"]
    W, Hpx = args.get("width", 2528), args.get("height", 1696)
    # Three figures across a 3:2 sheet, each 0.72 of its height, feet on one
    # line. Front and back sit near the edges (their arms are the widest part),
    # the narrow profile in the middle.
    fig_h = 0.72
    world_w = 1 / fig_h * W / Hpx  # sheet width in figure heights
    reach = b["arm"] + FIST_REACH * b["limb"]
    half_span = b["shoulder_x"] + reach * math.cos(math.radians(args["arm_deg"]))
    slots = (-(world_w / 2 - half_span - 0.03), 0.0, world_w / 2 - half_span - 0.03)
    for slot, rot in zip(slots, (0, -90, 180)):  # front, left profile facing screen-left, back
        for o in mannequin(b, args["arm_deg"], args["stance"]):
            o.rotation_euler.z += math.radians(rot)
            o.location.rotate(Euler((0, 0, math.radians(rot))))
            o.location.x += slot
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    scene.collection.objects.link(cam)
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = world_w
    cam.location = (0, -10, (0.5 - 0.1) / fig_h)  # feet 10% above the bottom edge
    cam.rotation_euler = (math.radians(90), 0, 0)
    scene.camera = cam
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.render.resolution_x, scene.render.resolution_y = W, Hpx
    scene.render.film_transparent = False
    sh = scene.display.shading
    sh.light = "STUDIO"
    sh.color_type = "SINGLE"
    sh.single_color = (0.62, 0.62, 0.62)
    sh.show_object_outline = True
    sh.object_outline_color = (0.15, 0.15, 0.15)
    sh.background_type = "VIEWPORT"
    sh.background_color = (1, 1, 1)
    scene.view_settings.view_transform = "Standard"
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = args["out_png"]
    bpy.ops.render.render(write_still=True)
    C.write_report(args, {"out_png": args["out_png"]})


if __name__ == "__main__":
    main()
