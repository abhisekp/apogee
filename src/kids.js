import { stepSimulation, classifyOutcome } from "./physics.js";

const TOYS = {
  satellite: { icon: "🛰️", color: "#a8e9ff", speed: 8.16, angle: 90 },
  rocket: { icon: "🚀", color: "#ffc486", speed: 14, angle: 55 },
  rock: { icon: "🪨", color: "#ff9eaf", speed: 3, angle: 160 },
  ball: { icon: "⚽", color: "#dbb9ff", speed: 9.2, angle: -90 },
};
const PLANET = 40;
const LAUNCH = 60;
const GM = 4000;
const DT = 1 / 120;

export function wireKidsMode() {
  const panel = document.getElementById("kids-space");
  const advanced = document.getElementById("advanced-space");
  const toggle = document.getElementById("kids-toggle");
  const canvas = document.getElementById("kids-canvas");
  const feedback = document.getElementById("kids-feedback");
  const ctx = canvas.getContext("2d");
  const toys = [];
  let drag = null;
  let ghost = null;
  let frameId = 0;
  let lastTime = null;
  let remaining = 0;
  let suppressClick = false;

  function launch(key, azimuth = 0) {
    const toy = TOYS[key];
    const angle = azimuth + toy.angle * Math.PI / 180;
    if (toys.length === 8) toys.shift();
    toys.push({
      ...toy, x: LAUNCH * Math.cos(azimuth), y: LAUNCH * Math.sin(azimuth),
      vx: toy.speed * Math.cos(angle), vy: toy.speed * Math.sin(angle), trail: [], age: 0,
    });
    feedback.textContent = toy.icon + " ✨";
  }

  function update() {
    for (const toy of toys) {
      if (toy.done) continue;
      Object.assign(toy, stepSimulation(toy, DT, GM));
      toy.age += 1;
      if (toy.age % 7 === 0) {
        toy.trail.push({ x: toy.x, y: toy.y });
        if (toy.trail.length > 180) toy.trail.shift();
      }
      const result = classifyOutcome(toy, PLANET, 145, GM);
      if (result === "orbit" && toy.age > 190 && !toy.announced) {
        toy.announced = true;
        feedback.textContent = "🌀 Orbit!";
      } else if (result === "escape" || result === "crash") {
        toy.done = true;
        feedback.textContent = result === "crash" ? "💥 Bump!" : "⭐ Off into space!";
      }
    }
  }

  function draw() {
    const { width, height } = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(width * dpr), h = Math.round(height * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const cx = width / 2, cy = height / 2;
    const scale = Math.min(width, height) / 332;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    for (let i = 0; i < 70; i++) {
      ctx.fillStyle = i % 5 ? "#625d9a" : "#dcd5ff";
      ctx.fillRect((i * 997 % 1021) / 1021 * width, (i * 593 % 1021) / 1021 * height, i % 5 ? 1 : 2, i % 5 ? 1 : 2);
    }
    ctx.strokeStyle = "#504486";
    ctx.setLineDash([4, 8]);
    ctx.beginPath();
    ctx.arc(cx, cy, LAUNCH * scale, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `${PLANET * scale * 2}px "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;
    ctx.fillText("🌍", cx, cy);
    for (const toy of toys) {
      if (toy.trail.length) {
        ctx.strokeStyle = toy.color;
        ctx.globalAlpha = 0.7;
        ctx.lineWidth = 2;
        ctx.beginPath();
        toy.trail.forEach((p, i) => {
          const x = cx + p.x * scale, y = cy - p.y * scale;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      if (!toy.done) {
        ctx.font = '24px "Segoe UI Emoji", "Apple Color Emoji", sans-serif';
        ctx.fillText(toy.icon, cx + toy.x * scale, cy - toy.y * scale);
      }
    }
  }

  function frame(now) {
    if (panel.hidden) return;
    if (lastTime !== null) remaining += Math.min(0.05, (now - lastTime) / 1000) * 12;
    lastTime = now;
    while (remaining >= DT) {
      update();
      remaining -= DT;
    }
    draw();
    frameId = requestAnimationFrame(frame);
  }

  function setMode(isKids) {
    panel.hidden = !isKids;
    advanced.hidden = isKids;
    document.body.toggleAttribute("data-kids", isKids);
    toggle.textContent = isKids ? "🧪 Orbit Lab" : "🧒 Kids Mode";
    cancelAnimationFrame(frameId);
    lastTime = null;
    remaining = 0;
    if (isKids) frameId = requestAnimationFrame(frame);
    else window.dispatchEvent(new Event("resize"));
    const url = new URL(location.href);
    if (isKids) url.searchParams.set("mode", "kids");
    else url.searchParams.delete("mode");
    history.replaceState(null, "", url);
  }

  function removeGhost() {
    ghost?.remove();
    ghost = null;
    drag = null;
  }

  toggle.addEventListener("click", () => setMode(panel.hidden));
  document.getElementById("kids-clear").addEventListener("click", () => {
    toys.length = 0;
    feedback.textContent = "✨";
  });
  for (const button of panel.querySelectorAll("[data-toy]")) {
    button.addEventListener("click", event => {
      if (suppressClick && event.detail > 0) return;
      launch(button.dataset.toy);
    });
    button.addEventListener("pointerdown", event => {
      if (event.button !== 0 || !event.isPrimary) return;
      suppressClick = false;
      drag = { key: button.dataset.toy, id: event.pointerId, x: event.clientX, y: event.clientY };
      button.setPointerCapture(event.pointerId);
    });
    button.addEventListener("pointermove", event => {
      if (drag?.id !== event.pointerId) return;
      if (!ghost && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 8) {
        ghost = document.createElement("span");
        ghost.className = "kids-ghost";
        ghost.setAttribute("aria-hidden", "true");
        ghost.textContent = TOYS[drag.key].icon;
        document.body.append(ghost);
      }
      if (ghost) {
        ghost.style.left = `${event.clientX}px`;
        ghost.style.top = `${event.clientY}px`;
      }
    });
    button.addEventListener("pointerup", event => {
      if (drag?.id !== event.pointerId) return;
      const { left, right, top, bottom, width, height } = canvas.getBoundingClientRect();
      if (ghost) {
        suppressClick = true;
        if (event.clientX >= left && event.clientX <= right && event.clientY >= top && event.clientY <= bottom) {
          launch(drag.key, Math.atan2(top + height / 2 - event.clientY, event.clientX - left - width / 2));
        }
      }
      removeGhost();
    });
    button.addEventListener("pointercancel", removeGhost);
    button.addEventListener("lostpointercapture", removeGhost);
  }
  if (new URLSearchParams(location.search).get("mode") === "kids") setMode(true);
}
