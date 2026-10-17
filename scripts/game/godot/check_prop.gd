extends SceneTree
## Loads every res://props/*.glb as Godot imported it and prints one JSON line
## per file with what a game gets from it:
##   {"file", "meshes", "triangles", "materials", "aabb": [min, max] (scene space),
##    "bodies", "shapes", "hull_points", "hull_planes", "max_outside", "ok", "problems"}
## A "-convcolonly" node must come back as a StaticBody3D whose CollisionShape3D
## holds a ConvexPolygonShape3D; max_outside is how far any visual vertex lies
## outside that hull (planes rebuilt from the shape's points), metres.
## usage: godot --headless --path <project> -s res://check_prop.gd

const EPS := 1e-5


func _init() -> void:
	var failed := false
	for file in DirAccess.get_files_at("res://props"):
		if not file.ends_with(".glb"):
			continue
		var result := check("res://props/" + file)
		print(JSON.stringify(result))
		failed = failed or not result["ok"]
	quit(1 if failed else 0)


func find_all(node: Node, cls: String, out: Array) -> Array:
	if node.is_class(cls):
		out.append(node)
	for child in node.get_children():
		find_all(child, cls, out)
	return out


## `node`'s transform in the space of `top` (its imported scene root).
func scene_xf(node: Node, top: Node) -> Transform3D:
	var xf := Transform3D.IDENTITY
	var n := node
	while n != top and n != null:
		if n is Node3D:
			xf = (n as Node3D).transform * xf
		n = n.get_parent()
	return xf


## Face planes (normal, offset) of the convex hull of `pts`: every triple whose
## plane has all points on one side. Brute force is fine at <= 64 points.
func hull_planes(pts: PackedVector3Array) -> Array:
	var planes := []
	var n_pts := pts.size()
	for i in n_pts:
		for j in range(i + 1, n_pts):
			for k in range(j + 1, n_pts):
				var n := (pts[j] - pts[i]).cross(pts[k] - pts[i])
				if n.length() < 1e-9:
					continue
				n = n.normalized()
				var d := n.dot(pts[i])
				var above := false
				var below := false
				for p in pts:
					var s := n.dot(p) - d
					above = above or s > EPS
					below = below or s < -EPS
					if above and below:
						break
				if above and below:
					continue
				planes.append([n, d] if not above else [-n, -d])
	return planes


func check(path: String) -> Dictionary:
	var problems: Array[String] = []
	var scene: Node3D = (load(path) as PackedScene).instantiate()
	# Not inside the tree yet in _init, so transforms are composed by hand (scene_xf).
	var result := {"file": path.get_file(), "ok": false, "problems": problems}
	var meshes := find_all(scene, "MeshInstance3D", [])
	var bodies := find_all(scene, "StaticBody3D", [])
	var shapes := find_all(scene, "CollisionShape3D", [])
	result["meshes"] = meshes.size()
	result["bodies"] = bodies.size()
	result["shapes"] = shapes.size()

	var verts := PackedVector3Array()
	var tris := 0
	var materials := {}
	for mi in meshes:
		var m: Mesh = mi.mesh
		var xf := scene_xf(mi, scene)
		for s in m.get_surface_count():
			var arrays := m.surface_get_arrays(s)
			for v in arrays[Mesh.ARRAY_VERTEX]:
				verts.append(xf * v)
			var idx: PackedInt32Array = arrays[Mesh.ARRAY_INDEX]
			tris += idx.size() / 3
			var mat: Material = (mi as MeshInstance3D).get_active_material(s)
			if mat:
				materials[mat.get_instance_id()] = true
	result["triangles"] = tris
	result["materials"] = materials.size()
	var lo := Vector3(INF, INF, INF)
	var hi := -lo
	for v in verts:
		lo = lo.min(v)
		hi = hi.max(v)
	result["aabb"] = [[lo.x, lo.y, lo.z], [hi.x, hi.y, hi.z]]

	var hull_points := 0
	var max_outside := INF
	for cs in shapes:
		var shape: Shape3D = cs.shape
		if not shape is ConvexPolygonShape3D:
			problems.append("collision shape is %s, not ConvexPolygonShape3D" % shape.get_class())
			continue
		var pts := PackedVector3Array()
		var xf := scene_xf(cs, scene)
		for p in (shape as ConvexPolygonShape3D).points:
			pts.append(xf * p)
		hull_points += pts.size()
		var planes := hull_planes(pts)
		result["hull_planes"] = planes.size()
		var worst := 0.0
		for v in verts:
			var out := -INF
			for pl in planes:
				out = max(out, (pl[0] as Vector3).dot(v) - float(pl[1]))
			worst = max(worst, out)
		max_outside = worst if max_outside == INF else max(max_outside, worst)
	result["hull_points"] = hull_points
	result["max_outside"] = max_outside if max_outside != INF else null
	if meshes.is_empty():
		problems.append("no MeshInstance3D")
	if bodies.is_empty() or shapes.is_empty():
		problems.append("no StaticBody3D / CollisionShape3D: the -convcolonly node was not turned into collision")
	result["ok"] = problems.is_empty()
	scene.free()
	return result
