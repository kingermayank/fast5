import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

/**
 * Downloaded models, cleaned up by tools/assets (see assets-src/README.md for
 * sources and licenses). Anything that fails to load falls back to the
 * procedural models, so the game always runs.
 */
export type ModelId = 'charger' | 'skyline' | 'police' | 'christ';
const IDS: ModelId[] = ['charger', 'skyline', 'police', 'christ'];

const models = new Map<ModelId, THREE.Object3D>();

export async function loadModels(): Promise<void> {
  // Debug: ?procedural skips the downloaded models.
  if (new URL(location.href).searchParams.has('procedural')) return;
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  await Promise.all(
    IDS.map(async (id) => {
      // .glb normally; some static hosts only serve JSON, so the same model can also ship as
      // a self-contained .gltf.json (tools/assets/to-json.mjs).
      for (const ext of ['glb', 'gltf.json']) {
        try {
          const gltf = await loader.loadAsync(`${import.meta.env.BASE_URL}models/${id}.${ext}`);
          models.set(id, gltf.scene);
          return;
        } catch {
          // Try the next format.
        }
      }
      console.warn(`[assets] ${id} failed to load; using the procedural model`);
    }),
  );
}

export function model(id: ModelId): THREE.Object3D | undefined {
  return models.get(id);
}
