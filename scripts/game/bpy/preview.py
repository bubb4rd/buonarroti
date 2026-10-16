"""Orthographic front / left-side / back preview strip of a .glb (textured, unlit).

args: glb, out_png, report, [pose_frame]
Renders with Workbench (texture colour, flat lighting) so the preview shows the
albedo exactly as baked; one PNG, three views side by side, same layout as the sheet.
"""
import math
import os
import sys

import bpy
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402


def main():
    args = C.load_args()
    C.reset_scene()
    C.import_glb(args["glb"])
    scene = bpy.context.scene
    if "frame" in args:
        scene.frame_set(int(args["frame"]))
    scene.render.engine = "BLENDER_WORKBENCH"
    shading = scene.display.shading
    shading.light = "FLAT"
    shading.color_type = "TEXTURE"
    scene.render.film_transparent = True
    scene.render.resolution_x = 640
    scene.render.resolution_y = 640
    scene.view_settings.view_transform = "Standard"

    depsgraph = bpy.context.evaluated_depsgraph_get()
    pts = []
    for o in C.mesh_objects():
        ev = o.evaluated_get(depsgraph)
        m = ev.to_mesh()
        co = np.empty(len(m.vertices) * 3)
        m.vertices.foreach_get("co", co)
        mw = np.array(o.matrix_world)
        pts.append(co.reshape(-1, 3) @ mw[:3, :3].T + mw[:3, 3])
        ev.to_mesh_clear()
    pts = np.concatenate(pts)
    lo, hi = pts.min(0), pts.max(0)
    center = (lo + hi) / 2
    height = max(hi - lo)

    cam_data = bpy.data.cameras.new("cam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = height * 1.15
    cam = bpy.data.objects.new("cam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    d = max(hi - lo) * 3
    views = {
        "front": ((center[0], center[1] - d, center[2]), (math.pi / 2, 0, 0)),
        "side": ((center[0] + d, center[1], center[2]), (math.pi / 2, 0, math.pi / 2)),
        "back": ((center[0], center[1] + d, center[2]), (math.pi / 2, 0, math.pi)),
    }
    tiles = []
    out_dir = os.path.dirname(args["out_png"])
    for name, (loc, rot) in views.items():
        cam.location = loc
        cam.rotation_euler = rot
        path = os.path.join(out_dir, f"_preview_{name}.png")
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        tiles.append(C.load_image_rgba(path))
        os.remove(path)
    strip = np.concatenate(tiles, axis=1)
    h, w = strip.shape[:2]
    img = bpy.data.images.new("strip", w, h, alpha=True)
    img.pixels.foreach_set(strip.astype(np.float32).ravel())
    img.file_format = "PNG"
    img.filepath_raw = args["out_png"]
    img.save()
    C.write_report(args, {"preview": args["out_png"]})


if __name__ == "__main__":
    main()
