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

// Find first contact between two moving circles over this integration step.
export function contactTime(first, second, nextFirst, nextSecond) {
  const x = second.x - first.x;
  const y = second.y - first.y;
  const dx = nextSecond.x - nextFirst.x - x;
  const dy = nextSecond.y - nextFirst.y - y;
  const radius = first.radius + second.radius;
  const outside = x * x + y * y - radius * radius;
  if (outside <= 0) return 0;
  const motion = dx * dx + dy * dy;
  const approach = x * dx + y * dy;
  if (!motion || approach >= 0) return null;
  const discriminant = approach * approach - motion * outside;
  if (discriminant < 0) return null;
  const time = outside / (-approach + Math.sqrt(discriminant));
  return time <= 1 ? time : null;
}

function bounce(first, second) {
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  const distance = Math.hypot(dx, dy);
  const nx = distance ? dx / distance : 1;
  const ny = distance ? dy / distance : 0;
  const closingSpeed = (second.vx - first.vx) * nx + (second.vy - first.vy) * ny;
  const mass = first.mass + second.mass;
  const firstShare = second.mass / mass;
  const secondShare = first.mass / mass;
  const separation = Math.max(0, (first.radius + second.radius) * (1 + 1e-7) - distance);
  first.x -= nx * separation * firstShare;
  first.y -= ny * separation * firstShare;
  second.x += nx * separation * secondShare;
  second.y += ny * separation * secondShare;
  if (closingSpeed >= 0) return false;
  const impulse = 1.8 * closingSpeed; // restitution 0.8
  first.vx += nx * impulse * firstShare;
  first.vy += ny * impulse * firstShare;
  second.vx -= nx * impulse * secondShare;
  second.vy -= ny * impulse * secondShare;
  return true;
}

export function stepObjects(objects, dt, { body, boundary, collisionMode = "off", onCollision }) {
  const active = objects.filter(object => object.status === "Flying");
  for (let i = 0; i < active.length; i++) {
    const first = active[i];
    for (let j = i + 1; j < active.length; j++) {
      const second = active[j];
      const x = second.x - first.x;
      const y = second.y - first.y;
      const distance = Math.max(Math.hypot(x, y), first.radius + second.radius);
      const impulse = G * dt / distance ** 3;
      first.vx += x * impulse * second.mass;
      first.vy += y * impulse * second.mass;
      second.vx -= x * impulse * first.mass;
      second.vy -= y * impulse * first.mass;
    }
  }

  const updates = active.map(object => ({ object, start: { x: object.x, y: object.y }, next: stepSimulation(object, dt, body.gm) }));
  if (collisionMode !== "off" && updates.length > 1) {
    const contacts = [];
    for (let i = 0; i < updates.length; i++) {
      for (let j = i + 1; j < updates.length; j++) {
        const first = updates[i], second = updates[j];
        const time = contactTime(first.object, second.object, first.next, second.next);
        if (time !== null) contacts.push({ first, second, time });
      }
    }
    contacts.sort((a, b) => a.time - b.time);
    const handled = new Set();
    for (const { first, second, time } of contacts) {
      if (handled.has(first) || handled.has(second)) continue;
      const place = ({ object, next }) => {
        object.x += (next.x - object.x) * time;
        object.y += (next.y - object.y) * time;
        object.vx = next.vx;
        object.vy = next.vy;
      };
      place(first);
      place(second);
      if (collisionMode === "merge") merge(first.object, second.object);
      const hit = collisionMode === "merge" || bounce(first.object, second.object);
      for (const change of [first, second]) {
        handled.add(change);
        change.next = { vx: change.object.vx, vy: change.object.vy,
          x: change.object.x + change.object.vx * dt * (1 - time),
          y: change.object.y + change.object.vy * dt * (1 - time) };
      }
      if (hit) onCollision?.(first.object, second.object, collisionMode);
    }
  }

  for (const { object, start, next } of updates) {
    if (object.status !== "Flying") continue;
    const turn = Math.atan2(start.x * next.y - start.y * next.x, start.x * next.x + start.y * next.y);
    object.turn = (object.turn ?? 0) + turn;
    Object.assign(object, next);
    object.time += dt;
    const distance = Math.hypot(object.x, object.y);
    if (distance <= body.radius + object.radius) object.status = "Central body impact";
    else if (distance >= boundary && specificOrbitalEnergy(object, body.gm) >= 0) object.status = "Escaped";
  }
}
