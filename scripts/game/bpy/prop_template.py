"""Render a prop layout template: where the image model draws the three views
of an item, at what scale, and (handheld) where the fist closes on it.

args: out_png, width, height, category ("handheld" | "pickup"), layout (PROP_LAYOUT[category]
      from lib/game/prop.ts: frame_m, baseline_v, slots_u, ruler_u, ruler_m, grip_m + band_m
      (handheld) or ground_u (pickup)), report

Everything is placed in metres on a plane facing an orthographic camera whose
frame is `frame_m` tall, so the ruler (10 cm ticks, from the baseline up) is at
the scale the item must be drawn at and lib/game/prop.ts reads sizes back with
the same numbers. No outline of an item is drawn (unlike the character
mannequin, a placeholder shape would leak into every item). Handheld: an orange
box the size of a closed fist at grip height in each view, which the handle
must pass through. Pickup: one ground line under the three views, which the
sheet segmentation removes if the model copies it.
"""
import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

# Workbench object colours (linear); they render as sRGB (255,196,108), (195,195,195), (124,124,124).
BAND_RGB = (1.0, 0.55, 0.15)
GROUND_RGB = (0.55, 0.55, 0.55)
RULER_RGB = (0.2, 0.2, 0.2)


def rect(cx, z0, w, h, rgb):
    """Axis-aligned rectangle in the x/z plane, bottom edge at z0."""
    bpy.ops.mesh.primitive_plane_add(size=1, location=(cx, 0, z0 + h / 2), rotation=(1.5707963, 0, 0))
    o = bpy.context.active_object
    o.scale = (w, h, 1)
    o.color = (*rgb, 1)


def main():
    args = C.load_args()
    C.reset_scene()
    scene = bpy.context.scene
    W, H = args["width"], args["height"]
    L = args["layout"]
    frame = L["frame_m"]
    world_w = frame * W / H
    x_of = lambda u: (u - 0.5) * world_w  # noqa: E731
    px = frame / H  # metres per pixel

    # Ruler: 1 m bar from the baseline, a tick every 10 cm, longer at 50 cm and 1 m.
    rx = x_of(L["ruler_u"])
    bar = max(0.008, 4 * px)
    rect(rx, 0, bar, L["ruler_m"], RULER_RGB)
    for i in range(int(round(L["ruler_m"] * 10)) + 1):
        tick = (0.07 if i % 5 == 0 else 0.04) * min(1.0, frame / 1.2)
        rect(rx + tick / 2, i * 0.1 - bar * 0.4, tick, bar * 0.8, RULER_RGB)

    for u in L["slots_u"]:
        if args["category"] == "handheld":
            bw, bh = L["band_m"]
            rect(x_of(u), L["grip_m"] - bh / 2, bw, bh, BAND_RGB)
    if args["category"] == "pickup":
        # One line under all three views: copied, it is a long stroke sheet.ts's segmentation removes.
        g0, g1 = x_of(L["ground_u"][0]), x_of(L["ground_u"][1])
        rect((g0 + g1) / 2, -max(0.004, 2.5 * px), g1 - g0, max(0.004, 2.5 * px), GROUND_RGB)

    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    scene.collection.objects.link(cam)
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = world_w
    cam.location = (0, -10, (L["baseline_v"] - 0.5) * frame)
    cam.rotation_euler = (1.5707963, 0, 0)
    scene.camera = cam
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.render.resolution_x, scene.render.resolution_y = W, H
    scene.render.film_transparent = False
    sh = scene.display.shading
    sh.light = "FLAT"
    sh.color_type = "OBJECT"
    sh.background_type = "VIEWPORT"
    sh.background_color = (1, 1, 1)
    scene.view_settings.view_transform = "Standard"
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = args["out_png"]
    bpy.ops.render.render(write_still=True)
    C.write_report(args, {"out_png": args["out_png"]})


if __name__ == "__main__":
    main()
