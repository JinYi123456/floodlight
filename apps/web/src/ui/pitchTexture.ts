/**
 * Procedural pitch texture — mow stripes, markings and the goal mouths,
 * painted once onto an offscreen canvas (20 px per metre) and used as the
 * 3D pitch surface. No external assets: the whole broadcast look is drawn
 * from code.
 */

export const PITCH_TEXTURE_PPM = 20;

export function createPitchTexture(): HTMLCanvasElement {
  const ppm = PITCH_TEXTURE_PPM;
  const w = 105 * ppm;
  const h = 68 * ppm;
  const margin = 3 * ppm;
  const canvas = document.createElement('canvas');
  canvas.width = w + margin * 2;
  canvas.height = h + margin * 2;
  const ctx = canvas.getContext('2d')!;

  // Surround.
  ctx.fillStyle = '#081019';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Grass mow stripes (10 vertical bands).
  const stripe = w / 10;
  for (let i = 0; i < 10; i++) {
    ctx.fillStyle = i % 2 === 0 ? '#175936' : '#14502f';
    ctx.fillRect(margin + i * stripe, margin, stripe + 1, h);
  }
  // Soft vignette so the centre reads brighter, like under floodlights.
  const glow = ctx.createRadialGradient(margin + w / 2, margin + h / 2, h * 0.1, margin + w / 2, margin + h / 2, w * 0.62);
  glow.addColorStop(0, 'rgba(255, 250, 220, 0.10)');
  glow.addColorStop(1, 'rgba(0, 0, 0, 0.22)');
  ctx.fillStyle = glow;
  ctx.fillRect(margin, margin, w, h);

  const X = (x: number) => margin + (x + 52.5) * ppm;
  const Y = (y: number) => margin + (y + 34) * ppm;

  ctx.strokeStyle = 'rgba(245, 250, 245, 0.85)';
  ctx.lineWidth = 0.12 * ppm;
  ctx.lineCap = 'square';

  const line = (x1: number, y1: number, x2: number, y2: number) => {
    ctx.beginPath();
    ctx.moveTo(X(x1), Y(y1));
    ctx.lineTo(X(x2), Y(y2));
    ctx.stroke();
  };

  // Boundary, halfway, centre circle and spot.
  ctx.strokeRect(X(-52.5), Y(-34), 105 * ppm, 68 * ppm);
  line(0, -34, 0, 34);
  ctx.beginPath();
  ctx.arc(X(0), Y(0), 9.15 * ppm, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(X(0), Y(0), 0.3 * ppm, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(245, 250, 245, 0.9)';
  ctx.fill();

  const box = (sign: number) => {
    const goalLine = sign * 52.5;
    ctx.strokeRect(
      sign < 0 ? X(goalLine) : X(goalLine - 16.5),
      Y(-20.15),
      16.5 * ppm,
      40.3 * ppm,
    );
    ctx.strokeRect(
      sign < 0 ? X(goalLine) : X(goalLine - 5.5),
      Y(-9.16),
      5.5 * ppm,
      18.32 * ppm,
    );
    ctx.beginPath();
    ctx.arc(X(sign * 41.5), Y(0), 0.3 * ppm, 0, Math.PI * 2);
    ctx.fill();
    // Penalty arc: the part of a 9.15m circle centred on the spot that sits
    // outside the box.
    ctx.beginPath();
    const cx = X(sign * 41.5);
    const cy = Y(0);
    const r = 9.15 * ppm;
    const start = sign < 0 ? -Math.PI / 2.6 : Math.PI - Math.PI / 2.6;
    ctx.arc(cx, cy, r, start, start + (2 * Math.PI) / 2.6);
    ctx.stroke();
    // Goal mouth.
    ctx.save();
    ctx.strokeStyle = 'rgba(245, 250, 245, 0.95)';
    ctx.lineWidth = 0.2 * ppm;
    const gx = X(sign < 0 ? -52.5 : 52.5);
    ctx.strokeRect(sign < 0 ? gx - 2.4 * ppm : gx, Y(-3.66), 2.4 * ppm, 7.32 * ppm);
    ctx.restore();
  };
  box(-1);
  box(1);

  // Corner arcs.
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(X(sx * 52.5), Y(sy * 34), 1 * ppm, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  return canvas;
}
