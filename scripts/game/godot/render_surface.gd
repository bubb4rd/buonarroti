extends SceneTree
## Loads a surface material (.tres + its textures, as Godot imported them),
## puts it on an 8 x 8 m plane and renders straight down from several camera
## heights into PNGs. The material itself fixes the texel density (world
## triplanar, uv1_scale = 1 / tile size), so tile edges fall on world lines
## x, z = k * tile and land on known screen rows/columns for the seam detector.
## Prints one JSON line:
##   {"loaded", "problems", "textures": {slot: {w, h, mipmaps, format, normal_map}}, "renders": [{file, height, fov}]}
## usage (needs a window: the headless driver does not render):
##   godot --path <proj> -s res://render_surface.gd -- <res://material.tres> <out_dir> <size_px> <fov_deg> <h1,h2,...>

const PLANE_M := 8.0


func _initialize() -> void:
	run.call_deferred()


func texture_info(tex: Texture2D, normal: bool) -> Dictionary:
	var img := tex.get_image()
	var info := {"w": tex.get_width(), "h": tex.get_height(), "mipmaps": img.has_mipmaps(), "format": img.get_format(), "compressed": img.is_compressed()}
	if normal:
		# Godot stores an imported normal map as RG (BC5/RGTC or RG8) and rebuilds Z in the shader.
		info["normal_map"] = img.get_format() in [Image.FORMAT_RGTC_RG, Image.FORMAT_RG8, Image.FORMAT_ETC2_RG11]
	return info


func run() -> void:
	var args := OS.get_cmdline_user_args()
	var mat_path: String = args[0]
	var out_dir: String = args[1]
	var size := int(args[2])
	var fov := float(args[3])
	var heights := Array(args[4].split(",")).map(func(s): return float(s))
	var result := {"loaded": false, "problems": [], "textures": {}, "renders": []}
	var mat := load(mat_path) as StandardMaterial3D
	if mat == null:
		result["problems"].append("material did not load as StandardMaterial3D")
		print(JSON.stringify(result))
		quit(1)
		return
	var slots := {"albedo": mat.albedo_texture, "normal": mat.normal_texture, "roughness": mat.roughness_texture}
	for slot in slots:
		var tex: Texture2D = slots[slot]
		if tex == null:
			result["problems"].append(slot + " texture missing")
		else:
			result["textures"][slot] = texture_info(tex, slot == "normal")
	if not mat.normal_enabled:
		result["problems"].append("normal_enabled is false")
	result["loaded"] = result["problems"].is_empty()

	var vp := SubViewport.new()
	vp.size = Vector2i(size, size)
	vp.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	vp.msaa_3d = Viewport.MSAA_4X
	root.add_child(vp)
	var plane := MeshInstance3D.new()
	var pm := PlaneMesh.new()
	pm.size = Vector2(PLANE_M, PLANE_M)
	plane.mesh = pm
	plane.material_override = mat
	vp.add_child(plane)
	# Light from an angle so the normal map shows; ambient keeps shadows readable.
	var sun := DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-55, 35, 0)
	vp.add_child(sun)
	var env := WorldEnvironment.new()
	env.environment = Environment.new()
	env.environment.background_mode = Environment.BG_COLOR
	env.environment.background_color = Color(0.5, 0.5, 0.5)
	env.environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	env.environment.ambient_light_color = Color(0.6, 0.6, 0.6)
	env.environment.tonemap_mode = Environment.TONE_MAPPER_LINEAR
	vp.add_child(env)
	var cam := Camera3D.new()
	cam.fov = fov
	cam.keep_aspect = Camera3D.KEEP_HEIGHT
	vp.add_child(cam)
	cam.current = true
	for i in heights.size():
		var h: float = heights[i]
		# Straight down over the corner where four tiles meet (the world origin).
		cam.position = Vector3(0, h, 0)
		cam.rotation_degrees = Vector3(-90, 0, 0)
		for f in 4:
			await process_frame
		await RenderingServer.frame_post_draw
		var file := "%s/render_%d.png" % [out_dir, i]
		var err := vp.get_texture().get_image().save_png(file)
		if err != OK:
			result["problems"].append("could not save " + file)
		else:
			result["renders"].append({"file": file, "height": h, "fov": fov})
	print(JSON.stringify(result))
	quit(0 if result["problems"].is_empty() else 1)
