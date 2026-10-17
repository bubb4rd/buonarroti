extends SceneTree
## Loads every res://equip/*.glb as Godot imported it (a skinned character plus
## a "Prop" mesh parented to a bone), plays its walk frame by frame and prints
## one JSON line per file:
##   {"file", "bone", "animation", "frames", "follow_err", "fist_drift", "grip_bones",
##    "min_clearance", "clearance_frame", "clearance_bone", "intersections", "ok", "problems"}
## follow_err: the Prop's global origin, as Godot's BoneAttachment3D placed it,
## vs the hand bone's pose times the prop's rest offset (m). fist_drift: range
## of the distance between the prop's origin and the skinned fist's centroid (m).
## min_clearance: closest approach of any prop vertex to the body's surface
## (capped at NEAR), 0 when a prop edge passes through a body triangle. The
## grip region — body within NEAR of the item in the rest pose — is excluded;
## grip_bones are the dominant bones of what was excluded.
## Runs in the first _process frame, when the scene is inside the tree and the
## attachment follows its skeleton like in a game.
## usage: godot --headless --path <project> -s res://check_equip.gd -- <hand_weight>

const FPS := 30.0
const BONE := "RightHand"
const NEAR := 0.06
const CELL := 0.06

## Vertices weighted at least this much to the hand are the fist the item sits in (EQUIP_BUDGET.handWeight).
var hand_weight := 0.5
var done := false


func _process(_delta: float) -> bool:
	if done:
		return true
	done = true
	var user := OS.get_cmdline_user_args()
	if user.size() > 0:
		hand_weight = float(user[0])
	var failed := false
	for file in DirAccess.get_files_at("res://equip"):
		if not file.ends_with(".glb"):
			continue
		var result := check("res://equip/" + file)
		print(JSON.stringify(result))
		failed = failed or not result["ok"]
	quit(1 if failed else 0)
	return true


func find_all(node: Node, cls: String, out: Array) -> Array:
	if node.is_class(cls):
		out.append(node)
	for child in node.get_children():
		find_all(child, cls, out)
	return out


func skin_mats(mi: MeshInstance3D, skel: Skeleton3D) -> Array[Transform3D]:
	var skin: Skin = mi.skin
	var mats: Array[Transform3D] = []
	for b in skin.get_bind_count():
		var name := skin.get_bind_name(b)
		var bone := skel.find_bone(name) if name != "" else skin.get_bind_bone(b)
		mats.append(skel.get_bone_global_pose(bone) * skin.get_bind_pose(b))
	return mats


func skinned(verts: PackedVector3Array, bones: PackedInt32Array, weights: PackedFloat32Array, per: int, mats: Array[Transform3D]) -> PackedVector3Array:
	var out := PackedVector3Array()
	out.resize(verts.size())
	for v in verts.size():
		var p := Vector3.ZERO
		for k in per:
			var w := weights[v * per + k]
			if w > 0.0:
				p += (mats[bones[v * per + k]] * verts[v]) * w
		out[v] = p
	return out


func cell_of(p: Vector3) -> Vector3i:
	return Vector3i((p / CELL).floor())


func point_triangle(p: Vector3, a: Vector3, b: Vector3, c: Vector3) -> float:
	var n := (b - a).cross(c - a)
	if n.length() > 1e-12:
		n = n.normalized()
		for dir in [n, -n]:
			var hit = Geometry3D.ray_intersects_triangle(p, dir, a, b, c)
			if hit != null:
				return p.distance_to(hit)
	var d := p.distance_to(Geometry3D.get_closest_point_to_segment(p, a, b))
	d = min(d, p.distance_to(Geometry3D.get_closest_point_to_segment(p, b, c)))
	return min(d, p.distance_to(Geometry3D.get_closest_point_to_segment(p, c, a)))


func check(path: String) -> Dictionary:
	var problems: Array[String] = []
	var result := {"file": path.get_file(), "ok": false, "problems": problems}
	var scene: Node3D = (load(path) as PackedScene).instantiate()
	root.add_child(scene)
	var skels := find_all(scene, "Skeleton3D", [])
	var players := find_all(scene, "AnimationPlayer", [])
	var body: MeshInstance3D = null
	var prop: MeshInstance3D = null
	for mi in find_all(scene, "MeshInstance3D", []):
		if (mi as MeshInstance3D).skin != null:
			body = mi
		elif String(mi.name).begins_with("Prop"):
			prop = mi
	if skels.is_empty() or players.is_empty() or body == null or prop == null:
		problems.append("missing Skeleton3D / AnimationPlayer / skinned body / Prop mesh")
		return result
	var skel: Skeleton3D = skels[0]
	var player: AnimationPlayer = players[0]
	var att: BoneAttachment3D = null
	var n: Node = prop.get_parent()
	while n != null and n != scene:
		if n is BoneAttachment3D:
			att = n
			break
		n = n.get_parent()
	result["bone"] = att.bone_name if att else null
	if att == null or att.bone_name != BONE:
		problems.append("Prop is not under a BoneAttachment3D on %s" % BONE)
		return result
	var bone_idx := skel.find_bone(BONE)
	var offset: Transform3D = att.global_transform.affine_inverse() * prop.global_transform

	var anim_name: StringName = &""
	for a in player.get_animation_list():
		if String(a).begins_with("walk"):
			anim_name = a
	if anim_name == &"":
		problems.append("no walk clip")
		return result
	var anim := player.get_animation(anim_name)
	result["animation"] = String(anim_name)

	# Body: skinning data, the right fist's vertices, triangles outside the fist.
	var arrays := body.mesh.surface_get_arrays(0)
	var verts: PackedVector3Array = arrays[Mesh.ARRAY_VERTEX]
	var bones: PackedInt32Array = arrays[Mesh.ARRAY_BONES]
	var weights: PackedFloat32Array = arrays[Mesh.ARRAY_WEIGHTS]
	var indices: PackedInt32Array = arrays[Mesh.ARRAY_INDEX]
	var per := bones.size() / verts.size()
	var hand_bind := -1
	var skin: Skin = body.skin
	for b in skin.get_bind_count():
		if skin.get_bind_name(b) == BONE or (skin.get_bind_name(b) == "" and skin.get_bind_bone(b) == bone_idx):
			hand_bind = b
	var fist := PackedInt32Array()
	for v in verts.size():
		var w := 0.0
		for k in per:
			if bones[v * per + k] == hand_bind:
				w += weights[v * per + k]
		if w >= hand_weight:
			fist.append(v)
	var dominant := PackedInt32Array()
	dominant.resize(verts.size())
	for v in verts.size():
		var best := 0
		for k in per:
			if weights[v * per + k] > weights[v * per + best]:
				best = k
		dominant[v] = bones[v * per + best]

	var parrays := prop.mesh.surface_get_arrays(0)
	var pverts: PackedVector3Array = parrays[Mesh.ARRAY_VERTEX]
	var pidx: PackedInt32Array = parrays[Mesh.ARRAY_INDEX]
	var pedges := {}
	for t in range(0, pidx.size(), 3):
		for e in [[pidx[t], pidx[t + 1]], [pidx[t + 1], pidx[t + 2]], [pidx[t + 2], pidx[t]]]:
			pedges[mini(e[0], e[1]) * 1000003 + maxi(e[0], e[1])] = e

	# The grip: body vertices within NEAR of the item in the rest pose (the
	# A-pose, hand away from everything else) are the hand holding it, never
	# body to clear; weights alone miss the wrist and finger blend around it.
	skel.reset_bone_poses()
	att.on_skeleton_update()
	var rest_pos := skinned(verts, bones, weights, per, skin_mats(body, skel))
	var rest_xf := skel.global_transform.affine_inverse() * prop.global_transform
	var prop_grid := {}
	for pv in pverts:
		var p: Vector3 = rest_xf * pv
		var c := cell_of(p)
		if not prop_grid.has(c):
			prop_grid[c] = []
		prop_grid[c].append(p)
	var excluded := PackedByteArray()
	excluded.resize(verts.size())
	var grip_bones := {}
	for v in verts.size():
		var c := cell_of(rest_pos[v])
		for dx in [-1, 0, 1]:
			for dy in [-1, 0, 1]:
				for dz in [-1, 0, 1]:
					var key := c + Vector3i(dx, dy, dz)
					if excluded[v] or not prop_grid.has(key):
						continue
					for p in prop_grid[key]:
						if rest_pos[v].distance_to(p) <= NEAR:
							excluded[v] = 1
							grip_bones[skel.get_bone_name(dominant[v])] = true
							break
	result["grip_bones"] = grip_bones.keys()
	var vert_tris := {}
	for t in range(0, indices.size(), 3):
		if excluded[indices[t]] or excluded[indices[t + 1]] or excluded[indices[t + 2]]:
			continue
		for k in 3:
			var v: int = indices[t + k]
			if not vert_tris.has(v):
				vert_tris[v] = []
			vert_tris[v].append(t)

	var frames := int(round(anim.length * FPS))
	var follow := 0.0
	var dmin := INF
	var dmax := -INF
	var clearance := NEAR
	var clear_frame := -1
	var clear_bone := ""
	var crossings := 0
	var crossing_frames := {}
	var crossing_bones := {}
	var travel := 0.0
	var start := Vector3.ZERO
	player.play(anim_name)
	for f in frames + 1:
		player.seek(f / FPS, true)
		att.on_skeleton_update()
		var bone_xf := skel.global_transform * skel.get_bone_global_pose(bone_idx)
		var expected := bone_xf * offset
		follow = max(follow, prop.global_transform.origin.distance_to(expected.origin))
		var to_skel := skel.global_transform.affine_inverse() * prop.global_transform
		if f == 0:
			start = to_skel.origin
		travel = max(travel, start.distance_to(to_skel.origin))
		var pos := skinned(verts, bones, weights, per, skin_mats(body, skel))
		var centroid := Vector3.ZERO
		for v in fist:
			centroid += pos[v]
		centroid /= max(1, fist.size())
		var dist := centroid.distance_to(to_skel.origin)
		dmin = min(dmin, dist)
		dmax = max(dmax, dist)
		# Body vertices (not the fist) hashed by cell; the prop's vertices look up their neighbourhood.
		var grid := {}
		for v in verts.size():
			if not vert_tris.has(v):
				continue
			var c := cell_of(pos[v])
			if not grid.has(c):
				grid[c] = []
			grid[c].append(v)
		var ppos := PackedVector3Array()
		ppos.resize(pverts.size())
		var near_tris := {}
		for i in pverts.size():
			var p: Vector3 = to_skel * pverts[i]
			ppos[i] = p
			var c := cell_of(p)
			for dx in [-1, 0, 1]:
				for dy in [-1, 0, 1]:
					for dz in [-1, 0, 1]:
						var key := c + Vector3i(dx, dy, dz)
						if not grid.has(key):
							continue
						for v in grid[key]:
							if pos[v].distance_to(p) > NEAR:
								continue
							for t in vert_tris[v]:
								near_tris[t] = true
							var d := INF
							for t in vert_tris[v]:
								d = min(d, point_triangle(p, pos[indices[t]], pos[indices[t + 1]], pos[indices[t + 2]]))
							if d < clearance:
								clearance = d
								clear_frame = f
								clear_bone = skel.get_bone_name(dominant[v])
		for e in pedges.values():
			var a := ppos[e[0]]
			var b := ppos[e[1]]
			for t in near_tris:
				if Geometry3D.segment_intersects_triangle(a, b, pos[indices[t]], pos[indices[t + 1]], pos[indices[t + 2]]) != null:
					crossings += 1
					crossing_frames[f] = crossing_frames.get(f, 0) + 1
					crossing_bones[skel.get_bone_name(dominant[indices[t]])] = true
					if clearance > 0.0:
						clear_frame = f
						clear_bone = skel.get_bone_name(dominant[indices[t]])
					clearance = 0.0
	result["frames"] = frames + 1
	result["follow_err"] = follow
	result["fist_drift"] = dmax - dmin
	result["min_clearance"] = clearance
	result["clearance_frame"] = clear_frame
	result["clearance_bone"] = clear_bone
	result["intersections"] = crossings
	result["intersection_frames"] = crossing_frames.size()
	result["intersection_bones"] = crossing_bones.keys()
	result["hand_travel"] = travel
	result["ok"] = problems.is_empty()
	scene.queue_free()
	return result
