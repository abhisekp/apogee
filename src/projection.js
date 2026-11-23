import { classifyOutcome, orbitalElements, stepSimulation } from "./physics.js";

export const SIM_DT = 1 / 120;
const FULL_TURN = 2 * Math.PI;
const ELLIPSE_SEGMENTS = 720;
// At the supported gravity settings, even a parabolic escape reaches the
// simulation boundary within this guard.
const MAX_ESCAPE_SECONDS = 300;

function projectBoundPath(initial, elements, gm, planetRadius) {
  const { semiMajorAxis: a, eccentricity: e } = elements;
  const radius = Math.hypot(initial.x, initial.y);
  const h = initial.x * initial.vy - initial.y * initial.vx;
  const radialDot = initial.x * initial.vx + initial.y * initial.vy;
  const direction = h < 0 ? -1 : 1;
  const p = h * h / gm;
  const periapsis = p / (1 + e);
  const b = Math.sqrt(a * p);
  const ex = initial.vy * h / gm - initial.x / radius;
  const ey = -initial.vx * h / gm - initial.y / radius;
  const circular = e < 1e-8;
  const rotation = circular ? Math.atan2(initial.y, initial.x) : Math.atan2(ey, ex);
  const cosRotation = Math.cos(rotation);
  const sinRotation = Math.sin(rotation);
  const start = circular ? 0 : Math.atan2(radialDot / Math.sqrt(gm * a), 1 - radius / a);
  const crashes = periapsis <= planetRadius;

  // Eccentric anomaly samples the complete ellipse without stepping through
  // simulated time. A collision ends at the incoming surface intersection.
  const impact = crashes ? -2 * Math.asin(Math.sqrt((planetRadius - periapsis) / (2 * a * e))) : 0;
  const span = crashes ? (impact - start + FULL_TURN) % FULL_TURN : FULL_TURN;
  const points = [initial];
  const segments = Math.max(1, Math.ceil(ELLIPSE_SEGMENTS * span / FULL_TURN));
  for (let i = 1; i <= segments; i++) {
    const angle = start + span * i / segments;
    const sinHalf = Math.sin(angle / 2);
    const x = periapsis - 2 * a * sinHalf * sinHalf;
    const y = direction * b * Math.sin(angle);
    points.push({ x: x * cosRotation - y * sinRotation, y: x * sinRotation + y * cosRotation });
  }
  if (!crashes) points[points.length - 1] = initial;
  return { points, outcome: crashes ? "crash" : "orbit" };
}

export function projectTrajectory(initial, gm, planetRadius, escapeRadius) {
  if (Math.hypot(initial.x, initial.y) <= planetRadius) {
    return { points: [initial], outcome: "crash" };
  }
  const elements = orbitalElements(initial, gm);
  if (elements) return projectBoundPath(initial, elements, gm, planetRadius);

  const points = [initial];
  let state = initial;
  for (let i = 1; i <= MAX_ESCAPE_SECONDS / SIM_DT; i++) {
    state = stepSimulation(state, SIM_DT, gm);
    const outcome = classifyOutcome(state, planetRadius, escapeRadius, gm);
    if (outcome === "crash" || outcome === "escape") {
      points.push(state);
      return { points, outcome };
    }
    if (i % 8 === 0) points.push(state);
  }
  return { points, outcome: "partial" };
}

export function aimedVelocity(speed, angle) {
  const radians = angle * Math.PI / 180;
  return { vx: speed * Math.cos(radians), vy: -speed * Math.sin(radians) };
}
