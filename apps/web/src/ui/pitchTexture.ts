/**
 * Procedural pitch texture — mown grass with grain, full markings, goal
 * mouths and technical areas. Painted once onto an offscreen canvas at
 * 20 px per metre; no external assets.
 */

export const PITCH_TEXTURE_PPM = 20;

function noise(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function createPitchTexture(): HTMLCanvasElement {
  const ppm = PITCH_TEXTURE_PPM;
  const w = 105 * ppm;
  const h = 68 * ppm;
  const margin = 3 * ppm;
  const canvas = document.createElement('canvas');
  canvas.width = w + margin * 2;
  canvas.height = h + margin * 2;
  const ctx = canvas.getContext('2d')!;
  const rand = noise(0xf10d11);

  ctx.fillStyle = '#07140d';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Two crossing mow patterns: broad vertical bands plus a faint horizontal
  // break every 20 m, the way a real groundstaff cut reads under lights.
  const stripe = w / 12;
  for (let i = 0; i < 12; i++) {
    ctx.fillStyle = i % 2 === 0 ? '#1a623c' : '#165634';
    ctx.fillRect(margin + i * stripe, margin, stripe + 1, h);
  }
  for (let i = 0; i < 5; i++) {
    ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.018)' : 'rgba(0,0,0,0.025)';
    ctx.fillRect(margin, margin + (i * h) / 5, w, h / 5);
  }

  // Grass grain.
  for (let i = 0; i < 32000; i++) {
    const x = margin + rand() * w;
    const y = margin + rand() * h;
    const tone = rand();
    ctx.fillStyle = tone < 0.5 ? `rgba(10, 38, 22, ${0.05 + rand() * 0.12})` : `rgba(150, 210, 150, ${0.025 + rand() * 0.055})`;
    ctx.fillRect(x, y, 1 + rand() * 1.5, 1);
  }

  const glow = ctx.createRadialGradient(margin + w / 2, margin + h / 2, h * 0.08, margin + w / 2, margin + h / 2, w * 0.62);
  glow.addColorStop(0, 'rgba(255, 250, 220, 0.12)');
  glow.addColorStop(1, 'rgba(0, 0, 0, 0.28)');
  ctx.fillStyle = glow;
  ctx.fillRect(margin, margin, w, h);

  const X = (x: number) => margin + (x + 52.5) * ppm;
  const Y = (y: number) => margin + (y + 34) * ppm;

  ctx.lineCap = 'square';
  const line = (x1: number, y1: number, x2: number, y2: number) => {
    ctx.beginPath();
    ctx.moveTo(X(x1), Y(y1));
    ctx.lineTo(X(x2), Y(y2));
    ctx.stroke();
  };

  const strokeMarkings = (color: string, width: number, offset = 0) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width * ppm;
    ctx.strokeRect(X(-52.5) + offset, Y(-34) + offset, 105 * ppm, 68 * ppm);
    line(0, -34, 0, 34);
    ctx.beginPath();
    ctx.arc(X(0), Y(0), 9.15 * ppm, 0, Math.PI * 2);
    ctx.stroke();
    for (const sign of [-1, 1]) {
      const goalLine = sign * 52.5;
      ctx.strokeRect(sign < 0 ? X(goalLine) + offset : X(goalLine - 16.5) + offset, Y(-20.15) + offset, 16.5 * ppm, 40.3 * ppm);
      ctx.strokeRect(sign < 0 ? X(goalLine) + offset : X(goalLine - 5.5) + offset, Y(-9.16) + offset, 5.5 * ppm, 18.32 * ppm);
      ctx.beginPath();
      const cx = X(sign * 41.5);
      const cy = Y(0);
      const start = sign < 0 ? -Math.PI / 2.6 : Math.PI - Math.PI / 2.6;
      ctx.arc(cx, cy, 9.15 * ppm, start, start + (2 * Math.PI) / 2.6);
      ctx.stroke();
    }
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(X(sx * 52.5), Y(sy * 34), 1 * ppm, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  };

  strokeMarkings('rgba(0,0,0,0.35)', 0.16, 2);
  strokeMarkings('rgba(247,250,245,0.92)', 0.12);

  // Spots.
  ctx.fillStyle = 'rgba(247,250,245,0.94)';
  for (const [x, y] of [[0, 0], [-41.5, 0], [41.5, 0]] as const) {
    ctx.beginPath();
    ctx.arc(X(x), Y(y), 0.3 * ppm, 0, Math.PI * 2);
    ctx.fill();
  }

  // Goal mouths.
  ctx.strokeStyle = 'rgba(247,250,245,0.98)';
  ctx.lineWidth = 0.2 * ppm;
  for (const sign of [-1, 1]) {
    const gx = X(sign < 0 ? -52.5 : 52.5);
    ctx.strokeRect(sign < 0 ? gx - 2.4 * ppm : gx, Y(-3.66), 2.4 * ppm, 7.32 * ppm);
  }

  // Technical areas sit in the runoff, not on the playing surface.
  ctx.strokeStyle = 'rgba(235,244,255,0.28)';
  ctx.lineWidth = 0.1 * ppm;
  ctx.setLineDash([1.2 * ppm, 1.2 * ppm]);
  for (const sign of [-1, 1]) {
    ctx.strokeRect(X(-20), Y(sign * 34.8), 40 * ppm, 1.7 * ppm);
  }
  ctx.setLineDash([]);

  // Goal-line wear.
  for (const sign of [-1, 1]) {
    const g = ctx.createRadialGradient(X(sign * 51.5), Y(0), 0.5 * ppm, X(sign * 51.5), Y(0), 8 * ppm);
    g.addColorStop(0, 'rgba(116, 96, 66, 0.16)');
    g.addColorStop(1, 'rgba(116, 96, 66, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(X(sign * 51.5) - 8 * ppm, Y(-8), 16 * ppm, 16 * ppm);
  }

  return canvas;
}
