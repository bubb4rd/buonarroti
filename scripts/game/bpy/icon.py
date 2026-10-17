"""Inventory icon of a prop .glb: one fixed orthographic 3/4 camera, transparent background.

args: glb, category ("handheld" | "pickup"), size (px), fill (target longest side of
      the silhouette / frame), out_png, report

The camera's direction is the same for every icon of a category — 45 degrees
round from the front, 30 degrees above — so a set of icons reads as one set;
handheld items are also rolled 45 degrees so the handle runs corner to
corner, business end top left, as inventory weapons are drawn.
Only the distance (orthographic scale) and centring adapt to the item, and
lib/game/prop.ts measures the resulting framing on the picture.
Workbench studio lighting with the baked albedo: shaded enough to read the
form, deterministic, no light rig to tune.
"""
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

AZIMUTH_DEG = 45
ELEVATION_DEG = 30
ROLL_DEG = {"handheld": -45, "pickup": 0}


def main():
    args = C.load_args()
    C.reset_scene()
    C.import_glb(args["glb"])
    for o in C.mesh_objects():
        if o.name.endswith("colonly"):
            bpy.data.objects.remove(o)
    scene = bpy.context.scene
    pts = np.concatenate([C.world_coords(o) for o in C.mesh_objects()])

    az, el = math.radians(AZIMUTH_DEG), math.radians(ELEVATION_DEG)
    # Blender: the item's front faces -Y; the camera sits front-left-above it, looking back at it.
    rot = Euler((math.pi / 2 - el, 0, -az), "XYZ").to_matrix() @ Matrix.Rotation(math.radians(ROLL_DEG[args["category"]]), 3, "Z")
    right, up, back = rot.col[0], rot.col[1], rot.col[2]
    u = pts @ np.array(right[:])
    v = pts @ np.array(up[:])
    w = pts @ np.array(back[:])
    extent = max(u.max() - u.min(), v.max() - v.min())
    centre = (Vector(right) * ((u.max() + u.min()) / 2) + Vector(up) * ((v.max() + v.min()) / 2)
              + Vector(back) * (w.max() + 10 * extent))

    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    scene.collection.objects.link(cam)
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = extent / args["fill"]
    cam.data.clip_end = 100 * extent
    cam.matrix_world = Matrix.Translation(centre) @ rot.to_4x4()
    scene.camera = cam

    scene.render.engine = "BLENDER_WORKBENCH"
    sh = scene.display.shading
    sh.light = "STUDIO"
    sh.color_type = "TEXTURE"
    scene.render.film_transparent = True
    scene.render.resolution_x = scene.render.resolution_y = args["size"]
    scene.render.filter_size = 1.0
    scene.view_settings.view_transform = "Standard"
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.filepath = args["out_png"]
    bpy.ops.render.render(write_still=True)
    C.write_report(args, {"out_png": args["out_png"], "camera": {
        "azimuth_deg": AZIMUTH_DEG, "elevation_deg": ELEVATION_DEG, "roll_deg": ROLL_DEG[args["category"]],
        "ortho_scale": round(cam.data.ortho_scale, 4)}})


if __name__ == "__main__":
    main()
