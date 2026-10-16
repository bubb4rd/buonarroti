extends SceneTree
## Loads every res://characters/*.glb as Godot imported it, plays its looping
## clip and skins the mesh on the CPU from Godot's own data (Skin bind poses,
## Skeleton3D poses after AnimationPlayer.seek, ARRAY_BONES / ARRAY_WEIGHTS),
## frame by frame. Prints one JSON line per character:
##   {"file", "animation", "loop", "length", "frames", "bones", "max_influences",
##    "weight_sum_err", "max_stretch", "edges_over_2x", "max_seam_gap", "min_y", "ok", "problems"}
## Tearing shows up as edges that grow far beyond their rest length. Cracks
## show up as vertices that share a rest position (glTF splits vertices at UV
## and normal seams) drifting apart; max_seam_gap is that distance / height.
## usage: godot --headless --path scripts/game/godot -s res://check_walk.gd

const FPS := 30.0
const MAX_STRETCH := 2.5
const MAX_SEAM_GAP := 0.001


func _init() -> void:
	var failed := false
	for file in DirAccess.get_files_at("res://characters"):
		if not file.ends_with(".glb"):
			continue
		var result := check("res://characters/" + file)
		print(JSON.stringify(result))
		failed = failed or not result["ok"]
	quit(1 if failed else 0)


func find_all(node: Node, cls: String, out: Array) -> Array:
	if node.is_class(cls):
		out.append(node)
	for child in node.get_children():
		find_all(child, cls, out)
	return out


func skinned_positions(mi: MeshInstance3D, skel: Skeleton3D, verts: PackedVector3Array,
		bones: PackedInt32Array, weights: PackedFloat32Array, per_vertex: int) -> PackedVector3Array:
	var skin: Skin = mi.skin
	# Skin bind i -> skeleton bone, by name when present (Godot's importer binds by name).
	var bind_to_bone := PackedInt32Array()
	for b in skin.get_bind_count():
		var name := skin.get_bind_name(b)
		bind_to_bone.append(skel.find_bone(name) if name != "" else skin.get_bind_bone(b))
	var mats: Array[Transform3D] = []
	for b in skin.get_bind_count():
		mats.append(skel.get_bone_global_pose(bind_to_bone[b]) * skin.get_bind_pose(b))
	var out := PackedVector3Array()
	out.resize(verts.size())
	for v in verts.size():
		var p := Vector3.ZERO
		for k in per_vertex:
			var w := weights[v * per_vertex + k]
			if w > 0.0:
				p += (mats[bones[v * per_vertex + k]] * verts[v]) * w
		out[v] = p
	return out


func check(path: String) -> Dictionary:
	var problems: Array[String] = []
	var scene: Node = (load(path) as PackedScene).instantiate()
	root.add_child(scene)
	var players := find_all(scene, "AnimationPlayer", [])
	var skels := find_all(scene, "Skeleton3D", [])
	var meshes := find_all(scene, "MeshInstance3D", [])
	var result := {"file": path.get_file(), "ok": false, "problems": problems}
	if players.is_empty() or skels.is_empty() or meshes.is_empty():
		problems.append("missing AnimationPlayer / Skeleton3D / MeshInstance3D")
		return result
	var player: AnimationPlayer = players[0]
	var skel: Skeleton3D = skels[0]
	var mi: MeshInstance3D = meshes[0]
	var anims := player.get_animation_list()
	if anims.is_empty():
		problems.append("no animation")
		return result
	var anim_name: StringName = anims[0]
	var anim := player.get_animation(anim_name)
	result["animation"] = String(anim_name)
	result["loop"] = anim.loop_mode == Animation.LOOP_LINEAR
	result["length"] = anim.length
	result["bones"] = skel.get_bone_count()
	if not result["loop"]:
		problems.append("clip does not loop")

	var arrays := mi.mesh.surface_get_arrays(0)
	var verts: PackedVector3Array = arrays[Mesh.ARRAY_VERTEX]
	var bones: PackedInt32Array = arrays[Mesh.ARRAY_BONES]
	var weights: PackedFloat32Array = arrays[Mesh.ARRAY_WEIGHTS]
	var indices: PackedInt32Array = arrays[Mesh.ARRAY_INDEX]
	var per_vertex := bones.size() / verts.size()
	var max_infl := 0
	var sum_err := 0.0
	for v in verts.size():
		var n := 0
		var s := 0.0
		for k in per_vertex:
			var w := weights[v * per_vertex + k]
			if w > 0.0:
				n += 1
				s += w
		max_infl = max(max_infl, n)
		sum_err = max(sum_err, abs(s - 1.0))
	result["max_influences"] = max_infl
	result["weight_sum_err"] = sum_err

	# Unique edges from the triangle list.
	var seen := {}
	var edges := PackedInt32Array()
	for t in range(0, indices.size(), 3):
		for e in [[indices[t], indices[t + 1]], [indices[t + 1], indices[t + 2]], [indices[t + 2], indices[t]]]:
			var a: int = min(e[0], e[1])
			var b: int = max(e[0], e[1])
			var key := a * 1000003 + b
			if not seen.has(key):
				seen[key] = true
				edges.append(a)
				edges.append(b)
	var rest_len := PackedFloat32Array()
	var lens := []
	for i in range(0, edges.size(), 2):
		var l := verts[edges[i]].distance_to(verts[edges[i + 1]])
		rest_len.append(l)
		lens.append(l)
	lens.sort()
	var min_len: float = lens[lens.size() / 2] / 3.0

	# Seam pairs: vertices at the same rest position (within 1e-5 of height).
	var lo := Vector3(INF, INF, INF)
	var hi := -lo
	for p in verts:
		lo = lo.min(p)
		hi = hi.max(p)
	var height := hi.y - lo.y
	var q := 1e-5 * height
	var first := {}
	var seams := PackedInt32Array()
	for v in verts.size():
		var key := Vector3i((verts[v] / q).round())
		if first.has(key):
			seams.append(first[key])
			seams.append(v)
		else:
			first[key] = v

	var frames := int(round(anim.length * FPS))
	var max_stretch := 0.0
	var max_gap := 0.0
	var over := {}
	var min_y := INF
	player.play(anim_name)
	for f in frames + 1:
		player.seek(f / FPS, true)
		var pos := skinned_positions(mi, skel, verts, bones, weights, per_vertex)
		for p in pos:
			min_y = min(min_y, p.y)
		for i in range(0, edges.size(), 2):
			var l0 := rest_len[i / 2]
			if l0 < min_len:
				continue
			var r := pos[edges[i]].distance_to(pos[edges[i + 1]]) / l0
			if r > max_stretch:
				max_stretch = r
			if r > 2.0:
				over[i / 2] = true
		for i in range(0, seams.size(), 2):
			max_gap = max(max_gap, pos[seams[i]].distance_to(pos[seams[i + 1]]))
	result["frames"] = frames + 1
	result["max_stretch"] = max_stretch
	result["edges_over_2x"] = over.size()
	result["seam_pairs"] = seams.size() / 2
	result["max_seam_gap"] = max_gap / height
	result["min_y"] = min_y
	if max_infl > 4:
		problems.append("more than 4 influences")
	if sum_err > 1e-3:
		problems.append("weights not normalised")
	if max_stretch > MAX_STRETCH:
		problems.append("edge stretch %.2f > %.1f (tearing)" % [max_stretch, MAX_STRETCH])
	if max_gap / height > MAX_SEAM_GAP:
		problems.append("seams open %.2f%% of height > %.1f%% (cracks)" % [100 * max_gap / height, 100 * MAX_SEAM_GAP])
	result["ok"] = problems.is_empty()
	scene.queue_free()
	return result
