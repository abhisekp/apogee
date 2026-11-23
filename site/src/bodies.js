import { acceleration } from "./physics.js";

export const bodies = {
  sandbox: { label: "Sandbox", radius: 40, gm: 4000, altitude: 20, speed: 8.16 },
  earth: { label: "Earth", radius: 6371, gm: 398600.44, altitude: 200, speed: 7.79 },
  moon: { label: "Moon", radius: 1737.4, gm: 4902.8, altitude: 100, speed: 1.63 },
  mars: { label: "Mars", radius: 3389.5, gm: 42828.37, altitude: 200, speed: 3.45 },
  mercury: { label: "Mercury", radius: 2439.4, gm: 22031.87, altitude: 100, speed: 2.95 },
  venus: { label: "Venus", radius: 6051.8, gm: 324858.59, altitude: 200, speed: 7.21 },
  jupiter: { label: "Jupiter", radius: 69911, gm: 126686532, altitude: 1000, speed: 42.27 },
  saturn: { label: "Saturn", radius: 58232, gm: 37931207.8, altitude: 1000, speed: 25.31 },
  uranus: { label: "Uranus", radius: 25362, gm: 5793966, altitude: 1000, speed: 14.83 },
  neptune: { label: "Neptune", radius: 24622, gm: 6835107, altitude: 1000, speed: 16.33 },
  ceres: { label: "Ceres", radius: 469.7, gm: 62.63, altitude: 50, speed: 0.35 },
  sun: { label: "Sun", radius: 695700, gm: 132712440041, altitude: 100000, speed: 408.39 },
  station: { label: "Artificial station", radius: 0.05, gm: 2.67e-14, altitude: 0.025, speed: 0.0000005967 },
  artificial: { label: "Engineered planet (fictional)", radius: 150, gm: 12000, altitude: 30, speed: 8.16 },
  custom: { label: "Custom", radius: 40, gm: 4000, altitude: 20, speed: 8.16 },
};

export const MOON_DISTANCE = 384400;
export const transferDefaults = {
  earth: { ...bodies.earth },
  moon: { ...bodies.moon },
  distance: MOON_DISTANCE,
  phase: 117,
};
export const TRANSFER_DURATION = 8 * 86400;
export const TRANSFER_STEP = 10;

export function moonPosition(time, config = transferDefaults) {
  const rate = Math.sqrt((config.earth.gm + config.moon.gm) / config.distance ** 3);
  const angle = config.phase * Math.PI / 180 + rate * time;
  return { x: config.distance * Math.cos(angle), y: -config.distance * Math.sin(angle) };
}

function transferAcceleration(x, y, time, config) {
  const moon = moonPosition(time, config);
  const earthPull = acceleration(x, y, config.earth.gm);
  const moonPull = acceleration(x - moon.x, y - moon.y, config.moon.gm);
  const framePull = acceleration(-moon.x, -moon.y, config.moon.gm);
  return { ax: earthPull.ax + moonPull.ax - framePull.ax, ay: earthPull.ay + moonPull.ay - framePull.ay };
}

export function stepTransfer(state, dt, config = transferDefaults) {
  const first = transferAcceleration(state.x, state.y, state.time, config);
  const x = state.x + (state.vx + first.ax * dt / 2) * dt;
  const y = state.y + (state.vy + first.ay * dt / 2) * dt;
  const time = state.time + dt;
  const last = transferAcceleration(x, y, time, config);
  return { x, y, time, vx: state.vx + (first.ax + last.ax) * dt / 2, vy: state.vy + (first.ay + last.ay) * dt / 2 };
}

export function transferOutcome(state, config = transferDefaults) {
  if (Math.hypot(state.x, state.y) <= config.earth.radius) return "crash";
  const moon = moonPosition(state.time, config);
  if (Math.hypot(state.x - moon.x, state.y - moon.y) <= config.moon.radius) return "moon-impact";
  return state.time >= TRANSFER_DURATION ? "transfer-end" : null;
}

export function projectTransfer(initial, config = transferDefaults) {
  const points = [initial];
  let state = initial;
  let closestMoon = Infinity;
  for (let i = 1; ; i++) {
    state = stepTransfer(state, TRANSFER_STEP, config);
    const moon = moonPosition(state.time, config);
    closestMoon = Math.min(closestMoon, Math.hypot(state.x - moon.x, state.y - moon.y));
    const outcome = transferOutcome(state, config);
    if (i % 60 === 0 || outcome) points.push(state);
    if (outcome) return { points, outcome, closestMoon: Math.max(0, closestMoon - config.moon.radius) };
  }
}
