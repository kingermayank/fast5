import * as THREE from 'three';

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

/** Asphalt with edge lines and a dashed center line. U spans road width, V runs along it. */
export function roadTexture(): THREE.CanvasTexture {
  return canvasTexture(256, 512, (ctx) => {
    ctx.fillStyle = '#3a3c40';
    ctx.fillRect(0, 0, 256, 512);
    noise(ctx, 256, 512, 9000, 0.08);
    ctx.fillStyle = '#e8e8e8';
    ctx.fillRect(10, 0, 6, 512);
    ctx.fillRect(240, 0, 6, 512);
    ctx.fillRect(125, 0, 6, 256);
  });
}

export function curbTexture(): THREE.CanvasTexture {
  return canvasTexture(16, 64, (ctx) => {
    ctx.fillStyle = '#d42020';
    ctx.fillRect(0, 0, 16, 32);
    ctx.fillStyle = '#f2f2f2';
    ctx.fillRect(0, 32, 16, 32);
  });
}

export function grassTexture(): THREE.CanvasTexture {
  return canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = '#4c7a34';
    ctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 6000; i++) {
      const g = 90 + Math.random() * 60;
      ctx.fillStyle = `rgba(${g * 0.5},${g},${g * 0.35},0.35)`;
      ctx.fillRect(Math.random() * 256, Math.random() * 256, 2, 3);
    }
  });
}

export function barrierTexture(): THREE.CanvasTexture {
  return canvasTexture(64, 32, (ctx) => {
    ctx.fillStyle = '#e8e8e8';
    ctx.fillRect(0, 0, 64, 32);
    ctx.fillStyle = '#1d4fd6';
    ctx.fillRect(0, 0, 32, 32);
  });
}

export function checkerTexture(): THREE.CanvasTexture {
  return canvasTexture(64, 64, (ctx) => {
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        ctx.fillStyle = (x + y) % 2 ? '#111' : '#f4f4f4';
        ctx.fillRect(x * 8, y * 8, 8, 8);
      }
    }
  });
}
