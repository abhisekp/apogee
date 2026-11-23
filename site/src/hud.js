import { orbitalElements } from "./physics.js";

const PLACEHOLDER = "—";

function formatUnit(value, unit, digits = 1) {
  if (!Number.isFinite(value)) return PLACEHOLDER;
  const number = unit === "km/s" && value > 0 && value < 0.01 ? value.toPrecision(4) : value.toFixed(digits);
  return `${number} ${unit}`;
}

// Builds the full set of formatted HUD strings from a live simulation
// state. Every field is guarded against NaN/undefined/Infinity (e.g. at
// t=0 before launch, or the instant after a crash zeroes velocity) so the
// HUD never renders a raw "NaN"/"undefined" to the player.
export function buildHudReadout(state, gm, planetRadius) {
  if (!state) {
    return { velocity: PLACEHOLDER, altitude: PLACEHOLDER, apoapsis: PLACEHOLDER, periapsis: PLACEHOLDER, period: PLACEHOLDER };
  }

  const speed = Math.hypot(state.vx, state.vy);
  const r = Math.hypot(state.x, state.y);
  const altitude = r - planetRadius;

  const elements = orbitalElements(state, gm);

  return {
    velocity: formatUnit(speed, "km/s", 2),
    altitude: formatUnit(altitude, "km", 1),
    apoapsis: elements ? formatUnit(elements.apoapsis, "km", 1) : PLACEHOLDER,
    periapsis: elements ? formatUnit(elements.periapsis, "km", 1) : PLACEHOLDER,
    period: elements ? formatUnit(elements.period, "s", 2) : PLACEHOLDER,
  };
}
