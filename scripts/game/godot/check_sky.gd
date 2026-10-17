extends SceneTree
## Loads res://sky/sky.png as Godot imported it, puts it in a PanoramaSkyMaterial
## on a WorldEnvironment and renders, from the origin with a 90° camera, the
## four cardinal views (north = -Z, east = +X, south = +Z, west = -X) and the
## zenith. Saves sky-view-<name>.png into the output folder and prints one JSON
## line: {"version", "width", "height", "seam_view", "seam_x", "views", "ok", "problems"}.
##
## Which view straddles the texture's left/right wrap is measured, not assumed:
## a u-ramp panorama (red = u) is rendered first, and the view whose middle row
## jumps from red to black holds the seam, at column seam_x.
##
## Needs a GPU renderer: run WITHOUT --headless (the headless display server
## only has the dummy renderer, which draws nothing). A minimised window stops
## drawing, so a small window shows for about a second; the views themselves
## render in an off-screen SubViewport. The texture is imported beforehand with
## `godot --headless --import`, like any project asset.
## usage: godot --path <project> --resolution 64x64 -s res://check_sky.gd -- <out_dir>

const SIZE := 512
const VIEWS := {
	"north": [Vector3(0, 0, -1), Vector3.UP],
	"east": [Vector3(1, 0, 0), Vector3.UP],
	"south": [Vector3(0, 0, 1), Vector3.UP],
	"west": [Vector3(-1, 0, 0), Vector3.UP],
	"up": [Vector3(0, 1, 0), Vector3(0, 0, -1)],
}

var vp: SubViewport
var cam: Camera3D
var mat: PanoramaSkyMaterial


func _init() -> void:
	var args := OS.get_cmdline_user_args()
	var out_dir: String = args[0] if args.size() > 0 else "."
	var problems: Array[String] = []
	var result := {"version": Engine.get_version_info().string, "views": {}}

	vp = SubViewport.new()
	vp.size = Vector2i(SIZE, SIZE)
	vp.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	root.add_child(vp)
	mat = PanoramaSkyMaterial.new()
	var sky := Sky.new()
	sky.sky_material = mat
	var env := Environment.new()
	env.background_mode = Environment.BG_SKY
	env.sky = sky
	env.tonemap_mode = Environment.TONE_MAPPER_LINEAR
	var world_env := WorldEnvironment.new()
	world_env.environment = env
	vp.add_child(world_env)
	cam = Camera3D.new()
	cam.fov = 90.0
	vp.add_child(cam)

	# Calibration: which horizontal view shows u = 0/1. Nearest sampling keeps the
	# ramp's 1 → 0 jump within one pixel instead of spreading it over a texel.
	var ramp := Image.create(256, 128, false, Image.FORMAT_RGB8)
	for y in 128:
		for x in 256:
			ramp.set_pixel(x, y, Color(x / 255.0, 0, 0))
	mat.panorama = ImageTexture.create_from_image(ramp)
	mat.filter = false
	for name in ["north", "east", "south", "west"]:
		var img := await render(name)
		var best := 0.0
		var best_x := -1
		for x in SIZE - 1:
			var step := absf(img.get_pixel(x + 1, SIZE / 2).r - img.get_pixel(x, SIZE / 2).r)
			if step > best:
				best = step
				best_x = x
		if best > 0.5:
			result["seam_view"] = name
			result["seam_x"] = best_x
	if not result.has("seam_view"):
		problems.append("no horizontal view shows the panorama's wrap")
	mat.filter = true

	var tex = load("res://sky/sky.png")
	if not tex is Texture2D:
		problems.append("res://sky/sky.png did not load as a Texture2D")
	else:
		result["width"] = tex.get_width()
		result["height"] = tex.get_height()
		mat.panorama = tex
		for name in VIEWS:
			var img := await render(name)
			if img == null or img.is_empty():
				problems.append("view %s rendered nothing" % name)
				continue
			var file := "sky-view-%s.png" % name
			if img.save_png(out_dir.path_join(file)) != OK:
				problems.append("could not write " + file)
				continue
			result["views"][name] = file

	result["problems"] = problems
	result["ok"] = problems.is_empty()
	print(JSON.stringify(result))
	quit(0 if problems.is_empty() else 1)


func render(name: String) -> Image:
	var v: Array = VIEWS[name]
	cam.basis = Basis.looking_at(v[0], v[1])
	for i in 3:
		await process_frame
	await RenderingServer.frame_post_draw
	return vp.get_texture().get_image()
