import * as THREE from 'three';
import { NIGHT } from './look';

function canvasTexture(
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext('2d')!);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function noise(ctx: CanvasRenderingContext2D, w: number, h: number, count: number, alpha: number) {
  for (let i = 0; i < count; i++) {
    const v = Math.random() * 255;
    ctx.fillStyle = `rgba(${v},${v},${v},${alpha})`;
    ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
  }
}

export function asphaltTexture(): THREE.CanvasTexture {
  return canvasTexture(512, 512, (ctx) => {
    // A shade lighter than real asphalt, so streets don't go black from above.
    ctx.fillStyle = '#404247';
    ctx.fillRect(0, 0, 512, 512);
    noise(ctx, 512, 512, 30000, 0.08);
    // Patches (soft, so they don't read as a repeating grid of squares from above), cracks and oil stains.
    for (let i = 0; i < 10; i++) {
      const x = Math.random() * 512;
      const y = Math.random() * 512;
      const r = 25 + Math.random() * 55;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(${Math.random() < 0.5 ? '20,20,22' : '70,72,76'},0.16)`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      for (const dx of [-512, 0, 512]) for (const dy of [-512, 0, 512]) ctx.fillRect(x - r + dx, y - r + dy, r * 2, r * 2);
    }
    ctx.strokeStyle = 'rgba(15,15,15,0.5)';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 14; i++) {
      let x = Math.random() * 512;
      let y = Math.random() * 512;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let k = 0; k < 6; k++) {
        x += (Math.random() - 0.5) * 40;
        y += (Math.random() - 0.5) * 40;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    for (let i = 0; i < 8; i++) {
      const g = ctx.createRadialGradient(256, 256, 0, 256, 256, 20);
      g.addColorStop(0, 'rgba(10,10,12,0.35)');
      g.addColorStop(1, 'rgba(10,10,12,0)');
      ctx.save();
      ctx.translate(Math.random() * 512 - 256, Math.random() * 512 - 256);
      ctx.fillStyle = g;
      ctx.fillRect(226, 226, 60, 60);
      ctx.restore();
    }
  });
}

/**
 * Worn city asphalt, 16 m to a repeat at 64 px/m: aggregate grain, repair
 * patches with sealed seams, branching cracks and oil stains, all tiling
 * seamlessly. Comes with a normal map made from the same surface, so the cracks
 * and the grain catch the lamps on a wet night as grooves and glints.
 */
export function asphaltTextures(): { map: THREE.CanvasTexture; normal: THREE.CanvasTexture } {
  const N = 1024;
  let seed = 9;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const tone = new Float32Array(N * N);
  const height = new Float32Array(N * N);
  const at = (x: number, y: number) => (((y % N) + N) % N) * N + (((x % N) + N) % N);
  // Seamless value noise: a lattice of `cells` per side, smoothly interpolated.
  const lattice = (cells: number) => {
    const v = Array.from({ length: cells * cells }, rand);
    const s = N / cells;
    return (x: number, y: number) => {
      const fx = x / s;
      const fy = y / s;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx);
      const sy = ty * ty * (3 - 2 * ty);
      const g = (i: number, j: number) => v[(((j % cells) + cells) % cells) * cells + (((i % cells) + cells) % cells)];
      const a = g(x0, y0) + (g(x0 + 1, y0) - g(x0, y0)) * sx;
      const b = g(x0, y0 + 1) + (g(x0 + 1, y0 + 1) - g(x0, y0 + 1)) * sx;
      return a + (b - a) * sy;
    };
  };
  const broad = lattice(6);
  const mid = lattice(24);
  const fine = lattice(128);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const grain = rand();
      tone[i] = 0.235 + (broad(x, y) - 0.5) * 0.06 + (mid(x, y) - 0.5) * 0.035 + (grain - 0.5) * 0.07;
      height[i] = (fine(x, y) - 0.5) * 0.8 + (grain - 0.5) * 0.9;
    }
  }
  // Cracks and seams: how much darker, and how deep, at each texel (applied once at the end, so
  // overlapping strokes don't stack up).
  const dark = new Float32Array(N * N);
  const groove = new Float32Array(N * N);
  // A thick line into those, wrapping round the tile.
  const stroke = (x0: number, y0: number, x1: number, y1: number, width: number, dTone: number, dHeight: number) => {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
    const r = Math.ceil(width / 2);
    for (let k = 0; k <= steps; k++) {
      const x = Math.round(x0 + ((x1 - x0) * k) / Math.max(1, steps));
      const y = Math.round(y0 + ((y1 - y0) * k) / Math.max(1, steps));
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r * r) continue;
          const i = at(x + dx, y + dy);
          dark[i] = Math.max(dark[i], dTone);
          groove[i] = Math.min(groove[i], dHeight);
        }
      }
    }
  };
  // Repair patches: squarer, a different tone, a sealed seam round the edge.
  for (let n = 0; n < 7; n++) {
    const w = 70 + rand() * 200;
    const h = 50 + rand() * 160;
    const x0 = rand() * N;
    const y0 = rand() * N;
    const d = rand() < 0.6 ? -0.035 : 0.03;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) tone[at(x0 + x, y0 + y)] += d;
    const seam = [[x0, y0, x0 + w, y0], [x0 + w, y0, x0 + w, y0 + h], [x0 + w, y0 + h, x0, y0 + h], [x0, y0 + h, x0, y0]];
    for (const [a, b, c, e] of seam) stroke(a, b, c, e, 3, 0.07, -0.6);
  }
  // Cracks: random walks that wander and fork.
  const crack = (x: number, y: number, dir: number, length: number, width: number) => {
    for (let k = 0; k < length; k++) {
      const step = 3 + rand() * 4;
      const nx = x + Math.cos(dir) * step;
      const ny = y + Math.sin(dir) * step;
      stroke(x, y, nx, ny, width, 0.11, -1.6);
      x = nx;
      y = ny;
      dir += (rand() - 0.5) * 0.7;
      if (rand() < 0.04 && width > 1.2) crack(x, y, dir + (rand() < 0.5 ? 1 : -1) * (0.6 + rand() * 0.6), length / 2, width * 0.7);
    }
  };
  for (let n = 0; n < 26; n++) crack(rand() * N, rand() * N, rand() * Math.PI * 2, 15 + rand() * 40, 1.3 + rand() * 1.2);
  // Oil and tyre stains: soft dark blots.
  for (let n = 0; n < 14; n++) {
    const cx = rand() * N;
    const cy = rand() * N;
    const r = 12 + rand() * 40;
    for (let y = -r; y <= r; y++) {
      for (let x = -r; x <= r; x++) {
        const d = Math.hypot(x, y) / r;
        if (d < 1) tone[at(cx + x, cy + y)] -= 0.05 * (1 - d * d);
      }
    }
  }
  for (let i = 0; i < N * N; i++) {
    tone[i] -= dark[i];
    height[i] = Math.min(height[i], groove[i]);
  }
  const make = (fill: (img: ImageData) => void) =>
    canvasTexture(N, N, (ctx) => {
      const img = ctx.createImageData(N, N);
      fill(img);
      ctx.putImageData(img, 0, 0);
    });
  const map = make((img) => {
    for (let i = 0; i < N * N; i++) {
      const v = Math.max(0, Math.min(1, tone[i])) * 255;
      img.data[i * 4] = v;
      img.data[i * 4 + 1] = v * 1.01;
      img.data[i * 4 + 2] = v * 1.06;
      img.data[i * 4 + 3] = 255;
    }
  });
  const normal = make((img) => {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const dx = (height[at(x + 1, y)] - height[at(x - 1, y)]) * 0.5;
        const dy = (height[at(x, y + 1)] - height[at(x, y - 1)]) * 0.5;
        const l = Math.hypot(dx, dy, 1);
        const i = (y * N + x) * 4;
        img.data[i] = ((-dx / l) * 0.5 + 0.5) * 255;
        img.data[i + 1] = ((dy / l) * 0.5 + 0.5) * 255;
        img.data[i + 2] = ((1 / l) * 0.5 + 0.5) * 255;
        img.data[i + 3] = 255;
      }
    }
  });
  normal.colorSpace = THREE.NoColorSpace;
  return { map, normal };
}

/**
 * Where the asphalt is wet, as a roughness map (green channel): standing water
 * in the dips and along the gutters is close to a mirror (dark), the rest damp
 * and rough. Wet streets catch the evening sky and every lamp and headlight,
 * which is most of the dusk look. Tiles every 32 m (repeat 0.5 on the asphalt's 16 m UVs).
 */
export function asphaltWetTexture(): THREE.CanvasTexture {
  const tex = canvasTexture(512, 512, (ctx) => {
    // Damp all over (a sheen on the whole road), near a mirror in the puddles.
    ctx.fillStyle = NIGHT ? 'rgb(100,100,100)' : 'rgb(200,200,200)';
    ctx.fillRect(0, 0, 512, 512);
    noise(ctx, 512, 512, 24000, 0.07);
    // Damp sheen: broad, faint glossier bands.
    for (let i = 0; i < 6; i++) {
      const y = Math.random() * 512;
      const g = ctx.createLinearGradient(0, y - 40, 0, y + 40);
      g.addColorStop(0, 'rgba(120,120,120,0)');
      g.addColorStop(0.5, 'rgba(120,120,120,0.35)');
      g.addColorStop(1, 'rgba(120,120,120,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, y - 40, 512, 80);
    }
    // Puddles: soft-edged, a little stretched, wrapped so the tile repeats seamlessly.
    for (let i = 0; i < 11; i++) {
      const x = Math.random() * 512;
      const y = Math.random() * 512;
      const r = 18 + Math.random() * 46;
      const stretch = 0.6 + Math.random() * 1.1;
      const turn = Math.random() * Math.PI;
      for (const dx of [-512, 0, 512]) {
        for (const dy of [-512, 0, 512]) {
          ctx.save();
          ctx.translate(x + dx, y + dy);
          ctx.rotate(turn);
          ctx.scale(stretch, 1);
          const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
          g.addColorStop(0, 'rgba(14,14,14,0.96)');
          g.addColorStop(0.55, 'rgba(26,26,26,0.85)');
          g.addColorStop(0.8, 'rgba(90,90,90,0.4)');
          g.addColorStop(1, 'rgba(200,200,200,0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(0, 0, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }
    }
  });
  tex.colorSpace = THREE.NoColorSpace;
  tex.repeat.set(0.5, 0.5);
  return tex;
}

export function sidewalkTexture(): THREE.CanvasTexture {
  return canvasTexture(128, 128, (ctx) => {
    ctx.fillStyle = '#b9b2a6';
    ctx.fillRect(0, 0, 128, 128);
    noise(ctx, 128, 128, 1500, 0.06);
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 2;
    for (let i = 0; i <= 128; i += 32) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, 128);
      ctx.moveTo(0, i);
      ctx.lineTo(128, i);
      ctx.stroke();
    }
  });
}

export type FacadeStyle = 'residential' | 'office' | 'colonial';

/**
 * A 4 x 4 block of window bays (24 m wide x 16 m tall per repeat) so the
 * pattern doesn't repeat every bay. Returns the color map (white wall, tinted
 * by the material) and an emissive map where some windows are lit for dusk.
 * Texel (0,0) is plain wall, so roofs (uv 0) sample wall.
 */
export function facadeTextures(style: FacadeStyle, seed: number): { map: THREE.CanvasTexture; emissive: THREE.CanvasTexture } {
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const W = 512;
  const bay = W / 4;
  const color = document.createElement('canvas');
  color.width = color.height = W;
  const glow = document.createElement('canvas');
  glow.width = glow.height = W;
  const c = color.getContext('2d')!;
  const g = glow.getContext('2d')!;
  c.fillStyle = '#efefef';
  c.fillRect(0, 0, W, W);
  noise(c, W, W, 6000, 0.05);
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, W);
  // Floor slab lines.
  c.fillStyle = 'rgba(0,0,0,0.10)';
  for (let row = 0; row < 4; row++) c.fillRect(0, row * bay + bay - 6, W, 6);

  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const x = col * bay;
      const y = row * bay;
      const lit = rand() < 0.28;
      const warm = rand() < 0.75 ? 'rgba(255,196,120,' : 'rgba(190,220,255,';
      if (style === 'office') {
        c.fillStyle = '#1d2a35';
        c.fillRect(x + 4, y + 20, bay - 8, bay - 44);
        c.fillStyle = 'rgba(150,190,220,0.35)';
        c.fillRect(x + 4, y + 20, (bay - 8) * 0.45, bay - 44);
        c.fillStyle = 'rgba(255,255,255,0.5)';
        c.fillRect(x + bay / 2 - 1, y + 20, 2, bay - 44);
        if (lit) {
          g.fillStyle = warm + '0.9)';
          g.fillRect(x + 4, y + 20, bay - 8, bay - 44);
        }
      } else {
        const ww = style === 'colonial' ? 40 : 56;
        const wh = style === 'colonial' ? 70 : 60;
        const wx = x + (bay - ww) / 2;
        const wy = y + 22;
        c.fillStyle = '#26323d';
        c.fillRect(wx, wy, ww, wh);
        c.fillStyle = 'rgba(160,200,230,0.3)';
        c.fillRect(wx, wy, ww / 2, wh);
        // Frame and sill.
        c.strokeStyle = 'rgba(255,255,255,0.85)';
        c.lineWidth = 4;
        c.strokeRect(wx, wy, ww, wh);
        c.fillStyle = 'rgba(0,0,0,0.18)';
        c.fillRect(wx - 6, wy + wh, ww + 12, 6);
        if (style === 'colonial') {
          // Wooden shutters, some closed.
          const shut = rand() < 0.3;
          c.fillStyle = ['#2f6b4f', '#6b3a2f', '#2f4f6b'][Math.floor(rand() * 3)];
          if (shut) c.fillRect(wx, wy, ww, wh);
          else {
            c.fillRect(wx - 16, wy, 14, wh);
            c.fillRect(wx + ww + 2, wy, 14, wh);
          }
          if (lit && !shut) {
            g.fillStyle = warm + '0.95)';
            g.fillRect(wx, wy, ww, wh);
          }
        } else {
          // Balcony rail on some floors.
          if (rand() < 0.5) {
            c.fillStyle = 'rgba(40,40,40,0.75)';
            c.fillRect(x + 10, wy + wh - 18, bay - 20, 3);
            for (let k = x + 12; k < x + bay - 10; k += 7) c.fillRect(k, wy + wh - 18, 2, 18);
          }
          if (lit) {
            g.fillStyle = warm + '0.9)';
            g.fillRect(wx + 2, wy + 2, ww - 4, wh - 4);
          }
        }
      }
    }
  }
  // Keep the (0,0) corner plain wall for roofs.
  c.fillStyle = '#e6e6e6';
  c.fillRect(0, W - 6, 6, 6);
  g.fillStyle = '#000';
  g.fillRect(0, W - 6, 6, 6);
  const wrap = (cv: HTMLCanvasElement, srgb: boolean) => {
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  return { map: wrap(color, true), emissive: wrap(glow, true) };
}

/**
 * Striped canvas for shop awnings: four colour schemes stacked in bands of v
 * (red, green, blue, gold, each striped with white), so one material serves
 * every awning and its UVs pick the scheme. u runs across the awning.
 */
export function awningTexture(): THREE.CanvasTexture {
  return canvasTexture(256, 256, (ctx) => {
    const schemes = ['#c2352b', '#2f8a4f', '#2a6fb8', '#d9a52b'];
    schemes.forEach((col, k) => {
      const y = k * 64;
      for (let x = 0; x < 256; x += 32) {
        ctx.fillStyle = col;
        ctx.fillRect(x, y, 16, 64);
        ctx.fillStyle = '#f2efe6';
        ctx.fillRect(x + 16, y, 16, 64);
      }
      // Darker toward the scalloped front edge (the lower part of each band).
      const g = ctx.createLinearGradient(0, y, 0, y + 64);
      g.addColorStop(0, 'rgba(255,255,255,0.12)');
      g.addColorStop(1, 'rgba(0,0,0,0.22)');
      ctx.fillStyle = g;
      ctx.fillRect(0, y, 256, 64);
    });
    noise(ctx, 256, 256, 2500, 0.05);
  });
}

/** Shop fronts for the ground floor: glass, frames and colored awnings. */
export function storefrontTexture(): THREE.CanvasTexture {
  return canvasTexture(512, 64, (ctx) => {
    ctx.fillStyle = '#2b2b2e';
    ctx.fillRect(0, 0, 512, 64);
    const awnings = ['#b8322a', '#2a6fb8', '#2f8a4f', '#d9a52b', '#7a3fa0', '#e0e0e0'];
    for (let i = 0; i < 4; i++) {
      const x = i * 128;
      ctx.fillStyle = '#16232c';
      ctx.fillRect(x + 8, 22, 112, 40);
      ctx.fillStyle = 'rgba(255,220,170,0.35)';
      ctx.fillRect(x + 8, 22, 112, 40);
      ctx.fillStyle = awnings[(i * 7 + 3) % awnings.length];
      ctx.fillRect(x + 4, 6, 120, 14);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      for (let k = x + 4; k < x + 124; k += 12) ctx.fillRect(k, 6, 6, 14);
      ctx.fillStyle = '#888';
      ctx.fillRect(x + 60, 22, 4, 40);
    }
  });
}

/** Procedural ripple normal map for water. */
export function waterNormalTexture(): THREE.CanvasTexture {
  const size = 256;
  const tex = canvasTexture(size, size, (ctx) => {
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const a = (x / size) * Math.PI * 2;
        const b = (y / size) * Math.PI * 2;
        const nx = Math.sin(a * 3 + Math.cos(b * 2) * 2) * 0.5 + Math.sin(a * 7 + b * 5) * 0.25;
        const ny = Math.cos(b * 4 + Math.sin(a * 3) * 2) * 0.5 + Math.cos(b * 9 - a * 4) * 0.25;
        const i = (y * size + x) * 4;
        img.data[i] = 128 + nx * 90;
        img.data[i + 1] = 128 + ny * 90;
        img.data[i + 2] = 255;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  });
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

/**
 * Precast concrete panels, as on an overpass's retaining walls: a stacked grid of
 * 1.5 m squares (4 x 4 per repeat, 6 m square) with dark recessed joints, each panel
 * its own shade, and grime run down from the joints by the rain.
 */
export function retainingWallTexture(): THREE.CanvasTexture {
  return canvasTexture(512, 512, (ctx) => {
    const P = 128;
    let s = 909;
    const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        const v = 168 + Math.floor(rand() * 26);
        ctx.fillStyle = `rgb(${v},${v - 4},${v - 11})`;
        ctx.fillRect(i * P, j * P, P, P);
        // A faint bevel: lit along the top edge, shaded along the bottom.
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.fillRect(i * P + 4, j * P + 4, P - 8, 5);
        ctx.fillStyle = 'rgba(0,0,0,0.12)';
        ctx.fillRect(i * P + 4, j * P + P - 9, P - 8, 5);
      }
    }
    noise(ctx, 512, 512, 9000, 0.07);
    // Streaks of grime down from the joints.
    for (let k = 0; k < 70; k++) {
      const x = Math.floor(rand() * 4) * P + 6 + rand() * (P - 12);
      const y = Math.floor(rand() * 4) * P + 4;
      const len = 20 + rand() * 90;
      const g = ctx.createLinearGradient(0, y, 0, y + len);
      g.addColorStop(0, `rgba(40,36,30,${0.1 + rand() * 0.18})`);
      g.addColorStop(1, 'rgba(40,36,30,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x, y, 2 + rand() * 5, len);
    }
    // The joints.
    ctx.fillStyle = 'rgba(28,26,22,0.85)';
    for (let i = 0; i <= 4; i++) {
      ctx.fillRect(i * P - 2, 0, 4, 512);
      ctx.fillRect(0, i * P - 2, 512, 4);
    }
  });
}

export function signTexture(text: string, bg: string, fg: string): THREE.CanvasTexture {
  return canvasTexture(512, 96, (ctx) => {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 512, 96);
    ctx.fillStyle = fg;
    // As big as fits.
    let size = 64;
    ctx.font = `bold ${size}px sans-serif`;
    while (size > 24 && ctx.measureText(text).width > 480) ctx.font = `bold ${(size -= 4)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 256, 52);
  });
}

/**
 * A painted lane arrow, white on transparent and a little worn: straight
 * ahead, or turning left or right (as the driver sees it, with the arrowhead
 * at the top of the image). 2.4 m x 4.8 m on the road.
 */
export function arrowTexture(kind: 'straight' | 'left' | 'right'): THREE.CanvasTexture {
  const tex = canvasTexture(192, 384, (ctx) => {
    ctx.clearRect(0, 0, 192, 384);
    ctx.fillStyle = ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 22;
    ctx.lineCap = 'butt';
    const head = (x: number, y: number, dx: number, dy: number) => {
      // Arrowhead with its tip at (x, y), pointing along (dx, dy).
      const px = -dy;
      const py = dx;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - dx * 70 + px * 42, y - dy * 70 + py * 42);
      ctx.lineTo(x - dx * 70 - px * 42, y - dy * 70 - py * 42);
      ctx.closePath();
      ctx.fill();
    };
    ctx.beginPath();
    if (kind === 'straight') {
      ctx.moveTo(96, 384);
      ctx.lineTo(96, 90);
      ctx.stroke();
      head(96, 16, 0, -1);
    } else {
      const s = kind === 'left' ? -1 : 1;
      ctx.moveTo(96, 384);
      ctx.lineTo(96, 220);
      ctx.quadraticCurveTo(96, 150, 96 + s * 40, 150);
      ctx.stroke();
      head(96 + s * 92, 150, s, 0);
    }
    // Worn paint.
    ctx.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 900; i++) ctx.fillRect(Math.random() * 192, Math.random() * 384, 2 + Math.random() * 3, 2 + Math.random() * 3);
    ctx.globalCompositeOperation = 'source-over';
  });
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/** A rooftop helipad: dark disc, yellow ring, white H. */
export function helipadTexture(): THREE.CanvasTexture {
  return canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = '#2b2f36';
    ctx.fillRect(0, 0, 256, 256);
    ctx.strokeStyle = '#f2c230';
    ctx.lineWidth = 14;
    ctx.beginPath();
    ctx.arc(128, 128, 104, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#f4f4f0';
    ctx.font = 'bold 150px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('H', 128, 136);
    noise(ctx, 256, 256, 3000, 0.08);
  });
}

export function waterTexture(): THREE.CanvasTexture {
  return canvasTexture(128, 128, (ctx) => {
    ctx.fillStyle = '#1f5f7a';
    ctx.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 400; i++) {
      ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.12})`;
      ctx.fillRect(Math.random() * 128, Math.random() * 128, 6 + Math.random() * 10, 1);
    }
  });
}

/**
 * Rio's black-and-white wave mosaic pavement (the Copacabana calçadão), for the
 * avenue sidewalks. One repeat covers 4 m x 4 m.
 */
export function mosaicTexture(): THREE.CanvasTexture {
  return canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = '#e9e5dc';
    ctx.fillRect(0, 0, 256, 256);
    ctx.fillStyle = '#26262a';
    // Two wave bands per repeat, seamless in both directions.
    for (const y0 of [32, 160]) {
      ctx.beginPath();
      for (let x = 0; x <= 256; x += 4) ctx.lineTo(x, y0 + Math.sin((x / 256) * Math.PI * 2) * 30);
      for (let x = 256; x >= 0; x -= 4) ctx.lineTo(x, y0 + 46 + Math.sin((x / 256) * Math.PI * 2) * 30);
      ctx.closePath();
      ctx.fill();
    }
    // Stone joints.
    ctx.strokeStyle = 'rgba(120,115,105,0.35)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 1400; i++) {
      const x = Math.random() * 256;
      const y = Math.random() * 256;
      ctx.strokeRect(x, y, 5 + Math.random() * 3, 5 + Math.random() * 3);
    }
  });
}

/** Tropical lawn: uneven green with dry patches. One repeat covers 8 m x 8 m. */
export function grassTexture(): THREE.CanvasTexture {
  return canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = '#4f7a3a';
    ctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = `rgba(${Math.random() < 0.6 ? '120,140,60' : '40,80,35'},0.25)`;
      ctx.beginPath();
      ctx.arc(Math.random() * 256, Math.random() * 256, 10 + Math.random() * 30, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let i = 0; i < 9000; i++) {
      ctx.fillStyle = `rgba(${Math.random() < 0.5 ? '30,60,25' : '140,170,90'},0.3)`;
      ctx.fillRect(Math.random() * 256, Math.random() * 256, 1, 3);
    }
  });
}

/**
 * Flat roofs, which the overhead view sees most of: sealed concrete in 2 m
 * panels with tar seams, patches and rain stains. Near-white, so each
 * building's tint sets its colour. One repeat covers 8 m.
 */
export function roofTexture(): THREE.CanvasTexture {
  return canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = '#ecebe7';
    ctx.fillRect(0, 0, 256, 256);
    for (let y = 0; y < 256; y += 64) {
      for (let x = 0; x < 256; x += 64) {
        const v = 226 + Math.floor(Math.random() * 24);
        ctx.fillStyle = `rgb(${v},${v - 1},${v - 5})`;
        ctx.fillRect(x + 1, y + 1, 62, 62);
      }
    }
    for (let i = 0; i < 16; i++) {
      const x = Math.random() * 256;
      const y = Math.random() * 256;
      const r = 12 + Math.random() * 40;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, Math.random() < 0.7 ? 'rgba(70,66,60,0.22)' : 'rgba(255,255,250,0.3)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      // Wrapped copies, so the stains tile.
      for (const dx of [-256, 0, 256]) for (const dy of [-256, 0, 256]) ctx.fillRect(x - r + dx, y - r + dy, r * 2, r * 2);
    }
    ctx.strokeStyle = 'rgba(40,38,36,0.4)';
    ctx.lineWidth = 2;
    for (let i = 0; i <= 256; i += 64) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, 256);
      ctx.moveTo(0, i);
      ctx.lineTo(256, i);
      ctx.stroke();
    }
    noise(ctx, 256, 256, 5000, 0.06);
  });
}

/**
 * Clay roof tiles: barrel tiles in staggered courses, each with its own shade,
 * a shadow under every course and some weathering. Near-white, so each roof's
 * tint sets the colour (terracotta, slate, painted metal). One repeat covers
 * 2 m; v runs up the slope.
 */
export function tileTexture(): THREE.CanvasTexture {
  return canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = '#efe7dd';
    ctx.fillRect(0, 0, 256, 256);
    const course = 32;
    const tile = 25.6;
    for (let row = 0; row < 8; row++) {
      const y = row * course;
      for (let col = -1; col < 11; col++) {
        const x = col * tile + (row % 2) * (tile / 2);
        const v = 0.86 + Math.random() * 0.22;
        ctx.fillStyle = `rgba(${Math.round(240 * v)},${Math.round(230 * v)},${Math.round(218 * v)},1)`;
        ctx.fillRect(x, y, tile, course);
        // Round barrel: dark at the sides, light down the middle.
        const g = ctx.createLinearGradient(x, 0, x + tile, 0);
        g.addColorStop(0, 'rgba(30,15,5,0.35)');
        g.addColorStop(0.4, 'rgba(255,250,240,0.18)');
        g.addColorStop(0.55, 'rgba(255,250,240,0.22)');
        g.addColorStop(1, 'rgba(30,15,5,0.4)');
        ctx.fillStyle = g;
        ctx.fillRect(x, y, tile, course);
      }
      // Each course overlaps the one below it: a shadow line along its lower edge.
      ctx.fillStyle = 'rgba(40,20,10,0.45)';
      ctx.fillRect(0, y + course - 4, 256, 4);
      ctx.fillStyle = 'rgba(255,245,230,0.25)';
      ctx.fillRect(0, y, 256, 2);
    }
    for (let i = 0; i < 10; i++) {
      const x = Math.random() * 256;
      const y = Math.random() * 256;
      const r = 10 + Math.random() * 30;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(60,55,40,0.22)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      for (const dx of [-256, 0, 256]) for (const dy of [-256, 0, 256]) ctx.fillRect(x - r + dx, y - r + dy, r * 2, r * 2);
    }
    noise(ctx, 256, 256, 4000, 0.06);
  });
}

/**
 * The ground between buildings: worn concrete, dirt and patchy grass, as in the
 * yards and lots of a hot, rainy city. One repeat covers about 32 m.
 */
export function groundTexture(): THREE.CanvasTexture {
  return canvasTexture(512, 512, (ctx) => {
    ctx.fillStyle = '#a39c8e';
    ctx.fillRect(0, 0, 512, 512);
    const blob = (color: string, n: number, r0: number, r1: number) => {
      for (let i = 0; i < n; i++) {
        const x = Math.random() * 512;
        const y = Math.random() * 512;
        const r = r0 + Math.random() * (r1 - r0);
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, color);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        // Draw wrapped copies so the texture tiles.
        for (const dx of [-512, 0, 512]) for (const dy of [-512, 0, 512]) ctx.fillRect(x - r + dx, y - r + dy, r * 2, r * 2);
      }
    };
    blob('rgba(108,128,72,0.55)', 26, 30, 90); // grass
    blob('rgba(140,118,88,0.35)', 18, 20, 70); // dirt
    blob('rgba(80,80,78,0.25)', 14, 15, 50); // stains
    noise(ctx, 512, 512, 26000, 0.07);
  });
}
