import { stepSimulation, specificOrbitalEnergy } from "./physics.js";

const G = 6.67430e-20; // km³ kg⁻¹ s⁻²
export const MAX_OBJECTS = 12;

export function launchObject({ id, name, mass, radius, distance, speed, position, heading, time }) {
  const azimuth = position * Math.PI / 180;
  const direction = (position + heading) * Math.PI / 180;
  return {
    id, name, mass, radius, x: distance * Math.cos(azimuth), y: -distance * Math.sin(azimuth),
    vx: speed * Math.cos(direction), vy: -speed * Math.sin(direction), time, status: "Flying",
  };
}

function merge(first, second) {
  const mass = first.mass + second.mass;
  const average = key => (first[key] * first.mass + second[key] * second.mass) / mass;
  for (const key of ["x", "y", "vx", "vy"]) first[key] = average(key);
  first.radius = Math.cbrt(first.radius ** 3 + second.radius ** 3);
  first.mass = mass;
  second.status = "Merged into " + first.name;
}

export function stepObjects(objects, dt, { body, boundary }) {
  const active = objects.filter(object => object.status === "Flying");
  for (let i = 0; i < active.length; i++) {
    const first = active[i];
    if (first.status !== "Flying") continue;
    for (let j = i + 1; j < active.length; j++) {
      const second = active[j];
      if (second.status !== "Flying") continue;
      const x = second.x - first.x;
      const y = second.y - first.y;
      const distance = Math.hypot(x, y);
      if (distance <= first.radius + second.radius) {
        merge(first, second);
        continue;
      }
      const impulse = G * dt / distance ** 3;
      first.vx += x * impulse * second.mass;
      first.vy += y * impulse * second.mass;
      second.vx -= x * impulse * first.mass;
      second.vy -= y * impulse * first.mass;
    }
  }
  for (const object of active) {
    if (object.status !== "Flying") continue;
    const state = stepSimulation(object, dt, body.gm);
    Object.assign(object, state);
    object.time += dt;
    const distance = Math.hypot(object.x, object.y);
    if (distance <= body.radius + object.radius) {
      object.status = "Central body impact";
    } else if (distance >= boundary && specificOrbitalEnergy(object, body.gm) >= 0) {
      object.status = "Escaped";
    }
  }
}
