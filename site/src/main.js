import { stepSimulation, classifyOutcome, orbitalElements, circularOrbitVelocity, escapeVelocity } from "./physics.js";
import { bodies, transferDefaults, TRANSFER_STEP, moonPosition, stepTransfer, transferOutcome, projectTransfer } from "./bodies.js";
import { launchObject, MAX_OBJECTS, stepObjects } from "./objects.js";
import { createWells, drawSpacetime } from "./spacetime.js";
import { catalog, searchEntries, catalogIcon, catalogDefaults } from "./catalog.js";
import { aimedVelocity, projectTrajectory, SIM_DT } from "./projection.js";
import { dragDistance, clampToMaxDistance, launchVelocity } from "./input.js";
import { buildHudReadout } from "./hud.js";
import { createDebrisBurst, updateParticles, particleOpacity } from "./particles.js";
import { createAudioEngine } from "./audio.js";
import { getOrbitCount, incrementOrbitCount } from "./stats.js";

const MAX_DRAG_DISTANCE = 220;
const DRAG_SENSITIVITY = 0.09;
const MAX_FRAME_DT = 0.05;
const MAX_TRACE_POINTS = 4000;
const DRAG_SOUND_THROTTLE_MS = 90;

const canvas = document.getElementById("scene");
const ctx = canvas.getContext("2d");
const canvasWrap = document.getElementById("canvas-wrap");
const overlay = document.getElementById("outcome-overlay");
const outcomeTitle = document.getElementById("outcome-title");
const outcomeStats = document.getElementById("outcome-stats");
const launchAnotherBtn = document.getElementById("launch-another");
const hudStatus = document.getElementById("hud-status");
const hudOrbitCount = document.getElementById("hud-orbit-count");
const gravitySlider = document.getElementById("gravity-slider");
const gravityValue = document.getElementById("gravity-value");
const muteButton = document.getElementById("mute-toggle");
const spacetimeView = document.getElementById("spacetime-view");
const spacetimeToggle = document.getElementById("spacetime-toggle");
const resetButton = document.getElementById("reset-button");

const playback = document.getElementById("playback-speed");
const zoomSlider = document.getElementById("zoom");
const zoomValue = document.getElementById("zoom-value");
const fitButton = document.getElementById("fit-path");
const presetSelect = document.getElementById("launch-preset");
const presetDescription = document.getElementById("preset-description");
const defaultPresetDescription = presetDescription.textContent;
const presets = {
  sputnik: { profile: "earth", altitude: 215, speed: 8, angle: 90, description: "Inspired by Sputnik 1’s elliptical Earth orbit in 1957." },
  luna: { profile: "moon", altitude: 100, speed: 2.5, angle: 145, description: "Inspired by Luna 2’s 1959 lunar impact. The central body represents the Moon." },
  apollo: { profile: "earth", altitude: 185, speed: 11.05, angle: 90, description: "Inspired by Apollo 8 leaving Earth orbit in 1968. The preview ends at the departure boundary." },
  circle: { gm: 4000, speed: 8.16, angle: 90, description: "A tangential launch tuned to stay nearly the same distance from the center." },
  ellipse: { gm: 4000, speed: 10.65, angle: 90, description: "A fast tangential launch creates a wide ellipse with a distant apoapsis." },
  reverse: { gm: 4000, speed: 8.16, angle: -90, description: "The nearly circular setup with its launch direction reversed." },
  drop: { gm: 4000, speed: 0, angle: 0, description: "Release from rest and watch gravity pull the satellite into the surface." },
  skim: { gm: 4000, speed: 7.34, angle: 90, description: "Compare this close pass with Surface impact. The launch speed differs by 0.08 km/s." },
  impact: { gm: 4000, speed: 7.26, angle: 90, description: "A slight speed reduction brings the trajectory into the surface." },
  bound: { gm: 4000, speed: 11.5, angle: 90, description: "A near-escape launch that stays bound. Compare it with Just above escape." },
  escape: { gm: 4000, speed: 11.55, angle: 90, description: "At this gravity and launch altitude, escape speed is about 11.547 km/s." },
  weak: { gm: 1600, speed: 8.16, angle: 90, description: "Uses the same launch as Nearly circular with a weaker gravity parameter." },
};

const aimForm = document.getElementById("aim-controls");
const aimSpeed = document.getElementById("aim-speed");
const aimAngle = document.getElementById("aim-angle");
const launchButton = document.getElementById("launch-button");
const predictionStatus = document.getElementById("prediction-status");

const hudFields = {
  velocity: document.getElementById("hud-velocity"),
  altitude: document.getElementById("hud-altitude"),
  apoapsis: document.getElementById("hud-apoapsis"),
  periapsis: document.getElementById("hud-periapsis"),
  period: document.getElementById("hud-period"),
};

const audio = createAudioEngine();

const reducedMotion =
  typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const controls = Object.fromEntries([
  "body-profile", "body-radius", "body-gm", "launch-altitude", "body-note",
  "speed-guide", "path-guide", "pause-flight", "step-flight", "replay-flight",
  "pin-path", "clear-path", "comparison-info",
  "transfer-fields", "moon-radius", "moon-gm", "moon-distance", "moon-phase",
].map(id => [id, document.getElementById(id)]));
const profiles = Object.fromEntries(Object.entries(bodies).map(([id, config]) => [id, { ...config }]));
const transfer = { ...transferDefaults, earth: { ...transferDefaults.earth }, moon: { ...transferDefaults.moon } };
let profileId = "sandbox";
let body = profiles.sandbox;
let gm = body.gm;
const extraObjects = [];
const objectForm = document.getElementById("object-form");
const objectList = document.getElementById("object-list");
const objectStatus = document.getElementById("object-status");
const placementStatus = document.getElementById("placement-status");
let stagedLaunch = null;
let aimPointer = null;
let nextPathRefresh = 0;
let pathCursor = 0;
const resetConfirmation = document.getElementById("reset-confirmation");
const objectColors = ["#f8c576", "#ffa1c9", "#a8ed9d", "#c9afff", "#ff9e7b", "#7ce4ff"];
let nextObjectId = 1;
let objectTime = 0;
let objectAccumulator = 0;
const flyingObjects = () => extraObjects.some(object => object.status === "Flying");
const objectField = name => document.getElementById("object-" + name);

function syncObjectDefaults() {
  objectField("radius").value = +Math.min(body.radius / 100, 0.1).toPrecision(5);
  objectField("height").value = body.altitude;
  objectField("speed").value = Number(aimSpeed.value) || circularOrbitVelocity(launchRadius(), gm);
}

function refreshObjectList() {
  objectList.replaceChildren();
  for (const object of extraObjects) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.style.color = object.color;
    label.textContent = `${object.name} · ${object.mass.toLocaleString(undefined, { notation: "compact" })} kg · radius ${Number(object.radius.toPrecision(4))} km · ${object.status}`;
    const remove = document.createElement("wa-button");
    remove.setAttribute("size", "small");
    remove.setAttribute("type", "button");
    remove.textContent = `Remove ${object.name}`;
    remove.addEventListener("click", () => {
      extraObjects.splice(extraObjects.indexOf(object), 1);
      refreshObjectList();
      setPhase(phase);
    });
    item.append(label, remove);
    objectList.append(item);
  }
}

function clearObjects() {
  extraObjects.length = 0;
  cancelStagedLaunch();
  collisionFlash = null;
  collisionFeedback.textContent = "";
  nextObjectId = 1;
  objectTime = 0;
  objectAccumulator = 0;
  objectStatus.textContent = "";
  placementStatus.textContent = "";
  refreshObjectList();
}

const quickToys = {
  satellite: { name: "Satellite", icon: "🛰️", mass: 1000, radius: 0.003, speed: 1, heading: 90 },
  rocket: { name: "Rocket", icon: "🚀", mass: 20000, radius: 0.015, speed: 1.6, heading: 55 },
  rock: { name: "Space rock", icon: "🪨", mass: 10000, radius: 0.008, speed: 0.25, heading: 160 },
  ball: { name: "Ball", icon: "⚽", mass: 0.43, radius: 0.00011, speed: 1.12, heading: -90 },
};
const flightGoals = {
  orbit: { icon: "🌀", label: "Orbit", points: 100 },
  crash: { icon: "💥", label: "Impact", points: 25 },
  escape: { icon: "⭐", label: "Escape", points: 50 },
  collision: { icon: "💫", label: "Collision", points: 75 },
};
const collisionControl = document.getElementById("collision-mode");
const collisionRewards = document.getElementById("collision-rewards");
const collisionDemo = document.getElementById("collision-demo");
const collisionFeedback = document.getElementById("collision-feedback");
let collisionFlash = null;
const unlockedGoals = new Set();
let flightScore = 0;

function scoreFlight(kind) {
  const goal = flightGoals[kind];
  if (!goal) return;
  flightScore += goal.points;
  unlockedGoals.add(kind);
  const badge = document.getElementById("goal-" + kind);
  badge.textContent = `${goal.icon} ✓`;
  badge.setAttribute("aria-label", `${goal.label} goal complete`);
  badge.dataset.done = "";
  document.getElementById("flight-score").textContent = `🏆 ${flightScore} points`;
  document.getElementById("flight-feedback").textContent =
    `${goal.icon} ${goal.label}! +${goal.points}${["orbit", "crash", "escape"].every(goal => unlockedGoals.has(goal)) ? " · All three flight goals complete!" : ""}`;
}

function addObject(event, drop, toy = null) {
  event?.preventDefault();
  if (isTransfer()) {
    objectStatus.textContent = "Select a single central body to add objects.";
    return;
  }
  if (extraObjects.length >= MAX_OBJECTS) {
    objectStatus.textContent = "Remove an object before adding another.";
    return;
  }
  const fields = ["mass", "radius", "height", "speed", "position", "heading"];
  let [mass, radius, altitude, speed, position, heading] = fields.map(key => {
    const value = objectField(key).value;
    return value === "" || value == null ? NaN : Number(value);
  });
  if (toy) {
    mass = toy.mass;
    radius = toy.radius;
    altitude = Math.max(body.altitude, radius * 1.2);
    position = toy.position ?? (nextObjectId * 53) % 360;
    heading = toy.heading;
    speed = circularOrbitVelocity(body.radius + altitude, gm) * toy.speed;
  }
  if (drop) ({ position, altitude, speed, heading } = drop);
  if (![mass, radius, altitude, speed, position, heading].every(Number.isFinite) ||
      mass < 1e-18 || mass > 1e33 || radius < 1e-9 || radius > 1e7 ||
      altitude <= radius || altitude > 1e8 || speed < 0 || speed > 100000 || Math.abs(position) > 360 || Math.abs(heading) > 180) {
    objectStatus.textContent = "Use a positive mass, a radius up to 10 million km, and a launch altitude greater than the object’s radius. Check that speed and angles are in range.";
    return;
  }

  const id = nextObjectId++;
  const name = toy ? `${toy.name} ${id}` : objectField("name").value?.trim().slice(0, 28) || `Object ${id}`;
  const object = launchObject({ id, name, mass, radius, distance: body.radius + altitude, speed, position, heading, time: objectTime });
  object.icon = toy?.icon ?? (editingCatalogTile?.name === name ? editingCatalogTile.icon : null);
  object.prediction = predictExtra(object);
  object.color = objectColors[(id - 1) % objectColors.length];
  object.trail = [{ x: object.x, y: object.y }];
  extraObjects.push(object);
  if (!toy) {
    editingCatalogTile = null;
    objectField("name").value = "";
    objectField("position").value = (position + 45 + 360) % 360;
  } else {
    document.getElementById("flight-feedback").textContent = `${toy.icon} ${toy.name} launched!`;
  }
  objectStatus.textContent = `${name} added.`;
  if (drop && !toy) placementStatus.textContent = `${name} placed in orbit.`;
  refreshObjectList();
  setPhase(phase);
  setFitPath(true);
}

function announceCollision(first, second, mode) {
  collisionFlash = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2, until: performance.now() + 850 };
  collisionFeedback.textContent = mode === "merge"
    ? `💫 ${first.name} and ${second.name} merged.`
    : `💫 ${first.name} and ${second.name} bounced.`;
  if (collisionRewards.checked) scoreFlight("collision");
}

function syncCollisionControls() {
  const available = !isTransfer();
  const enabled = available && Boolean(collisionControl.value) && collisionControl.value !== "off";
  collisionControl.disabled = !available;
  collisionRewards.disabled = !enabled;
  collisionDemo.disabled = !enabled;
  document.getElementById("goal-collision").hidden = !enabled || !collisionRewards.checked;
}

function advanceObjects(dt) {
  if (!flyingObjects()) return;
  const step = physicsStep();
  objectAccumulator = Math.min(objectAccumulator + dt, step * 300);
  const statuses = extraObjects.map(object => object.status);
  let advanced = false;
  while (objectAccumulator >= step && flyingObjects()) {
    stepObjects(extraObjects, step, {
      body, boundary: profileId === "sandbox" ? Math.max(500, escapeRadius()) : escapeRadius(),
      collisionMode: collisionControl.value, onCollision: announceCollision,
    });
    objectTime += step;
    objectAccumulator -= step;
    advanced = true;
  }
  if (advanced) {
    extraObjects.forEach((object, i) => {
      if (statuses[i] !== "Flying") return;
      if (object.status === "Central body impact") scoreFlight("crash");
      if (object.status === "Escaped") scoreFlight("escape");
      if (object.status === "Flying" && !object.orbitScored && Math.abs(object.turn ?? 0) >= 2 * Math.PI) {
        object.orbitScored = true;
        scoreFlight("orbit");
      }
      object.trail.push({ x: object.x, y: object.y });
      if (object.trail.length > 420) object.trail.shift();
    });
  }
  if (extraObjects.some((object, i) => object.status !== statuses[i])) {
    refreshObjectList();
    setPhase(phase);
  }
}
let paused = false;
let lastVelocity = null;
let comparison = null;

const isTransfer = () => profileId === "transfer";
const launchRadius = () => body.radius + body.altitude;
const escapeRadius = () => Math.max(body.radius * 8, launchRadius() * 4, 0.001);
const baselineScale = () => 40 / body.radius;
function physicsStep() {
  if (isTransfer()) return TRANSFER_STEP;
  const adaptive = Math.sqrt(body.radius ** 3 / gm) / 300;
  return profileId === "sandbox" ? Math.min(SIM_DT, adaptive) : adaptive;
}
const speedText = value => value > 0 && value < 0.01 ? value.toPrecision(4) : value.toFixed(2);

function compatibleComparison() {
  return comparison && comparison.profile === profileId && comparison.radius === body.radius;
}

function pathSummary(path, parameter, altitude) {
  const { vx, vy } = path.initial;
  return `${speedText(Math.hypot(vx, vy))} km/s at ${path.angle.toFixed(1)}° · ${path.outcome} · GM ${parameter} · Launch altitude ${altitude} km`;
}

function refreshGuides() {
  const speed = circularOrbitVelocity(launchRadius(), gm);
  controls["speed-guide"].textContent = `${isTransfer() ? "Earth-only reference · " : ""}Circular speed ${speedText(speed)} km/s at 90° · Escape speed ${speedText(escapeVelocity(launchRadius(), gm))} km/s`;
  const altitude = point => Math.max(0, Math.hypot(point.x, point.y) - body.radius).toLocaleString(undefined, { maximumFractionDigits: 3 });
  controls["path-guide"].textContent = projection
    ? `Path A · Closest ${altitude(projection.near)} km · Farthest shown ${altitude(projection.far)} km above the surface` +
      (isTransfer() ? ` · Closest lunar altitude ${Math.round(projection.closestMoon).toLocaleString()} km` : "")
    : "";
  controls["pin-path"].disabled = !projection;
  controls["clear-path"].disabled = !comparison;
  controls["comparison-info"].textContent = comparison
    ? (projection ? "A (cyan) · " + pathSummary(projection, gm, body.altitude) + " | " : "") +
      "B (gold) · " + comparison.summary + (compatibleComparison() ? "" : " · Select the same body and radius to overlay path B.")
    : "";
}
let phase = "idle"; // idle | dragging | flying | resolved
let satellite = null; // { x, y, vx, vy }
let trace = [];
let particles = [];
let outcome = null; // crash | orbit | escape
let launchSpeed = 0;
let orbitHoldTime = 0;
let dragPointer = null;
let dragOrigin = null;
let projection = null;
let zoom = 1;
let fitPath = false;
let cameraX = 0;
let cameraY = 0;
let pointerGesture = null;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 2.5;
let minimumZoom = MIN_ZOOM;
let physicsTime = 0;
let traceStep = 0;
let lastFrameTime = null;
let lastDragSoundTime = 0;
let shakeTimeoutId = null;

function anchorPoint() {
  return { x: launchRadius(), y: 0 };
}

function restingSatellite() {
  return { ...anchorPoint(), vx: 0, vy: 0, time: 0 };
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function center() {
  const rect = canvas.getBoundingClientRect();
  return { cx: rect.width / 2, cy: rect.height / 2, width: rect.width, height: rect.height };
}

function currentAim() {
  if (!aimSpeed.validity?.valid || !aimAngle.validity?.valid) return null;
  return aimedVelocity(Number(aimSpeed.value), Number(aimAngle.value));
}

function updatePrediction(velocity = currentAim()) {
  const initial = velocity ? { ...anchorPoint(), ...velocity, time: 0 } : null;
  projection = initial && (isTransfer()
    ? projectTransfer(initial, transfer)
    : projectTrajectory(initial, gm, body.radius, profileId === "sandbox" ? Math.max(500, escapeRadius()) : escapeRadius(), physicsStep()));
  if (projection) {
    projection.initial = initial;
    projection.angle = Math.atan2(-initial.vy, initial.vx) * 180 / Math.PI;
    projection.near = projection.far = initial;
    for (const point of projection.points) {
      const radius = Math.hypot(point.x, point.y);
      if (radius < Math.hypot(projection.near.x, projection.near.y)) projection.near = point;
      if (radius > Math.hypot(projection.far.x, projection.far.y)) projection.far = point;
    }
  }
  const labels = {
    crash: "Predicted impact",
    orbit: "Predicted orbit",
    escape: "Predicted escape",
    partial: "Escape preview ended before reaching the boundary",
    "moon-impact": "Predicted lunar impact",
    "transfer-end": "Predicted transfer path · 8 days",
  };
  predictionStatus.textContent = projection ? labels[projection.outcome] : "";
  refreshGuides();
}

function setFitPath(enabled) {
  if (enabled) {
    cameraX = 0;
    cameraY = 0;
  }
  fitPath = enabled;
  fitButton.setAttribute("aria-pressed", String(enabled));
}

function viewScale(width, height) {
  if (!fitPath) return zoom;
  let x = isTransfer() ? transfer.distance : body.radius;
  let y = x;
  for (const points of [projection?.points ?? [], trace, compatibleComparison() ? comparison.path.points : []]) {
    for (const point of points) {
      x = Math.max(x, Math.abs(point.x));
      y = Math.max(y, Math.abs(point.y));
    }
  }
  if (stagedLaunch?.object) {
    x = Math.max(x, Math.abs(stagedLaunch.object.x) + stagedLaunch.radius);
    y = Math.max(y, Math.abs(stagedLaunch.object.y) + stagedLaunch.radius);
  }
  if (satellite) {
    x = Math.max(x, Math.abs(satellite.x));
    y = Math.max(y, Math.abs(satellite.y));
  }
  for (const object of extraObjects) {
    for (const point of object.trail) {
      x = Math.max(x, Math.abs(point.x));
      y = Math.max(y, Math.abs(point.y));
    }
    x = Math.max(x, Math.abs(object.x) + object.radius);
    y = Math.max(y, Math.abs(object.y) + object.radius);
  }
  return Math.min(2.5 * baselineScale(), width * 0.44 / x, height * 0.44 / y);
}

function setPhase(next) {
  phase = next;
  const inRun = phase === "flying" || phase === "resolved";
  const extrasFlying = flyingObjects();
  gravitySlider.disabled = inRun || extrasFlying || profileId !== "sandbox";
  for (const id of ["body-radius", "body-gm", "launch-altitude", "moon-radius", "moon-gm", "moon-distance", "moon-phase"]) controls[id].disabled = inRun || extrasFlying;
  controls["pause-flight"].disabled = phase !== "flying" && !extrasFlying;
  controls["step-flight"].disabled = !paused || (phase !== "flying" && !extrasFlying);
  controls["replay-flight"].disabled = !lastVelocity;
  aimSpeed.disabled = aimAngle.disabled = launchButton.disabled = inRun;
}

function resetScene() {
  paused = false;
  controls["pause-flight"].textContent = "Pause";
  satellite = restingSatellite();
  trace = [];
  particles = [];
  outcome = null;
  launchSpeed = 0;
  orbitHoldTime = 0;
  dragPointer = null;
  overlay.hidden = true;
  hudStatus.textContent = "";
  delete hudStatus.dataset.outcome;
  setPhase("idle");
  updatePrediction();
  render();
}

function beginDrag(clientX, clientY) {
  if (phase !== "idle") return;
  setPhase("dragging");
  dragOrigin = { x: clientX, y: clientY };
  dragPointer = anchorPoint();
  updatePrediction();
  lastDragSoundTime = 0;
}

function updateDrag(clientX, clientY) {
  if (phase !== "dragging") return;
  clearPreset();
  const anchor = anchorPoint();
  dragPointer = clampToMaxDistance(anchor, {
    x: anchor.x + clientX - dragOrigin.x,
    y: anchor.y + clientY - dragOrigin.y,
  }, MAX_DRAG_DISTANCE);
  const velocity = dragVelocity();
  const precision = Number(aimSpeed.step) < 0.01 ? 10 : 2;
  aimSpeed.value = Math.min(Number(aimSpeed.max), Number(Math.hypot(velocity.vx, velocity.vy).toFixed(precision)));
  aimAngle.value = Number((Math.atan2(-velocity.vy, velocity.vx) * 180 / Math.PI).toFixed(1));
  updatePrediction(velocity);

  const now = performance.now();
  if (now - lastDragSoundTime > DRAG_SOUND_THROTTLE_MS) {
    const ratio = dragDistance(anchorPoint(), dragPointer) / MAX_DRAG_DISTANCE;
    audio.playDragCharge(ratio);
    lastDragSoundTime = now;
  }
}

function dragVelocity() {
  const sensitivity = profileId === "sandbox" ? DRAG_SENSITIVITY : Number(aimSpeed.max) / MAX_DRAG_DISTANCE;
  return launchVelocity(anchorPoint(), dragPointer, sensitivity);
}

function endDrag() {
  if (phase !== "dragging") return;
  launchSatellite(dragVelocity());
}

function launchSatellite(velocity) {
  updatePrediction(velocity);
  satellite = { ...anchorPoint(), ...velocity, time: 0 };
  lastVelocity = velocity;
  paused = false;
  controls["pause-flight"].textContent = "Pause";
  physicsTime = 0;
  traceStep = 0;
  launchSpeed = Math.hypot(velocity.vx, velocity.vy);
  trace = [{ x: satellite.x, y: satellite.y }];
  orbitHoldTime = 0;
  dragPointer = null;
  audio.playLaunch();
  setPhase("flying");
}

function pushTracePoint(x, y) {
  trace.push({ x, y });
  if (trace.length > MAX_TRACE_POINTS) trace.shift();
}

function triggerShake() {
  if (reducedMotion) return;
  canvasWrap.classList.remove("is-shaking");
  // force reflow so the animation restarts if triggered again quickly
  void canvasWrap.offsetWidth;
  canvasWrap.classList.add("is-shaking");
  clearTimeout(shakeTimeoutId);
  shakeTimeoutId = setTimeout(() => canvasWrap.classList.remove("is-shaking"), 200);
}

function resolveOutcome(kind) {
  scoreFlight(kind === "moon-impact" ? "crash" : kind);
  outcome = kind;
  pushTracePoint(satellite.x, satellite.y);
  setPhase("resolved");

  hudStatus.dataset.outcome = kind;
  if (kind === "crash") {
    if (!reducedMotion && profileId === "sandbox" && body.radius === 40) particles = createDebrisBurst(satellite.x, satellite.y);
    triggerShake();
    audio.playCrash();
    hudStatus.textContent = "CRASH";
  } else if (kind === "orbit") {
    audio.playOrbitLock();
    hudOrbitCount.textContent = String(incrementOrbitCount());
    hudStatus.textContent = "ORBIT LOCKED";
  } else if (kind === "escape") {
    audio.playLaunch();
    hudStatus.textContent = "ESCAPED";
  }

  if (kind === "moon-impact") hudStatus.textContent = "LUNAR IMPACT";
  if (kind === "transfer-end") hudStatus.textContent = "TRANSFER COMPLETE";
  showOverlay(kind);
}

function showOverlay(kind) {
  outcomeTitle.textContent = hudStatus.textContent;
  outcomeTitle.dataset.outcome = kind;

  const stats = [["launch velocity", `${speedText(launchSpeed)} km/s`]];
  if (kind === "orbit" && satellite) {
    const elements = orbitalElements(satellite, gm);
    if (elements) {
      stats.push(["apoapsis", `${elements.apoapsis.toFixed(1)} km`]);
      stats.push(["periapsis", `${elements.periapsis.toFixed(1)} km`]);
      stats.push(["period", `${elements.period.toFixed(2)} s`]);
    }
  } else if (isTransfer()) {
    stats.push(["Elapsed time", `${(satellite.time / 86400).toFixed(2)} days`]);
  } else if (satellite) {
    const altitude = Math.hypot(satellite.x, satellite.y) - body.radius;
    stats.push(["altitude", `${altitude.toFixed(1)} km`]);
  }

  outcomeStats.innerHTML = stats.map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`).join("");
  overlay.hidden = false;
}

function stepPhysics(dt) {
  const step = physicsStep();
  physicsTime = Math.min(physicsTime + dt, step * 1000);
  while (physicsTime >= step && phase === "flying") {
    satellite = isTransfer() ? stepTransfer(satellite, step, transfer) : stepSimulation(satellite, step, gm);
    physicsTime -= step;
    if (++traceStep % (isTransfer() ? 60 : 8) === 0) pushTracePoint(satellite.x, satellite.y);
    if (isTransfer()) {
      const result = transferOutcome(satellite, transfer);
      if (result) resolveOutcome(result);
      continue;
    }
    const classification = classifyOutcome(satellite, body.radius, profileId === "sandbox" ? Math.max(500, escapeRadius()) : escapeRadius(), gm);
    if (classification === "crash" || classification === "escape") {
      resolveOutcome(classification);
      return;
    }

    if (classification === "orbit") {
      orbitHoldTime += step;
      const elements = orbitalElements(satellite, gm);
      if (elements && orbitHoldTime >= elements.period * 2) {
        resolveOutcome("orbit");
        return;
      }
    } else {
      orbitHoldTime = 0;
    }
  }
}

function updateHud() {
  const readout = buildHudReadout(satellite, gm, body.radius);
  hudFields.velocity.textContent = readout.velocity;
  hudFields.altitude.textContent = readout.altitude;
  hudFields.apoapsis.textContent = isTransfer() ? "—" : readout.apoapsis;
  hudFields.periapsis.textContent = isTransfer() ? "—" : readout.periapsis;
  hudFields.period.textContent = isTransfer() ? "—" : readout.period;
}

function drawGrid(width, height) {
  ctx.save();
  ctx.strokeStyle = "rgba(77, 216, 232, 0.08)";
  ctx.lineWidth = 1;
  const step = 40;
  for (let x = 0; x < width; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y < height; y += step) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawLaunchPad(cx, cy, scale) {
  if (phase !== "idle" && phase !== "dragging") return;
  ctx.save();
  ctx.strokeStyle = "rgba(77, 216, 232, 0.4)";
  ctx.lineWidth = 1 / scale;
  ctx.setLineDash([2 / scale, 5 / scale]);
  ctx.beginPath();
  ctx.arc(cx, cy, launchRadius(), 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawPlanet(cx, cy, scale) {
  const displayRadius = Math.max(body.radius, 10 / scale);
  const glow = ctx.createRadialGradient(cx, cy, displayRadius * 0.4, cx, cy, displayRadius * 2.2);
  const rimColor = outcome === "crash" ? "255, 82, 82" : "77, 216, 232";
  glow.addColorStop(0, `rgba(${rimColor}, 0.35)`);
  glow.addColorStop(1, `rgba(${rimColor}, 0)`);
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, displayRadius * 2.2, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#0f1f38";
  ctx.strokeStyle = outcome === "crash" ? "#ff5252" : "#4dd8e8";
  ctx.lineWidth = 2 / scale;
  ctx.beginPath();
  ctx.arc(cx, cy, displayRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  if (["sandbox", "earth"].includes(profileId) && displayRadius * scale >= 22) {
    drawFlightIcon("🌍", cx, cy, scale, Math.min(78, displayRadius * scale * 1.65));
  }
}

function drawTrace(cx, cy, scale) {
  if (trace.length < 2) return;
  ctx.save();
  ctx.strokeStyle = outcome === "orbit" ? "rgba(94, 235, 176, 0.8)" : "rgba(255, 107, 74, 0.7)";
  ctx.lineWidth = 1.5 / scale;
  ctx.setLineDash([4 / scale, 4 / scale]);
  ctx.beginPath();
  trace.forEach((point, i) => {
    const x = cx + point.x;
    const y = cy + point.y;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.restore();
}

function drawPrediction(cx, cy, scale, path, color) {
  if (!path) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 / scale;
  ctx.setLineDash([5 / scale, 5 / scale]);
  ctx.beginPath();
  path.points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(cx + point.x, cy + point.y);
    else ctx.lineTo(cx + point.x, cy + point.y);
  });
  ctx.stroke();
  ctx.restore();
}

function drawMarker(point, label, color, scale, offset = -7) {
  ctx.save();
  ctx.translate(point.x, point.y);
  ctx.scale(1 / scale, 1 / scale);
  ctx.fillStyle = color;
  ctx.font = "11px monospace";
  ctx.beginPath();
  ctx.arc(0, 0, 3, 0, 2 * Math.PI);
  ctx.fill();
  ctx.fillText(label, 7, offset);
  ctx.restore();
}

function drawOverlays(scale) {
  if (projection) {
    const impact = ["crash", "moon-impact"].includes(projection.outcome) ? projection.points.at(-1) : null;
    if (projection.near !== impact) drawMarker(projection.near, "Closest", "#4dd8e8", scale, 14);
    if (projection.far !== impact) drawMarker(projection.far, "Farthest", "#a2eaf3", scale);
    if (impact) drawMarker(impact, "Impact", "#ff7968", scale);
  }
  if (isTransfer()) {
    ctx.save();
    ctx.strokeStyle = "rgba(214,216,223,0.3)";
    ctx.lineWidth = 1 / scale;
    ctx.setLineDash([2 / scale, 6 / scale]);
    ctx.beginPath();
    ctx.arc(0, 0, transfer.distance, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.restore();
    drawMarker(moonPosition(satellite?.time ?? 0, transfer), "Moon", "#d6d8df", scale);
  }
}

function drawFlightIcon(icon, x, y, scale, size = 24) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1 / scale, 1 / scale);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${size}px "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;
  ctx.fillText(icon, 0, 0);
  ctx.restore();
}

function drawExtraObjects(scale) {
  for (const object of extraObjects) {
    if (object.status.startsWith("Merged")) continue;
    ctx.save();
    if (object.status === "Flying") {
      ctx.globalAlpha = 0.58;
      drawPrediction(0, 0, scale, object.prediction, object.color);
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = object.color;
    ctx.fillStyle = object.color;
    ctx.lineWidth = 1.5 / scale;
    ctx.beginPath();
    object.trail.forEach((point, i) => {
      if (i === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.stroke();
    ctx.beginPath();
    const size = Math.min(100, Math.max(2, object.radius * scale)) / scale;
    ctx.arc(object.x, object.y, size, 0, Math.PI * 2);
    ctx.fill();
    if (object.icon) drawFlightIcon(object.status === "Central body impact" ? "💥" : object.icon, object.x, object.y, scale);
    ctx.restore();
  }
}

function drawSatellite(cx, cy, scale) {
  if (!satellite) return;
  ctx.fillStyle = "#ff6b4a";
  ctx.beginPath();
  ctx.arc(cx + satellite.x, cy + satellite.y, 4 / scale, 0, Math.PI * 2);
  ctx.fill();
}

function drawParticles(cx, cy) {
  for (const p of particles) {
    ctx.save();
    ctx.globalAlpha = particleOpacity(p);
    ctx.fillStyle = "#ff5252";
    ctx.beginPath();
    ctx.arc(cx + p.x, cy + p.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function drawDragIndicator(cx, cy, scale) {
  if (phase !== "dragging" || !dragPointer) return;
  const anchor = anchorPoint();
  ctx.save();
  ctx.strokeStyle = "#4dd8e8";
  const x = cx + anchor.x + (dragPointer.x - anchor.x) / scale;
  const y = cy + anchor.y + (dragPointer.y - anchor.y) / scale;
  ctx.lineWidth = 2 / scale;
  ctx.setLineDash([6 / scale, 4 / scale]);
  ctx.beginPath();
  ctx.moveTo(cx + anchor.x, cy + anchor.y);
  ctx.lineTo(x, y);
  ctx.stroke();

  ctx.setLineDash([]);
  ctx.fillStyle = "#ff6b4a";
  ctx.beginPath();
  ctx.arc(x, y, 5 / scale, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function render() {
  const { cx, cy, width, height } = center();
  ctx.clearRect(0, 0, width, height);
  const scale = viewScale(width, height);
  if (scale > 0 && !spacetimeView.hidden) {
    const camera = { x: cx + cameraX, y: cy + cameraY, scale };
    const moon = isTransfer() ? { ...moonPosition(satellite?.time ?? 0, transfer), radius: transfer.moon.radius, gm: transfer.moon.gm } : null;
    drawSpacetime(ctx, width, height, createWells(body, extraObjects, moon, camera), camera);
  } else {
    drawGrid(width, height);
  }
  const percent = scale / baselineScale() * 100;
  const readout = `${percent < 10 ? Number(percent.toPrecision(2)) : Math.round(percent)}%`;
  if (zoomValue.textContent !== readout) zoomValue.textContent = readout;
  ctx.save();
  ctx.translate(cx + cameraX, cy + cameraY);
  ctx.scale(scale, scale);
  drawTrace(0, 0, scale);
  drawPlanet(0, 0, scale);
  drawLaunchPad(0, 0, scale);
  if (compatibleComparison()) drawPrediction(0, 0, scale, comparison.path, "#f9c86e");
  drawPrediction(0, 0, scale, projection, "#4dd8e8");
  drawOverlays(scale);
  drawParticles(0, 0);
  drawDragIndicator(0, 0, scale);
  drawExtraObjects(scale);
  drawStagedLaunch(scale);
  if (collisionFlash && performance.now() < collisionFlash.until) drawFlightIcon("💫", collisionFlash.x, collisionFlash.y, scale, 32);
  drawSatellite(0, 0, scale);
  ctx.restore();
  updateHud();
}

function frame(timestamp) {
  if (lastFrameTime === null) lastFrameTime = timestamp;
  const rawDt = Math.min(MAX_FRAME_DT, (timestamp - lastFrameTime) / 1000);
  lastFrameTime = timestamp;
  const dt = rawDt * (Number(playback.value) || 3);

  if (phase === "flying" && !paused) {
    stepPhysics(dt);
  }
  if (!paused) advanceObjects(dt);
  if (!paused && timestamp >= nextPathRefresh && extraObjects.length) {
    const object = extraObjects[pathCursor++ % extraObjects.length];
    if (object.status === "Flying") object.prediction = predictExtra(object);
    nextPathRefresh = timestamp + 110;
  }
  if (!paused && !reducedMotion && particles.length) {
    particles = updateParticles(particles, dt);
  }

  render();
  requestAnimationFrame(frame);
}

function updateMuteButton() {
  const muted = audio.isMuted();
  muteButton.textContent = muted ? "Unmute sound" : "Mute sound";
}

function setMinimumZoom(factor) {
  if (factor === minimumZoom) return;
  minimumZoom = factor;
  zoomSlider.min = factor * 100;
  zoomSlider.step = factor * 10;
}

function allowZoomBelowFit(scale) {
  if (!fitPath) return;
  const factor = scale / baselineScale();
  if (factor <= 2 * minimumZoom) {
    // Leave a full decade of zoom-out room when the fitted scene is already very small.
    setMinimumZoom(Math.min(minimumZoom, 10 ** (Math.floor(Math.log10(factor)) - 1)));
  }
}

function manualZoom(scale) {
  allowZoomBelowFit(scale);
  setFitPath(false);
  zoom = scale;
  const percent = scale / baselineScale() * 100;
  const step = Number(zoomSlider.step) || 1;
  zoomSlider.value = Number((Math.round(percent / step) * step).toPrecision(12));
}

function startGesture(event) {
  if (event.button !== 0 || pointerGesture || stagedLaunch) return;
  const rect = canvas.getBoundingClientRect();
  const scale = viewScale(rect.width, rect.height);
  const x = event.clientX - rect.left - rect.width / 2;
  const y = event.clientY - rect.top - rect.height / 2;
  const hitRadius = event.pointerType === "touch" ? 28 : 20;
  const aiming = phase === "idle" &&
    Math.hypot(x - cameraX - launchRadius() * scale, y - cameraY) <= hitRadius;
  pointerGesture = { id: event.pointerId, aiming, x: event.clientX, y: event.clientY };
  canvas.setPointerCapture(event.pointerId);
  canvas.dataset.gesture = aiming ? "aim" : "pan";
  if (aiming) beginDrag(event.clientX, event.clientY);
}

function moveGesture(event) {
  if (pointerGesture?.id !== event.pointerId) return;
  if (pointerGesture.aiming) {
    updateDrag(event.clientX, event.clientY);
    return;
  }
  const dx = event.clientX - pointerGesture.x;
  const dy = event.clientY - pointerGesture.y;
  if (dx === 0 && dy === 0) return;
  if (fitPath) {
    const { width, height } = center();
    manualZoom(viewScale(width, height));
  }
  cameraX += dx;
  cameraY += dy;
  pointerGesture.x = event.clientX;
  pointerGesture.y = event.clientY;
}

function finishGesture(event) {
  if (pointerGesture?.id !== event.pointerId) return;
  const { aiming, x, y } = pointerGesture;
  pointerGesture = null;
  delete canvas.dataset.gesture;
  if (!aiming || phase !== "dragging") return;
  if (event.type === "pointerup" && Math.hypot(event.clientX - x, event.clientY - y) > 2) {
    updateDrag(event.clientX, event.clientY);
    endDrag();
  } else {
    resetScene();
  }
}

function wheelZoom(event) {
  if (event.ctrlKey || event.deltaY === 0) return;
  event.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const scale = viewScale(rect.width, rect.height);
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
  const delta = Math.max(-150, Math.min(150, event.deltaY * unit));
  allowZoomBelowFit(scale);
  const base = baselineScale();
  const next = Math.max(minimumZoom * base, Math.min(MAX_ZOOM * base, scale * Math.exp(-delta * 0.002)));
  const ratio = next / scale;
  const x = event.clientX - rect.left - rect.width / 2;
  const y = event.clientY - rect.top - rect.height / 2;
  cameraX = x - (x - cameraX) * ratio;
  cameraY = y - (y - cameraY) * ratio;
  manualZoom(next);
}

function clearPreset() {
  if (!presetSelect.value) return;
  presetSelect.value = "";
  presetDescription.textContent = defaultPresetDescription;
}

function updateSpeedRange() {
  const escape = escapeVelocity(launchRadius(), gm);
  aimSpeed.max = profileId === "sandbox" ? Math.max(19.8, Math.ceil(2 * escape * 100) / 100) : Number((2 * escape).toPrecision(9));
  aimSpeed.step = escape < 0.1 ? 0.0000000001 : 0.01;
}

function syncPlayback() {
  for (const option of playback.querySelectorAll("wa-option")) {
    option.disabled = profileId === "sandbox" && Number(option.getAttribute("value")) > 24;
  }
}

function loadProfile(id, override) {
  if (!Object.hasOwn(profiles, id) && id !== "transfer") return;
  const oldId = profileId;
  const oldGM = gm;
  const oldRadius = body.radius;
  profileId = id;
  editingCatalogTile = null;
  body = isTransfer() ? transfer.earth : override ? { ...bodies[id] } : profiles[id];
  if (override?.altitude !== undefined) body.altitude = override.altitude;
  if (override?.gm !== undefined) body.gm = override.gm;
  gm = body.gm;
  if (oldId !== id || oldGM !== gm || oldRadius !== body.radius) clearObjects();
  objectForm.querySelector("[type=submit]").disabled = isTransfer();
  syncCollisionControls();
  for (const tile of document.querySelectorAll("[data-toy]")) tile.disabled = isTransfer();
  document.getElementById("flight-hint").textContent = isTransfer()
    ? "Use Launch for an Earth–Moon transfer. Quick launch tiles are available with a single central body."
    : "Drag any picture into the scene to aim and launch. Tap a catalog picture to edit its settings.";
  if (isTransfer()) objectStatus.textContent = "Select a single central body to add objects.";
  controls["body-profile"].value = id;
  controls["transfer-fields"].hidden = !isTransfer();
  controls["body-radius"].value = body.radius;
  controls["body-gm"].value = gm;
  controls["launch-altitude"].value = body.altitude;
  gravitySlider.value = Math.max(1500, Math.min(7000, gm));
  gravityValue.textContent = id === "sandbox" ? String(gm) : "—";
  updateSpeedRange();
  aimSpeed.value = override?.speed ?? (isTransfer() ? 10.92 : Math.min(body.speed, Number(aimSpeed.max)));
  aimAngle.value = override?.angle ?? 90;
  syncObjectDefaults();
  syncPlayback();
  playback.value = isTransfer() ? "24000" : id === "sandbox" ? "3" : "2400";
  controls["body-note"].textContent = isTransfer()
    ? "Idealized 8-day flyby with a moving Moon. The main fields edit Earth, and the Moon has separate controls."
    : "Radius and GM are editable for each profile. Artificial bodies are modeled as isolated spheres.";
  lastVelocity = null;
  zoom = baselineScale();
  setMinimumZoom(MIN_ZOOM);
  setFitPath(true);
  resetScene();
}

function editBody() {
  if (phase !== "idle") return;
  const fields = ["body-radius", "body-gm", "launch-altitude"].map(id => controls[id]);
  const values = fields.map(field => field.value === "" || field.value == null ? NaN : Number(field.value));
  if (!fields.every((field, i) => Number.isFinite(values[i]) && values[i] >= Number(field.min) && values[i] <= Number(field.max))) return;
  if (isTransfer()) {
    const fields = ["moon-radius", "moon-gm", "moon-distance", "moon-phase"].map(id => controls[id]);
    const numbers = fields.map(field => field.value === "" || field.value == null ? NaN : Number(field.value));
    const [radius, parameter, distance, phaseAngle] = numbers;
    if (!fields.every((field, i) => Number.isFinite(numbers[i]) && numbers[i] >= Number(field.min) && numbers[i] <= Number(field.max))) return;
    if (distance <= values[0] + values[2] + radius) {
      controls["body-note"].textContent = "Increase the Moon’s distance so its orbit clears both Earth and the launch point.";
      return;
    }
    Object.assign(transfer.moon, { radius, gm: parameter });
    Object.assign(transfer, { distance, phase: phaseAngle });
    controls["body-note"].textContent = "Idealized 8-day transfer with your Earth and Moon settings.";
  }
  [body.radius, gm, body.altitude] = values;
  body.gm = gm;
  if (!isTransfer()) profiles[profileId] = body;
  if (profileId === "sandbox") {
    gravitySlider.value = Math.max(1500, Math.min(7000, gm));
    gravityValue.textContent = String(gm);
  }
  updateSpeedRange();
  clearPreset();
  lastVelocity = null;
  setFitPath(true);
  resetScene();
}

function applyPreset() {
  const preset = presets[presetSelect.value];
  if (!preset) return;
  loadProfile(preset.profile ?? "sandbox", preset);
  presetDescription.textContent = preset.description;
}

function wirePalette() {
  const dialog = document.getElementById("quick-palette");
  const query = document.getElementById("palette-query");
  const count = document.getElementById("palette-count");
  const results = document.getElementById("palette-results");
  let mode = "catalog";
  let active = 0;
  let matches = [];
  let onClose = null;

  const commands = [
    { name: "Place an object on the canvas", category: "Simulation", run: () => open("add") },
    { name: "Search objects", category: "Catalog · /", run: () => open("catalog"), switchesMode: true },
    { name: "Launch satellite", category: "Simulation", run: () => {
      const velocity = currentAim();
      if (phase === "idle" && velocity) launchSatellite(velocity);
      else if (phase === "idle") aimForm.reportValidity();
    } },
    { name: "Add an orbiting object", category: "Simulation", run: () => focusObjectForm("name") },
    { name: "Pause or resume", category: "Playback", run: () => controls["pause-flight"].click() },
    { name: "Step simulation", category: "Playback", run: () => controls["step-flight"].click() },
    { name: "Replay launch", category: "Playback", run: () => controls["replay-flight"].click() },
    { name: "Fit path", category: "Camera", run: () => fitButton.click() },
    { name: "Show or hide spacetime", category: "View", run: () => spacetimeToggle.click() },
    { name: "Mute or unmute sound", category: "Audio", run: () => muteButton.click() },
    { name: "Reset scene", category: "Simulation · opens confirmation", run: () => resetButton.click() },
  ];

  function focusObjectForm(field) {
    document.querySelector(".advanced-settings").open = true;
    objectForm.closest("wa-details").open = true;
    objectForm.scrollIntoView({ block: "center", behavior: "instant" });
    objectField(field).focus();
  }

  function activate(index) {
    const entry = matches[index];
    if (!entry) return;
    if (entry.switchesMode) return entry.run();
    if (entry.referenceOnly) {
      count.textContent = `${entry.name} is a reference entry. Compact-object physics is outside the current model.`;
      return;
    }
    onClose = entry.run ?? (() => pinCatalogEntry(entry));
    dialog.open = false;
  }

  function setActive(index, scroll) {
    if (!matches.length) return;
    results.children[active]?.removeAttribute("data-active");
    active = (index + matches.length) % matches.length;
    const row = results.children[active];
    row.setAttribute("data-active", "");
    if (scroll) row.scrollIntoView({ block: "nearest" });
  }

  function renderResults() {
    matches = searchEntries(mode === "commands" ? commands : catalog, query.value || "");
    active = 0;
    results.replaceChildren();
    count.textContent = `${matches.length} ${mode === "commands" ? "commands" : "of 100 objects"}`;
    matches.forEach((entry, index) => {
      const button = document.createElement("wa-button");
      button.setAttribute("type", "button");
      button.setAttribute("appearance", "plain");
      button.setAttribute("size", "small");
      const name = document.createElement("span");
      name.className = "palette-entry-name";
      if (!entry.run) {
        const icon = document.createElement("span");
        icon.className = "palette-entry-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.textContent = catalogIcon(entry);
        name.append(icon);
      }
      name.append(entry.name);
      const info = document.createElement("span");
      info.className = "palette-entry-info";
      const label = entry.referenceOnly ? "Reference only" : entry.run ? "" :
        catalogDefaults(entry, bodies).illustrative ? "Add to tray · illustrative defaults" : "Add to tray";
      info.textContent = [entry.category, label, entry.note].filter(Boolean).join(" · ");
      button.append(name, info);
      button.addEventListener("click", () => activate(index));
      results.append(button);
    });
    setActive(0, false);
    results.scrollTop = 0;
  }

  function open(nextMode) {
    mode = nextMode;
    const title = mode === "add" ? "Add object to scene" : mode === "catalog" ? "Search objects" : "Run a command";
    dialog.label = title;
    query.label = mode === "commands" ? "Search commands" : "Search by name or category";
    query.value = "";
    renderResults();
    if (dialog.open) query.focus();
    else dialog.open = true;
  }

  document.getElementById("open-placement-catalog").addEventListener("click", () => open("add"));
  document.getElementById("open-catalog").addEventListener("click", () => open("catalog"));
  document.getElementById("open-commands").addEventListener("click", () => open("commands"));
  dialog.addEventListener("wa-after-show", () => query.focus());
  dialog.addEventListener("wa-after-hide", () => {
    const action = onClose;
    onClose = null;
    action?.();
  });
  query.addEventListener("input", renderResults);
  query.addEventListener("keydown", event => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive(active + (event.key === "ArrowDown" ? 1 : -1), true);
    }
    if (event.key === "Enter") {
      event.preventDefault();
      activate(active);
    }
  });
  document.addEventListener("keydown", event => {
    if (event.defaultPrevented || event.repeat || event.altKey || event.isComposing) return;
    const modified = event.ctrlKey || event.metaKey;
    const target = event.composedPath()[0];
    const editing = target?.isContentEditable || target?.matches?.("input, textarea, select, wa-input, wa-number-input");
    if (modified && event.key.toLowerCase() === "k") {
      event.preventDefault();
      open("commands");
    } else if (event.key === "/" && (modified || (!editing && !dialog.open))) {
      event.preventDefault();
      open("catalog");
    }
  });
}

function wireDragTile(button, icon, tap, drop) {
  let start = null;
  let ghost = null;
  let dragged = false;
  function cleanup() {
    start = null;
    ghost?.remove();
    ghost = null;
  }
  button.addEventListener("click", event => {
    if (!dragged || event.detail === 0) tap();
  });
  button.addEventListener("pointerdown", event => {
    if (event.button !== 0 || !event.isPrimary || button.disabled) return;
    dragged = false;
    start = { id: event.pointerId, x: event.clientX, y: event.clientY };
    button.setPointerCapture(event.pointerId);
  });
  button.addEventListener("pointermove", event => {
    if (start?.id !== event.pointerId) return;
    if (!ghost && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) {
      dragged = true;
      ghost = document.createElement("span");
      ghost.className = "flight-ghost";
      ghost.setAttribute("aria-hidden", "true");
      ghost.textContent = icon;
      document.body.append(ghost);
    }
    if (ghost) {
      ghost.style.left = `${event.clientX}px`;
      ghost.style.top = `${event.clientY}px`;
    }
  });
  button.addEventListener("pointerup", event => {
    if (start?.id !== event.pointerId) return;
    if (dragged) {
      const { left, right, top, bottom } = canvas.getBoundingClientRect();
      const { clientX: x, clientY: y } = event;
      if (x >= left && x <= right && y >= top && y <= bottom) drop(x, y);
    }
    cleanup();
  });
  button.addEventListener("pointercancel", cleanup);
  button.addEventListener("lostpointercapture", cleanup);
}

function predictExtra(object) {
  const surface = body.radius + object.radius;
  const boundary = Math.max(surface * 1.01, profileId === "sandbox" ? Math.max(500, escapeRadius()) : escapeRadius());
  return projectTrajectory(object, gm, surface, boundary, physicsStep());
}

function worldPoint(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const scale = viewScale(rect.width, rect.height);
  return {
    x: (clientX - rect.left - rect.width / 2 - cameraX) / scale,
    y: (clientY - rect.top - rect.height / 2 - cameraY) / scale,
  };
}

function updateStagedPrediction() {
  const launch = stagedLaunch;
  const object = launchObject({
    id: 0, name: "", mass: 1, radius: launch.radius, distance: body.radius + launch.altitude,
    speed: launch.speed, position: launch.position, heading: launch.heading, time: objectTime,
  });
  launch.object = object;
  launch.path = predictExtra(object);
  const outcome = { orbit: "orbit", crash: "impact", escape: "escape", partial: "partial path" };
  document.getElementById("aimed-summary").textContent =
    `${speedText(launch.speed)} km/s · ${launch.heading.toFixed(0)}° · ${outcome[launch.path.outcome]}`;
}

function stageExtra(x, y, toy) {
  if (isTransfer()) {
    placementStatus.textContent = "Switch to a single central body to launch objects.";
    return;
  }
  if (extraObjects.length >= MAX_OBJECTS) {
    placementStatus.textContent = "Remove an object before adding another.";
    return;
  }
  const radius = toy?.radius ?? Number(objectField("radius").value);
  const mass = toy?.mass ?? Number(objectField("mass").value);
  if (!(radius > 0 && mass >= 1e-18)) {
    placementStatus.textContent = "Enter the object’s mass and radius first.";
    return;
  }
  const point = worldPoint(x, y);
  const altitude = Math.max(radius + Math.max(body.radius * 0.1, 1e-6), Math.hypot(point.x, point.y) - body.radius);
  stagedLaunch = {
    radius, altitude, position: Math.atan2(-point.y, point.x) * 180 / Math.PI,
    heading: toy?.heading ?? 90, speed: toy?.customSpeed ?? Math.min(100000, circularOrbitVelocity(body.radius + altitude, gm) * (toy?.speed ?? 1)), toy,
  };
  document.getElementById("aimed-controls").hidden = false;
  canvas.setAttribute("data-placing", "");
  placementStatus.textContent = "✋ ➜ ➶ Drag in the scene to aim, then release.";
  updateStagedPrediction();
  setFitPath(true);
}

function cancelStagedLaunch() {
  stagedLaunch = null;
  aimPointer = null;
  document.getElementById("aimed-controls").hidden = true;
  canvas.removeAttribute("data-placing");
}

function fireStagedLaunch() {
  if (!stagedLaunch) return;
  const launch = stagedLaunch;
  cancelStagedLaunch();
  addObject(null, launch, launch.toy);
  if (launch.toy) placementStatus.textContent = "";
}

function drawStagedLaunch(scale) {
  if (!stagedLaunch) return;
  const { object, path, toy } = stagedLaunch;
  drawPrediction(0, 0, scale, path, "#fff1a3");
  const circular = circularOrbitVelocity(body.radius + stagedLaunch.altitude, gm);
  const arrowScale = 48 / (circular * scale);
  const endX = object.x + object.vx * arrowScale;
  const endY = object.y + object.vy * arrowScale;
  ctx.save();
  ctx.strokeStyle = "#fff1a3";
  ctx.lineWidth = 2 / scale;
  ctx.beginPath();
  ctx.moveTo(object.x, object.y);
  ctx.lineTo(endX, endY);
  if (stagedLaunch.speed > 0) {
    const direction = Math.atan2(object.vy, object.vx);
    for (const side of [-1, 1]) {
      ctx.moveTo(endX, endY);
      ctx.lineTo(endX - 9 * Math.cos(direction + side * 0.48) / scale,
        endY - 9 * Math.sin(direction + side * 0.48) / scale);
    }
  }
  ctx.stroke();
  ctx.restore();
  drawFlightIcon(toy?.icon ?? "🪐", object.x, object.y, scale);
}

function wirePlacement() {
  for (const tile of document.querySelectorAll("[data-toy]")) {
    const toy = quickToys[tile.dataset.toy];
    wireDragTile(tile, toy.icon, () => addObject(null, null, toy), (x, y) => stageExtra(x, y, toy));
  }
  canvas.addEventListener("pointerdown", event => {
    if (!stagedLaunch || event.button !== 0 || !event.isPrimary) return;
    aimPointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
  });
  function aim(event) {
    if (aimPointer?.id !== event.pointerId || !stagedLaunch) return false;
    const dx = event.clientX - aimPointer.x;
    const dy = event.clientY - aimPointer.y;
    if (Math.hypot(dx, dy) < 5) return false;
    const circular = circularOrbitVelocity(body.radius + stagedLaunch.altitude, gm);
    const angle = Math.atan2(-dy, dx) * 180 / Math.PI;
    stagedLaunch.speed = Math.min(100000, circular * Math.min(3, Math.hypot(dx, dy) / 48));
    stagedLaunch.heading = ((angle - stagedLaunch.position + 540) % 360) - 180;
    updateStagedPrediction();
    return true;
  }
  canvas.addEventListener("pointermove", aim);
  canvas.addEventListener("pointerup", event => {
    if (aimPointer?.id !== event.pointerId) return;
    if (aim(event)) fireStagedLaunch();
    else aimPointer = null;
  });
  canvas.addEventListener("lostpointercapture", () => { aimPointer = null; });
  document.getElementById("fire-aimed").addEventListener("click", fireStagedLaunch);
  document.getElementById("cancel-aimed").addEventListener("click", () => {
    cancelStagedLaunch();
    placementStatus.textContent = "";
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    if (stagedLaunch) {
      cancelStagedLaunch();
      placementStatus.textContent = "";
    }
  });
}

const catalogTiles = new Map();
let editingCatalogTile = null;

function configureCatalogTile(tile) {
  editingCatalogTile = tile;
  const altitude = Math.max(tile.customAltitude ?? body.altitude, tile.radius * 1.15);
  objectField("name").value = tile.name;
  objectField("mass").value = tile.mass;
  objectField("radius").value = tile.radius;
  objectField("height").value = altitude;
  objectField("speed").value = tile.customSpeed ?? Math.min(100000, circularOrbitVelocity(body.radius + altitude, gm));
  objectField("heading").value = tile.heading;
  document.querySelector(".advanced-settings").open = true;
  objectForm.closest("wa-details").open = true;
  objectStatus.textContent = `${tile.name} settings · Changes apply to future launches from this tile.`;
  objectForm.scrollIntoView({ block: "center", behavior: "instant" });
}

function updateCatalogTile(event) {
  if (!editingCatalogTile) return;
  const keys = { mass: ["mass", 1e-18, 1e33], radius: ["radius", 1e-9, 1e7],
    height: ["customAltitude", 1e-9, 1e8], speed: ["customSpeed", 0, 100000], heading: ["heading", -180, 180] };
  const key = event.target.id?.replace("object-", "");
  if (!Object.hasOwn(keys, key)) return;
  const [property, min, max] = keys[key];
  const raw = event.target.value;
  const value = Number(raw);
  if (raw != null && raw !== "" && Number.isFinite(value) && value >= min && value <= max) {
    editingCatalogTile[property] = value;
  }
}

function pinCatalogEntry(entry) {
  const existing = catalogTiles.get(entry.name);
  if (existing) {
    existing.focus();
    return;
  }
  const toy = { name: entry.name, ...catalogDefaults(entry, bodies) };
  const tile = document.createElement("wa-button");
  tile.className = "catalog-tile";
  tile.setAttribute("type", "button");
  tile.setAttribute("aria-label", `Configure ${toy.name}`);
  tile.setAttribute("title", `Drag to aim and launch ${toy.name}, or click to edit`);
  const content = document.createElement("div");
  const icon = document.createElement("span");
  icon.textContent = toy.icon;
  icon.setAttribute("aria-hidden", "true");
  const label = document.createElement("small");
  label.className = "catalog-tile-name";
  label.textContent = toy.name;
  content.append(icon, label);
  tile.append(content);
  document.querySelector(".flight-tray").append(tile);
  catalogTiles.set(entry.name, tile);
  wireDragTile(tile, toy.icon, () => configureCatalogTile(toy), (x, y) => stageExtra(x, y, toy));
  tile.scrollIntoView({ block: "nearest" });
  tile.focus();
  document.getElementById("catalog-tray-status").textContent = isTransfer()
    ? `${toy.icon} ${toy.name} added. Switch to a single central body to launch it.`
    : `${toy.icon} ${toy.name} added. Drag to aim or click to edit${toy.illustrative ? " · illustrative defaults" : ""}.`;
}

function wireControls() {
  objectForm.addEventListener("change", updateCatalogTile);
  wirePalette();
  wirePlacement();
  collisionControl.addEventListener("change", syncCollisionControls);
  collisionRewards.addEventListener("change", syncCollisionControls);
  collisionDemo.addEventListener("click", () => {
    if (isTransfer() || collisionControl.value === "off") return;
    if (extraObjects.length > MAX_OBJECTS - 2) {
      collisionFeedback.textContent = "Remove two objects or reset the scene to make room for the demo.";
      return;
    }
    const demo = { icon: "🛰️", mass: 1000, radius: Math.max(0.00001, body.radius * 0.035), speed: 1 };
    addObject(null, null, { ...demo, name: "Challenger A", position: -35, heading: 90 });
    addObject(null, null, { ...demo, name: "Challenger B", position: 35, heading: -90 });
  });
  spacetimeToggle.addEventListener("click", () => {
    spacetimeView.hidden = !spacetimeView.hidden;
    spacetimeToggle.textContent = spacetimeView.hidden ? "Show spacetime" : "Hide spacetime";
    spacetimeToggle.setAttribute("aria-pressed", String(!spacetimeView.hidden));
    render();
  });
  objectForm.addEventListener("submit", addObject);
  presetSelect.addEventListener("change", applyPreset);
  controls["body-profile"].addEventListener("change", () => {
    clearPreset();
    loadProfile(controls["body-profile"].value);
  });
  for (const id of ["body-radius", "body-gm", "launch-altitude", "moon-radius", "moon-gm", "moon-distance", "moon-phase"]) controls[id].addEventListener("change", editBody);
  controls["pause-flight"].addEventListener("click", () => {
    if (phase !== "flying" && !flyingObjects()) return;
    paused = !paused;
    controls["pause-flight"].textContent = paused ? "Resume" : "Pause";
    setPhase(phase);
  });
  controls["step-flight"].addEventListener("click", () => {
    if (!paused) return;
    if (phase === "flying") stepPhysics(physicsStep());
    advanceObjects(physicsStep());
  });
  controls["replay-flight"].addEventListener("click", () => {
    if (!lastVelocity) return;
    resetScene();
    launchSatellite(lastVelocity);
  });
  controls["pin-path"].addEventListener("click", () => {
    if (!projection) return;
    comparison = {
      profile: profileId, radius: body.radius, path: projection,
      summary: pathSummary(projection, gm, body.altitude),
    };
    setFitPath(true);
    refreshGuides();
  });
  controls["clear-path"].addEventListener("click", () => {
    comparison = null;
    refreshGuides();
  });
  canvas.addEventListener("pointerdown", startGesture);
  canvas.addEventListener("pointermove", moveGesture);
  canvas.addEventListener("pointerup", finishGesture);
  canvas.addEventListener("pointercancel", finishGesture);
  canvas.addEventListener("lostpointercapture", finishGesture);
  canvasWrap.addEventListener("wheel", wheelZoom, { passive: false });

  aimForm.addEventListener("input", () => {
    if (phase === "idle") {
      clearPreset();
      updatePrediction();
    }
  });
  aimForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const velocity = currentAim();
    if (phase === "idle" && velocity) launchSatellite(velocity);
  });
  zoomSlider.addEventListener("input", () => {
    zoom = Number(zoomSlider.value) / 100 * baselineScale();
    setFitPath(false);
  });
  fitButton.addEventListener("click", () => {
    overlay.hidden = true;
    if (fitPath) {
      const { width, height } = center();
      manualZoom(viewScale(width, height));
    } else {
      setFitPath(true);
    }
  });
  document.getElementById("view-path").addEventListener("click", () => {
    overlay.hidden = true;
    setFitPath(true);
    resetButton.focus();
  });

  gravitySlider.addEventListener("input", () => {
    body.gm = gm = Number(gravitySlider.value);
    controls["body-gm"].value = gm;
    lastVelocity = null;
    controls["replay-flight"].disabled = true;
    updateSpeedRange();
    gravityValue.textContent = String(gm);
    if (phase === "idle") {
      clearPreset();
      updatePrediction();
    }
  });

  muteButton.addEventListener("click", () => {
    audio.toggleMute();
    updateMuteButton();
    if (!audio.isMuted()) audio.playUiClick();
  });

  resetButton.addEventListener("click", () => {
    resetConfirmation.hidden = !resetConfirmation.hidden;
    if (!resetConfirmation.hidden) document.getElementById("cancel-reset").focus();
  });
  const closeReset = () => {
    resetConfirmation.hidden = true;
    resetButton.focus();
  };
  document.getElementById("cancel-reset").addEventListener("click", closeReset);
  document.getElementById("confirm-reset").addEventListener("click", () => {
    audio.playUiClick();
    clearObjects();
    comparison = null;
    lastVelocity = null;
    setMinimumZoom(MIN_ZOOM);
    setFitPath(true);
    resetScene();
    syncObjectDefaults();
    closeReset();
  });

  launchAnotherBtn.addEventListener("click", () => {
    audio.playUiClick();
    resetScene();
  });

  window.addEventListener("resize", () => {
    resize();
    render();
  });
}

hudOrbitCount.textContent = String(getOrbitCount());
gravityValue.textContent = String(gm);
customElements.whenDefined("wa-number-input").then(() => {
  if (phase === "idle") updatePrediction();
});
customElements.whenDefined("wa-option").then(syncPlayback);
resize();
wireControls();
updateMuteButton();
resetScene();
requestAnimationFrame(frame);

