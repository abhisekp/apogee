const G = 6.6743e-20;

export function createWells(body, objects, moon, camera) {
  const sources = [{ x: 0, y: 0, radius: body.radius, gm: body.gm }];
  if (moon) sources.push(moon);
  for (const object of objects) {
    if (object.status === "Flying") sources.push({ ...object, gm: object.mass * G });
  }
  const maxGM = Math.max(...sources.map(source => source.gm));
  return sources.map(source => ({
    x: camera.x + source.x * camera.scale,
    y: camera.y + source.y * camera.scale,
    spread: Math.max(20, Math.min(160, source.radius * camera.scale * 1.4)),
    strength: 0.28 + 0.72 * Math.max(0, 1 + Math.log10(source.gm / maxGM) / 26),
  }));
}

export function warpPoint(x, y, wells) {
  let dx = 0;
  let dy = 0;
  for (const well of wells) {
    const ox = well.x - x;
    const oy = well.y - y;
    const ratio = (ox * ox + oy * oy) / (well.spread * well.spread);
    const pull = well.strength * 0.72 / (1 + ratio);
    dx += ox * pull;
    dy += oy * pull;
  }
  const limit = Math.max(1, Math.hypot(dx, dy) / 34);
  return { x: x + dx / limit, y: y + dy / limit };
}

export function drawSpacetime(ctx, width, height, wells, camera) {
  const step = 39;
  const segment = 8;
  const startX = (camera.x % step + step) % step - step;
  const startY = (camera.y % step + step) % step - step;
  ctx.save();
  ctx.lineWidth = 1;
  for (const well of wells) {
    const glow = ctx.createRadialGradient(well.x, well.y, 0, well.x, well.y, well.spread * 1.8);
    glow.addColorStop(0, `rgba(159,105,244,${well.strength * 0.29})`);
    glow.addColorStop(1, "rgba(159,105,244,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(well.x - well.spread * 1.8, well.y - well.spread * 1.8, well.spread * 3.6, well.spread * 3.6);
  }
  for (const vertical of [true, false]) {
    ctx.strokeStyle = vertical ? "rgba(146,126,242,0.44)" : "rgba(88,218,235,0.42)";
    const endRow = vertical ? width : height;
    const endCol = vertical ? height : width;
    ctx.beginPath();
    for (let row = vertical ? startX : startY; row < endRow + step; row += step) {
      for (let col = -step; col < endCol + step; col += segment) {
        const p = warpPoint(vertical ? row : col, vertical ? col : row, wells);
        if (col === -step) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
    }
    ctx.stroke();
  }
  ctx.restore();
}
