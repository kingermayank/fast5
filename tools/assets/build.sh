#!/bin/bash
# Rebuilds public/models from the source downloads in assets-src/.
# Needs Blender's Python module: python3 -m venv .bpy && .bpy/bin/pip install bpy==5.2.2
# (or point BPY_PYTHON at any Python with `import bpy`).
set -euo pipefail
cd "$(dirname "$0")/../.."
PY=${BPY_PYTHON:-.bpy/bin/python}
TMP=$(mktemp -d)
mkdir -p public/models

# asset  max-texture-size
for spec in "charger 1024" "skyline 1024" "police 1024" "christ 512"; do
  set -- $spec
  echo "== $1"
  "$PY" tools/assets/process.py "$1" "assets-src/$1.glb" "$TMP/$1.glb" 2>&1 | grep -E "^$1:|Error|error" || true
  node tools/assets/optimize.mjs "$TMP/$1.glb" "public/models/$1.glb" "$2"
  ls -la "public/models/$1.glb" | awk '{printf "   %.1f MB\n", $5/1e6}'
done
rm -rf "$TMP"
