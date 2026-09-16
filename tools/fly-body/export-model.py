#!/usr/bin/env python3
"""Export FlyBody's anatomical rig for rendering, not browser physics.

Needs mujoco, numpy, trimesh and fast-simplification. Source model: Apache-2.0.
Usage: python export-model.py /path/to/flybody /path/to/site/fly/assets/body
The original meshes are simplified; joint frames and limits are preserved.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import mujoco
import numpy as np
import trimesh

source, out = map(Path, sys.argv[1:])
out.mkdir(parents=True, exist_ok=True)
m = mujoco.MjModel.from_xml_path(str(source / 'flybody/fruitfly/assets/floor.xml'))
d = mujoco.MjData(m)
mujoco.mj_forward(m, d)
binary = bytearray()
def array(a, dtype):
    a = np.asarray(a, dtype=dtype)
    result = {'offset': len(binary), 'length': a.size}
    binary.extend(a.tobytes())
    return result
def name(kind, i):
    return mujoco.mj_id2name(m, kind, i)
def vec(a):
    return np.round(a, 8).tolist()
meshes = []
for i in range(m.nmesh):
    n = name(mujoco.mjtObj.mjOBJ_MESH, i)
    va, vn = m.mesh_vertadr[i], m.mesh_vertnum[i]
    fa, fn = m.mesh_faceadr[i], m.mesh_facenum[i]
    mesh = trimesh.Trimesh(m.mesh_vert[va:va+vn], m.mesh_face[fa:fa+fn], process=False)
    # Compiled OBJ vertices repeat at normal/UV seams. Weld them before edge
    # collapse, otherwise simplification removes isolated triangles like confetti.
    mesh.merge_vertices()
    budget = 3600 if n in ('head', 'head_red', 'thorax') else 1600 if 'wing' in n else 700 if 'abdomen' in n else 400
    if 'black' in n or 'bristle' in n:
        budget = fn  # Preserve fine disconnected bristles instead of deleting them.
    if fn > budget:
        mesh = mesh.simplify_quadric_decimation(face_count=budget)
    meshes.append({'name': n, 'position': array(mesh.vertices, '<f4'), 'index': array(mesh.faces, '<u4')})
bodies = []
for i in range(1, m.nbody):
    joints = []
    for j in range(m.body_jntadr[i], m.body_jntadr[i] + m.body_jntnum[i]):
        if m.jnt_type[j] == mujoco.mjtJoint.mjJNT_FREE:
            continue
        joints.append({'name': name(mujoco.mjtObj.mjOBJ_JOINT, j), 'axis': vec(m.jnt_axis[j]),
                       'pos': vec(m.jnt_pos[j]), 'range': vec(m.jnt_range[j]),
                       'rest': float(m.qpos0[m.jnt_qposadr[j]]), 'type': int(m.jnt_type[j])})
    geoms = []
    for g in range(m.body_geomadr[i], m.body_geomadr[i] + m.body_geomnum[i]):
        if m.geom_type[g] != mujoco.mjtGeom.mjGEOM_MESH:
            continue
        material = int(m.geom_matid[g])
        geoms.append({'mesh': int(m.geom_dataid[g]), 'pos': vec(m.geom_pos[g]), 'quat': vec(m.geom_quat[g]),
                      'rgba': vec(m.mat_rgba[material] if material >= 0 else m.geom_rgba[g])})
    bodies.append({'id': i, 'name': name(mujoco.mjtObj.mjOBJ_BODY, i), 'parent': int(m.body_parentid[i]),
                   'pos': vec(m.body_pos[i]), 'quat': vec(m.body_quat[i]), 'joints': joints, 'geoms': geoms})
rig = {'v': 1, 'units': 'centimetres', 'source': 'https://github.com/TuragaLab/flybody',
       'commit': subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip(),
       'license': 'Apache-2.0', 'modifications': 'Decimated meshes; renderer rig exported from compiled model. No physics engine included.',
       'meshSha256': hashlib.sha256(binary).hexdigest(), 'meshes': meshes, 'bodies': bodies}
(out / 'rig.json').write_text(json.dumps(rig, separators=(',', ':')) + '\n')
(out / 'meshes.bin').write_bytes(binary)
(out / 'LICENSE-FLYBODY').write_bytes((source / 'LICENSE').read_bytes())
print(json.dumps({'bodies': len(bodies), 'meshes': len(meshes), 'bytes': len(binary), 'sha256': rig['meshSha256']}))
