const G = 6.67430e-20; // km³ kg⁻¹ s⁻²
const GRID_STEPS = 24;

export function createWells(body, objects, moon) {
  const wells = [{ x: 0, y: 0, radius: body.radius, gm: body.gm, name: body.label, color: "#4dd8e8" }];
  if (moon) wells.push({ ...moon, name: "Moon", color: "#d6d8df" });
  for (const object of objects) {
    if (object.status !== "Flying") continue;
    wells.push({ x: object.x, y: object.y, radius: object.radius, gm: G * object.mass, name: object.name, color: object.color });
  }
  const extent = Math.max(body.radius * 3, ...wells.map(well => Math.max(Math.abs(well.x), Math.abs(well.y)) * 1.25));
  const maxGM = Math.max(...wells.map(well => well.gm));
  return wells.map(well => {
    const relative = well.gm / maxGM;
    return {
      ...well,
      x: well.x / extent,
      y: well.y / extent,
      spread: Math.max(0.1, Math.min(0.6, well.radius / extent)),
      // Log contrast makes small masses visible without changing the simulation.
      strength: 0.2 + 0.8 * Math.max(0, 1 + Math.log10(relative) / 26),
    };
  });
}

export function wellDepth(x, y, wells) {
  let potential = 0;
  for (const well of wells) {
    const distance = Math.hypot(x - well.x, y - well.y, well.spread);
    potential += well.strength * (well.spread / distance) ** 2;
  }
  return 1 - Math.exp(-1.15 * potential);
}

export function drawSpacetime(canvas, wells) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(rect.width * dpr);
  const height = Math.round(rect.height * dpr);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);

  const project = (x, y) => ({
    x: rect.width / 2 + (x - y) * rect.width * 0.226,
    y: rect.height * 0.36 + (x + y) * rect.height * 0.156 + wellDepth(x, y, wells) * rect.height * 0.50,
  });
  const mesh = Array.from({ length: GRID_STEPS + 1 }, (_, i) =>
    Array.from({ length: GRID_STEPS + 1 }, (_, j) => project(i * 2 / GRID_STEPS - 1, j * 2 / GRID_STEPS - 1))
  );
  for (const transpose of [false, true]) {
    ctx.strokeStyle = transpose ? "rgba(166,158,255,0.5)" : "rgba(77,216,232,0.55)";
    for (let i = 0; i <= GRID_STEPS; i++) {
      ctx.lineWidth = i % 6 === 0 ? 1.35 : 0.8;
      ctx.beginPath();
      for (let j = 0; j <= GRID_STEPS; j++) {
        const point = transpose ? mesh[j][i] : mesh[i][j];
        if (j === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      }
      ctx.stroke();
    }
  }

  ctx.font = "12px system-ui";
  wells.forEach((well, index) => {
    const point = project(well.x, well.y);
    ctx.fillStyle = well.color;
    ctx.beginPath();
    ctx.arc(point.x, point.y, index === 0 ? 6 : 3.5, 0, 2 * Math.PI);
    ctx.fill();
    if (index < 5 && well.name) {
      const alignRight = point.x > rect.width * 0.72;
      ctx.textAlign = alignRight ? "right" : "left";
      ctx.fillText(well.name, point.x + (alignRight ? -8 : 8), point.y - 7);
    }
  });
}
