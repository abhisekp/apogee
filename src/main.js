import { stepSimulation, classifyOutcome, orbitalElements, circularOrbitVelocity, escapeVelocity } from "./physics.js";
import { bodies, transferDefaults, TRANSFER_STEP, moonPosition, stepTransfer, transferOutcome, projectTransfer } from "./bodies.js";
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
  if (satellite) {
    x = Math.max(x, Math.abs(satellite.x));
    y = Math.max(y, Math.abs(satellite.y));
  }
  return Math.min(2.5 * baselineScale(), width * 0.44 / x, height * 0.44 / y);
}

function setPhase(next) {
  phase = next;
  const inRun = phase === "flying" || phase === "resolved";
  gravitySlider.disabled = inRun || profileId !== "sandbox";
  for (const id of ["body-radius", "body-gm", "launch-altitude", "moon-radius", "moon-gm", "moon-distance", "moon-phase"]) controls[id].disabled = inRun;
  controls["pause-flight"].disabled = phase !== "flying";
  controls["step-flight"].disabled = phase !== "flying" || !paused;
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
  const glow = ctx.createRadialGradient(cx, cy, body.radius * 0.4, cx, cy, body.radius * 2.2);
  const rimColor = outcome === "crash" ? "255, 82, 82" : "77, 216, 232";
  glow.addColorStop(0, `rgba(${rimColor}, 0.35)`);
  glow.addColorStop(1, `rgba(${rimColor}, 0)`);
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, body.radius * 2.2, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#0f1f38";
  ctx.strokeStyle = outcome === "crash" ? "#ff5252" : "#4dd8e8";
  ctx.lineWidth = 2 / scale;
  ctx.beginPath();
  ctx.arc(cx, cy, body.radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
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
  ctx.fillStyle = color;
  ctx.font = `${11 / scale}px monospace`;
  ctx.beginPath();
  ctx.arc(point.x, point.y, 3 / scale, 0, 2 * Math.PI);
  ctx.fill();
  ctx.fillText(label, point.x + 7 / scale, point.y + offset / scale);
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

function drawSatellite(cx, cy, scale) {
  if (!satellite) return;
  ctx.fillStyle = "#ff6b4a";
  ctx.beginPath();
  ctx.arc(cx + satellite.x, cy + satellite.y, 6 / scale, 0, Math.PI * 2);
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
  drawGrid(width, height);
  const scale = viewScale(width, height);
  const readout = `${Math.round(scale / baselineScale() * 100)}%`;
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
  if (!reducedMotion && particles.length) {
    particles = updateParticles(particles, dt);
  }

  render();
  requestAnimationFrame(frame);
}

function updateMuteButton() {
  const muted = audio.isMuted();
  muteButton.textContent = muted ? "Unmute sound" : "Mute sound";
}

function manualZoom(scale) {
  setFitPath(false);
  zoom = scale;
  zoomSlider.value = Math.round(scale / baselineScale() * 100);
}

function startGesture(event) {
  if (event.button !== 0 || pointerGesture) return;
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
  const next = Math.max(Math.min(MIN_ZOOM * baselineScale(), scale), Math.min(MAX_ZOOM * baselineScale(), scale * Math.exp(-delta * 0.002)));
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
  profileId = id;
  body = isTransfer() ? transfer.earth : override ? { ...bodies[id] } : profiles[id];
  if (override?.altitude !== undefined) body.altitude = override.altitude;
  if (override?.gm !== undefined) body.gm = override.gm;
  gm = body.gm;
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
  syncPlayback();
  playback.value = isTransfer() ? "24000" : id === "sandbox" ? "3" : "2400";
  controls["body-note"].textContent = isTransfer()
    ? "Idealized 8-day flyby with a moving Moon. The main fields edit Earth, and the Moon has separate controls."
    : "Radius and GM are editable for each profile. Artificial bodies are modeled as isolated spheres.";
  lastVelocity = null;
  zoom = baselineScale();
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

function wireControls() {
  presetSelect.addEventListener("change", applyPreset);
  controls["body-profile"].addEventListener("change", () => {
    clearPreset();
    loadProfile(controls["body-profile"].value);
  });
  for (const id of ["body-radius", "body-gm", "launch-altitude", "moon-radius", "moon-gm", "moon-distance", "moon-phase"]) controls[id].addEventListener("change", editBody);
  controls["pause-flight"].addEventListener("click", () => {
    if (phase !== "flying") return;
    paused = !paused;
    controls["pause-flight"].textContent = paused ? "Resume" : "Pause";
    setPhase(phase);
  });
  controls["step-flight"].addEventListener("click", () => {
    if (phase === "flying" && paused) stepPhysics(physicsStep());
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
    audio.playUiClick();
    resetScene();
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
