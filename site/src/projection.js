import { classifyOutcome, orbitalElements, stepSimulation } from "./physics.js";

export const SIM_DT = 1 / 120;
const MAX_PREVIEW_SECONDS = 120;

export function projectTrajectory(initial, gm, planetRadius, escapeRadius) {
  const elements = orbitalElements(initial, gm);
  const clearsPlanet = elements?.periapsis > planetRadius;
  const maxSteps = Math.ceil(Math.min(elements?.period ?? Infinity, MAX_PREVIEW_SECONDS) / SIM_DT);
  const points = [initial];
  let state = initial;
  for (let i = 1; i <= maxSteps; i++) {
    state = stepSimulation(state, SIM_DT, gm);
    const outcome = classifyOutcome(state, planetRadius, escapeRadius, gm);
    if (outcome === "crash" || outcome === "escape") {
      points.push(state);
      return { points, outcome };
    }
    if (i % 8 === 0 || i === maxSteps) points.push(state);
  }

  return {
    points,
    outcome: clearsPlanet && elements.period <= MAX_PREVIEW_SECONDS ? "orbit" : "partial",
  };
}

export function aimedVelocity(speed, angle) {
  const radians = angle * Math.PI / 180;
  return { vx: speed * Math.cos(radians), vy: -speed * Math.sin(radians) };
}
