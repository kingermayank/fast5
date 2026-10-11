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

export function asphaltTexture(): THREE.CanvasTexture {
  return canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = '#3b3d41';
    ctx.fillRect(0, 0, 256, 256);
    noise(ctx, 256, 256, 7000, 0.07);
  });
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

/**
 * One window bay of a facade: white wall (tinted by material color) with a
 * dark window. One texture repeat = 6 m wide x 4 m tall. Texel (0,0) is wall,
 * so roofs (uv 0) sample plain wall.
 */
export function facadeTexture(): THREE.CanvasTexture {
  return canvasTexture(64, 64, (ctx) => {
    ctx.fillStyle = '#f2f2f2';
    ctx.fillRect(0, 0, 64, 64);
    noise(ctx, 64, 64, 300, 0.05);
    ctx.fillStyle = '#26323d';
    ctx.fillRect(14, 14, 36, 30);
    ctx.fillStyle = 'rgba(160,200,230,0.35)';
    ctx.fillRect(14, 14, 18, 30);
    ctx.fillStyle = '#d8d8d8';
    ctx.fillRect(10, 44, 44, 4);
  });
}

export function signTexture(text: string, bg: string, fg: string): THREE.CanvasTexture {
  return canvasTexture(512, 96, (ctx) => {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 512, 96);
    ctx.fillStyle = fg;
    ctx.font = 'bold 64px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 256, 52);
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
