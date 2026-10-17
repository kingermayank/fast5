// Car models from the .mesh blobs that tools/rive/pack-models.mjs writes:
// one vertex and index buffer per model, with the index ranges of the body and
// of each wheel (whose vertices sit around the wheel's own centre, so it can
// spin and steer).
import { GpuMesh, GameRenderer } from "./render";
import { M4 } from "./util";

export class Model {
  mesh: GpuMesh;
  /** Index ranges: 0 body, 1-4 wheels FL FR RL RR. */
  first: StaticArray<u32> = new StaticArray<u32>(5);
  count: StaticArray<u32> = new StaticArray<u32>(5);
  pivotX: StaticArray<f64> = new StaticArray<f64>(5);
  pivotY: StaticArray<f64> = new StaticArray<f64>(5);
  pivotZ: StaticArray<f64> = new StaticArray<f64>(5);

  constructor(mesh: GpuMesh) {
    this.mesh = mesh;
  }

  static parse(bytes: ArrayBuffer): Model? {
    let u = Uint32Array.wrap(bytes);
    let f = Float32Array.wrap(bytes);
    if (u[0] != 0x534d3546) return null;
    let i = 2;
    let groups = <i32>u[i++];
    let px = new StaticArray<f64>(5), py = new StaticArray<f64>(5), pz = new StaticArray<f64>(5);
    for (let g = 0; g < groups; g++) {
      px[g] = <f64>f[i++];
      py[g] = <f64>f[i++];
      pz[g] = <f64>f[i++];
      i++; // radius
    }
    let parts = <i32>u[i++];
    let lo = new StaticArray<u32>(5), hi = new StaticArray<u32>(5);
    for (let g = 0; g < 5; g++) {
      lo[g] = 0xffffffff;
      hi[g] = 0;
    }
    for (let p = 0; p < parts; p++) {
      let g = <i32>u[i++];
      let first = u[i++];
      let count = u[i++];
      if (first < lo[g]) lo[g] = first;
      if (first + count > hi[g]) hi[g] = first + count;
    }
    let vertices = u[i++];
    let vOffset = <u32>(i * 4);
    let vBytes = vertices * 20;
    i += <i32>(vertices * 5);
    let indices = u[i++];
    let iOffset = <u32>(i * 4);
    let mesh = GpuMesh.from(bytes, vOffset, vBytes, bytes, iOffset, indices * 4);
    let m = new Model(mesh);
    for (let g = 0; g < 5; g++) {
      m.first[g] = lo[g] == 0xffffffff ? 0 : lo[g];
      m.count[g] = lo[g] == 0xffffffff ? 0 : hi[g] - lo[g];
      m.pivotX[g] = px[g];
      m.pivotY[g] = py[g];
      m.pivotZ[g] = pz[g];
    }
    return m;
  }

  /**
   * Queues the car: body leaning by pitch and roll, front wheels steered, all
   * four spinning. `params` are the lamp and beacon uniforms.
   */
  draw(gfx: GameRenderer, x: f64, z: f64, yaw: f64, pitch: f64, roll: f64, steer: f64, spinFront: f64, spinRear: f64,
       paint: u32, gloss: f64, brake: f64, head: f64, beacon: f64): void {
    let body = M4.pose(x, 0.02, z, yaw, pitch, roll, 1);
    let slot = gfx.object(body, paint, gloss, brake, head, beacon, 0);
    gfx.mesh(this.mesh, this.first[0], this.count[0], slot, true);
    let base = M4.pose(x, 0, z, yaw, 0, 0, 1);
    for (let g = 1; g < 5; g++) {
      if (this.count[g] == 0) continue;
      let front = g <= 2;
      let wheel = M4.pose(this.pivotX[g], this.pivotY[g], this.pivotZ[g], front ? steer : 0, front ? spinFront : spinRear, 0, 1);
      let ws = gfx.object(base.mul(wheel), paint, gloss, 0, 0, 0, 0);
      gfx.mesh(this.mesh, this.first[g], this.count[g], ws, false);
    }
  }
}
