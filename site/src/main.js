import { DEFAULT_GM, stepSimulation, classifyOutcome, orbitalElements } from "./physics.js";
import { aimedVelocity, projectTrajectory, SIM_DT } from "./projection.js";
import { dragDistance, clampToMaxDistance, launchVelocity } from "./input.js";
import { buildHudReadout } from "./hud.js";
import { createDebrisBurst, updateParticles, particleOpacity } from "./particles.js";
import { createAudioEngine } from "./audio.js";
import { getOrbitCount, incrementOrbitCount } from "./stats.js";

const PLANET_RADIUS = 40;
// The satellite launches from a small standoff above the surface, not the
// surface itself: a tangential orbit starting exactly at PLANET_RADIUS has
// periapsis <= PLANET_RADIUS by construction (see classifyOutcome), which
// makes a genuine "orbit" classification unreachable. The standoff gives a
// real periapsis clearance margin.
const LAUNCH_RADIUS = 60;
const ESCAPE_RADIUS = 500;
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

let gm = DEFAULT_GM;
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
  return { x: LAUNCH_RADIUS, y: 0 };
}

function restingSatellite() {
  return { x: LAUNCH_RADIUS, y: 0, vx: 0, vy: 0 };
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
  projection = velocity
    ? projectTrajectory({ ...anchorPoint(), ...velocity }, gm, PLANET_RADIUS, ESCAPE_RADIUS)
    : null;
  const labels = {
    crash: "Predicted impact",
    orbit: "Predicted orbit",
    escape: "Predicted escape",
    partial: "Preview limited to 120 simulated seconds",
  };
  predictionStatus.textContent = projection ? labels[projection.outcome] : "";
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
  let x = PLANET_RADIUS;
  let y = PLANET_RADIUS;
  for (const points of [projection?.points ?? [], trace]) {
    for (const point of points) {
      x = Math.max(x, Math.abs(point.x));
      y = Math.max(y, Math.abs(point.y));
    }
  }
  if (satellite) {
    x = Math.max(x, Math.abs(satellite.x));
    y = Math.max(y, Math.abs(satellite.y));
  }
  return Math.min(2.5, width * 0.44 / x, height * 0.44 / y);
}

function setPhase(next) {
  phase = next;
  const inRun = phase === "flying" || phase === "resolved";
  gravitySlider.disabled = inRun;
  aimSpeed.disabled = aimAngle.disabled = launchButton.disabled = inRun;
}

function resetScene() {
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
  const anchor = anchorPoint();
  dragPointer = clampToMaxDistance(anchor, {
    x: anchor.x + clientX - dragOrigin.x,
    y: anchor.y + clientY - dragOrigin.y,
  }, MAX_DRAG_DISTANCE);
  const velocity = launchVelocity(anchor, dragPointer, DRAG_SENSITIVITY);
  aimSpeed.value = Number(Math.min(19.8, Math.hypot(velocity.vx, velocity.vy)).toFixed(2));
  aimAngle.value = Number((Math.atan2(-velocity.vy, velocity.vx) * 180 / Math.PI).toFixed(1));
  updatePrediction(velocity);

  const now = performance.now();
  if (now - lastDragSoundTime > DRAG_SOUND_THROTTLE_MS) {
    const ratio = dragDistance(anchorPoint(), dragPointer) / MAX_DRAG_DISTANCE;
    audio.playDragCharge(ratio);
    lastDragSoundTime = now;
  }
}

function endDrag() {
  if (phase !== "dragging") return;
  launchSatellite(launchVelocity(anchorPoint(), dragPointer, DRAG_SENSITIVITY));
}

function launchSatellite(velocity) {
  updatePrediction(velocity);
  satellite = { ...anchorPoint(), ...velocity };
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
    if (!reducedMotion) particles = createDebrisBurst(satellite.x, satellite.y);
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

  showOverlay(kind);
}

function showOverlay(kind) {
  outcomeTitle.textContent = kind === "crash" ? "CRASH" : kind === "orbit" ? "ORBIT LOCKED" : "ESCAPED";
  outcomeTitle.dataset.outcome = kind;

  const stats = [["launch velocity", `${launchSpeed.toFixed(2)} u/s`]];
  if (kind === "orbit" && satellite) {
    const elements = orbitalElements(satellite, gm);
    if (elements) {
      stats.push(["apoapsis", `${elements.apoapsis.toFixed(1)} u`]);
      stats.push(["periapsis", `${elements.periapsis.toFixed(1)} u`]);
      stats.push(["period", `${elements.period.toFixed(2)} s`]);
    }
  } else if (satellite) {
    const altitude = Math.hypot(satellite.x, satellite.y) - PLANET_RADIUS;
    stats.push(["altitude", `${altitude.toFixed(1)} u`]);
  }

  outcomeStats.innerHTML = stats.map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`).join("");
  overlay.hidden = false;
}

function stepPhysics(dt) {
  physicsTime += dt;
  while (physicsTime >= SIM_DT && phase === "flying") {
    satellite = stepSimulation(satellite, SIM_DT, gm);
    physicsTime -= SIM_DT;
    if (++traceStep % 8 === 0) pushTracePoint(satellite.x, satellite.y);

    const classification = classifyOutcome(satellite, PLANET_RADIUS, ESCAPE_RADIUS, gm);
    if (classification === "crash" || classification === "escape") {
      resolveOutcome(classification);
      return;
    }

    if (classification === "orbit") {
      orbitHoldTime += SIM_DT;
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
  const readout = buildHudReadout(satellite, gm, PLANET_RADIUS);
  hudFields.velocity.textContent = readout.velocity;
  hudFields.altitude.textContent = readout.altitude;
  hudFields.apoapsis.textContent = readout.apoapsis;
  hudFields.periapsis.textContent = readout.periapsis;
  hudFields.period.textContent = readout.period;
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

function drawLaunchPad(cx, cy) {
  if (phase !== "idle" && phase !== "dragging") return;
  ctx.save();
  ctx.strokeStyle = "rgba(77, 216, 232, 0.4)";
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 5]);
  ctx.beginPath();
  ctx.arc(cx, cy, LAUNCH_RADIUS, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawPlanet(cx, cy) {
  const glow = ctx.createRadialGradient(cx, cy, PLANET_RADIUS * 0.4, cx, cy, PLANET_RADIUS * 2.2);
  const rimColor = outcome === "crash" ? "255, 82, 82" : "77, 216, 232";
  glow.addColorStop(0, `rgba(${rimColor}, 0.35)`);
  glow.addColorStop(1, `rgba(${rimColor}, 0)`);
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, PLANET_RADIUS * 2.2, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#0f1f38";
  ctx.strokeStyle = outcome === "crash" ? "#ff5252" : "#4dd8e8";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, PLANET_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

function drawTrace(cx, cy) {
  if (trace.length < 2) return;
  ctx.save();
  ctx.strokeStyle = outcome === "orbit" ? "rgba(94, 235, 176, 0.8)" : "rgba(255, 107, 74, 0.7)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
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

function drawPrediction(cx, cy, scale) {
  if (!projection) return;
  ctx.save();
  ctx.strokeStyle = "rgba(77, 216, 232, 0.8)";
  ctx.lineWidth = 2 / scale;
  ctx.setLineDash([5 / scale, 5 / scale]);
  ctx.beginPath();
  projection.points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(cx + point.x, cy + point.y);
    else ctx.lineTo(cx + point.x, cy + point.y);
  });
  ctx.stroke();
  ctx.restore();
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

function drawDragIndicator(cx, cy) {
  if (phase !== "dragging" || !dragPointer) return;
  const anchor = anchorPoint();
  ctx.save();
  ctx.strokeStyle = "#4dd8e8";
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(cx + anchor.x, cy + anchor.y);
  ctx.lineTo(cx + dragPointer.x, cy + dragPointer.y);
  ctx.stroke();

  ctx.setLineDash([]);
  ctx.fillStyle = "#ff6b4a";
  ctx.beginPath();
  ctx.arc(cx + dragPointer.x, cy + dragPointer.y, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function render() {
  const { cx, cy, width, height } = center();
  ctx.clearRect(0, 0, width, height);
  drawGrid(width, height);
  const scale = viewScale(width, height);
  const readout = `${Math.round(scale * 100)}%`;
  if (zoomValue.textContent !== readout) zoomValue.textContent = readout;
  ctx.save();
  ctx.translate(cx + cameraX, cy + cameraY);
  ctx.scale(scale, scale);
  drawTrace(0, 0);
  drawPlanet(0, 0);
  drawLaunchPad(0, 0);
  drawPrediction(0, 0, scale);
  drawParticles(0, 0);
  drawDragIndicator(0, 0);
  drawSatellite(0, 0, scale);
  ctx.restore();
  updateHud();
}

function frame(timestamp) {
  if (lastFrameTime === null) lastFrameTime = timestamp;
  const rawDt = Math.min(MAX_FRAME_DT, (timestamp - lastFrameTime) / 1000);
  lastFrameTime = timestamp;
  const dt = rawDt * (Number(playback.value) || 3);

  if (phase === "flying") {
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
  zoomSlider.value = Math.round(scale * 100);
}

function startGesture(event) {
  if (event.button !== 0 || pointerGesture) return;
  const rect = canvas.getBoundingClientRect();
  const scale = viewScale(rect.width, rect.height);
  const x = event.clientX - rect.left - rect.width / 2;
  const y = event.clientY - rect.top - rect.height / 2;
  const hitRadius = event.pointerType === "touch" ? 28 : 20;
  const aiming = phase === "idle" &&
    Math.hypot(x - cameraX - LAUNCH_RADIUS * scale, y - cameraY) <= hitRadius;
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
  const next = Math.max(Math.min(MIN_ZOOM, scale), Math.min(MAX_ZOOM, scale * Math.exp(-delta * 0.002)));
  const ratio = next / scale;
  const x = event.clientX - rect.left - rect.width / 2;
  const y = event.clientY - rect.top - rect.height / 2;
  cameraX = x - (x - cameraX) * ratio;
  cameraY = y - (y - cameraY) * ratio;
  manualZoom(next);
}

function wireControls() {
  canvas.addEventListener("pointerdown", startGesture);
  canvas.addEventListener("pointermove", moveGesture);
  canvas.addEventListener("pointerup", finishGesture);
  canvas.addEventListener("pointercancel", finishGesture);
  canvas.addEventListener("lostpointercapture", finishGesture);
  canvasWrap.addEventListener("wheel", wheelZoom, { passive: false });

  aimForm.addEventListener("input", () => {
    if (phase === "idle") updatePrediction();
  });
  aimForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const velocity = currentAim();
    if (phase === "idle" && velocity) launchSatellite(velocity);
  });
  zoomSlider.addEventListener("input", () => {
    zoom = Number(zoomSlider.value) / 100;
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
    gm = Number(gravitySlider.value);
    gravityValue.textContent = gravitySlider.value;
    if (phase === "idle") updatePrediction();
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
resize();
wireControls();
updateMuteButton();
resetScene();
requestAnimationFrame(frame);
