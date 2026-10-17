extends Node3D
## Every res://characters/*.glb side by side, each playing its "walk" clip
## (else its first). Rendered with --write-movie for a visual record of the walk.

func _ready() -> void:
	var files := Array(DirAccess.get_files_at("res://characters")).filter(func(f): return f.ends_with(".glb"))
	var spacing := 1.6
	var x0 := -spacing * (files.size() - 1) / 2.0
	for i in files.size():
		var inst: Node3D = (load("res://characters/" + files[i]) as PackedScene).instantiate()
		inst.position = Vector3(x0 + i * spacing, 0, 0)
		add_child(inst)
		var players := inst.find_children("*", "AnimationPlayer", true, false)
		if not players.is_empty():
			var p: AnimationPlayer = players[0]
			p.play(&"walk" if p.has_animation(&"walk") else p.get_animation_list()[0])
	var cam := Camera3D.new()
	cam.position = Vector3(2.2, 1.4, 4.2 + files.size() * 0.4)
	add_child(cam)
	cam.look_at(Vector3(0, 0.85, 0))
	var sun := DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-50, 30, 0)
	add_child(sun)
	var env := WorldEnvironment.new()
	env.environment = Environment.new()
	env.environment.background_mode = Environment.BG_COLOR
	env.environment.background_color = Color(0.93, 0.92, 0.9)
	env.environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	env.environment.ambient_light_color = Color(0.7, 0.7, 0.7)
	add_child(env)
	var floor := MeshInstance3D.new()
	var plane := PlaneMesh.new()
	plane.size = Vector2(12, 6)
	floor.mesh = plane
	add_child(floor)
