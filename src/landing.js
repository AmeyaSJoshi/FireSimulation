// AETHON landing page — standalone, not wired to the simulation app.
// Full-bleed graded photo background, a scroll-scrubbed (not real-scroll)
// intro transition, and a particle dissolve of the wordmark driven by that
// same scroll progress. See LANDING-SPEC.md for the design contract.

const bgPhotoEl = document.getElementById('bg-photo');
const bgGlowEl = document.getElementById('bg-glow');
const wordmarkWrapEl = document.getElementById('wordmark-wrap');
const wordmarkEl = document.getElementById('wordmark');
const canvas = document.getElementById('wordmark-canvas');
const ctx = canvas.getContext('2d', { alpha: true });

const WORD = 'AETHON';

function reducedMotionActive() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ---------- Color ramp: --bone -> --sodium -> --sodium-hot ----------

const BONE = [232, 227, 217];
const SODIUM = [240, 166, 60];
const SODIUM_HOT = [255, 208, 138];

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function mixColor(t) {
  const clamped = Math.max(0, Math.min(1, t));
  if (clamped <= 0.5) {
    const u = clamped / 0.5;
    return [
      lerp(BONE[0], SODIUM[0], u),
      lerp(BONE[1], SODIUM[1], u),
      lerp(BONE[2], SODIUM[2], u),
    ];
  }
  const u = (clamped - 0.5) / 0.5;
  return [
    lerp(SODIUM[0], SODIUM_HOT[0], u),
    lerp(SODIUM[1], SODIUM_HOT[1], u),
    lerp(SODIUM[2], SODIUM_HOT[2], u),
  ];
}

// ---------- Particle: steering (arrive) behavior ----------

const MAX_PARTICLES = 3200;
const STRIDE_CSS_PX = 3; // sampling stride in CSS pixels, independent of DPR

class Particle {
  constructor(restX, restY, scatterX, scatterY) {
    this.restX = restX;
    this.restY = restY;
    this.scatterX = scatterX;
    this.scatterY = scatterY;
    this.x = restX;
    this.y = restY;
    this.vx = 0;
    this.vy = 0;
    this.tx = restX;
    this.ty = restY;
    this.maxSpeed = 4 + Math.random() * 6; // 4-10
    this.maxForce = this.maxSpeed * 0.05;
    this.colorRate = 0.75 + Math.random() * 0.6; // color blend rate variance
    this.closeEnough = 14 + Math.random() * 10;
    this.size = 1.8 + Math.random() * 1.4;
  }

  updateTarget(progress) {
    this.tx = this.restX + this.scatterX * progress;
    this.ty = this.restY + this.scatterY * progress;
  }

  step() {
    let dx = this.tx - this.x;
    let dy = this.ty - this.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.0001) {
      this.vx = 0;
      this.vy = 0;
      return 0;
    }
    dx /= dist;
    dy /= dist;
    let desiredX = dx * this.maxSpeed;
    let desiredY = dy * this.maxSpeed;
    if (dist < this.closeEnough) {
      const scale = dist / this.closeEnough;
      desiredX *= scale;
      desiredY *= scale;
    }
    let steerX = desiredX - this.vx;
    let steerY = desiredY - this.vy;
    const steerMag = Math.hypot(steerX, steerY);
    if (steerMag > this.maxForce) {
      steerX = (steerX / steerMag) * this.maxForce;
      steerY = (steerY / steerMag) * this.maxForce;
    }
    this.vx += steerX;
    this.vy += steerY;
    this.x += this.vx;
    this.y += this.vy;
    return dist;
  }
}

let particles = [];
let particlesDpr = 1;
let particlesReady = false;
let particlesSettled = true;
let lastParticleProgress = -1;

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = array[i];
    array[i] = array[j];
    array[j] = tmp;
  }
}

function sampleWordmarkPixels(cssWidth, cssHeight, dpr) {
  const deviceWidth = Math.max(1, Math.round(cssWidth * dpr));
  const deviceHeight = Math.max(1, Math.round(cssHeight * dpr));

  const sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = deviceWidth;
  sampleCanvas.height = deviceHeight;
  const sctx = sampleCanvas.getContext('2d');
  const style = getComputedStyle(wordmarkEl);
  sctx.scale(dpr, dpr);
  sctx.font = `${style.fontWeight} ${parseFloat(style.fontSize)}px ${style.fontFamily}`;
  sctx.textAlign = 'center';
  sctx.textBaseline = 'middle';
  sctx.fillStyle = '#fff';
  sctx.fillText(WORD, cssWidth / 2, cssHeight / 2);

  const { data } = sctx.getImageData(0, 0, deviceWidth, deviceHeight);

  let strideDevice = Math.max(2, Math.round(STRIDE_CSS_PX * dpr));
  let coords = [];

  const collect = (stride) => {
    const out = [];
    for (let y = 0; y < deviceHeight; y += stride) {
      for (let x = 0; x < deviceWidth; x += stride) {
        const alphaIdx = (y * deviceWidth + x) * 4 + 3;
        if (data[alphaIdx] > 10) out.push([x, y]);
      }
    }
    return out;
  };

  coords = collect(strideDevice);
  while (coords.length > MAX_PARTICLES) {
    strideDevice = Math.ceil(strideDevice * Math.sqrt(coords.length / MAX_PARTICLES));
    coords = collect(strideDevice);
  }

  shuffle(coords);
  return { coords, deviceWidth, deviceHeight };
}

function buildWordmarkParticles() {
  const rect = wordmarkEl.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;

  const { coords, deviceWidth, deviceHeight } = sampleWordmarkPixels(rect.width, rect.height, dpr);
  canvas.width = deviceWidth;
  canvas.height = deviceHeight;
  particlesDpr = dpr;

  const scatterMin = 60 * dpr;
  const scatterMax = 260 * dpr;

  particles = coords.map(([x, y]) => {
    // Mostly-upward scatter (embers rising) with lateral spread.
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.5;
    const magnitude = scatterMin + Math.random() * (scatterMax - scatterMin);
    const scatterX = Math.cos(angle) * magnitude;
    const scatterY = Math.sin(angle) * magnitude;
    return new Particle(x, y, scatterX, scatterY);
  });

  particlesReady = particles.length > 0;
  particlesSettled = false;
  lastParticleProgress = -1;
}

function renderParticles(progress) {
  if (!particlesReady) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  let maxDist = 0;
  for (let i = 0; i < particles.length; i += 1) {
    const p = particles[i];
    p.updateTarget(progress);
    const dist = p.step();
    if (dist > maxDist) maxDist = dist;

    const colorT = Math.min(1, progress * p.colorRate);
    const [r, g, b] = mixColor(colorT);
    const alpha = Math.max(0, 1 - progress * 0.95);
    if (alpha <= 0.004) continue;
    const size = p.size * particlesDpr;
    ctx.fillStyle = `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${alpha.toFixed(3)})`;
    ctx.fillRect(p.x - size / 2, p.y - size / 2, size, size);
  }

  const progressStable = Math.abs(progress - lastParticleProgress) < 0.0005;
  lastParticleProgress = progress;
  particlesSettled = progressStable && maxDist < 0.05;
}

// ---------- Reduced-motion mode toggling ----------

let reducedMode = reducedMotionActive();

function applyReducedModeClass() {
  reducedMode = reducedMotionActive();
  if (reducedMode) {
    wordmarkWrapEl.classList.remove('particles-active');
    wordmarkEl.style.opacity = '';
  } else if (particlesReady) {
    wordmarkWrapEl.classList.add('particles-active');
  }
}

window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', applyReducedModeClass);

// ---------- Combined per-frame application ----------

function applyWordmark(progress) {
  if (reducedMode) {
    // No particles: plain crossfade of the real text, no motion simulation.
    wordmarkEl.style.opacity = String(1 - Math.min(progress / 0.4, 1));
    return;
  }
  renderParticles(progress);
  if (particlesReady) {
    wordmarkWrapEl.classList.add('particles-active');
  }
}

function applyBackground(progress) {
  // Slow push-in on the photo (replaces the old globe scale-up) plus the
  // fire glow warming as progress rises.
  const scale = 1 + progress * 0.14;
  bgPhotoEl.style.transform = `scale(${scale})`;
  bgGlowEl.style.opacity = String(0.18 + progress * 0.4);
}

// ---------- Scroll-scrub input (not real page scroll) ----------

let rawProgress = 0;
let displayProgress = 0;
let touchStartY = null;

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

window.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    rawProgress = clamp01(rawProgress + event.deltaY * 0.0009);
    ensureLoopRunning();
  },
  { passive: false }
);

window.addEventListener(
  'touchstart',
  (event) => {
    touchStartY = event.touches[0].clientY;
  },
  { passive: false }
);

window.addEventListener(
  'touchmove',
  (event) => {
    event.preventDefault();
    if (touchStartY === null) return;
    const currentY = event.touches[0].clientY;
    const deltaY = touchStartY - currentY; // positive: finger moving up (forward)
    const factor = deltaY >= 0 ? 0.005 : 0.008;
    rawProgress = clamp01(rawProgress + deltaY * factor);
    touchStartY = currentY;
    ensureLoopRunning();
  },
  { passive: false }
);

window.addEventListener(
  'touchend',
  (event) => {
    event.preventDefault();
    touchStartY = null;
  },
  { passive: false }
);

// The shared landing page is the public route for the Cesium/Jac app.
function onTransitionComplete() {
  // A one-time launch marker lets app.html distinguish an intentional entry
  // from a reload/direct visit. The app consumes it immediately, so reloads
  // always return to this landing page.
  window.location.assign('/app.html?launch=1');
}

let transitionFired = false;
let lastTime = performance.now();
let loopRunning = false;
let resizeTimer = null;

function ensureLoopRunning() {
  if (loopRunning) return;
  loopRunning = true;
  lastTime = performance.now();
  requestAnimationFrame(tick);
}

function tick(now) {
  const dt = Math.min(now - lastTime, 48);
  lastTime = now;
  const reduced = reducedMotionActive();

  if (reduced) {
    displayProgress = rawProgress;
  } else {
    const smoothing = 1 - Math.pow(0.001, dt / 1000);
    displayProgress += (rawProgress - displayProgress) * smoothing;
    if (Math.abs(rawProgress - displayProgress) < 0.0005) {
      displayProgress = rawProgress;
    }
  }

  applyWordmark(displayProgress);
  applyBackground(displayProgress);

  if (rawProgress >= 1 && !transitionFired) {
    transitionFired = true;
    onTransitionComplete();
  } else if (rawProgress < 0.999) {
    transitionFired = false;
  }

  const settled =
    Math.abs(rawProgress - displayProgress) < 0.0005 &&
    (reduced || particlesSettled);

  if (document.hidden) {
    loopRunning = false;
    return;
  }
  if (settled) {
    loopRunning = false;
    return;
  }
  requestAnimationFrame(tick);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) ensureLoopRunning();
});

window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    buildWordmarkParticles();
    applyReducedModeClass();
    ensureLoopRunning();
  }, 150);
});

function init() {
  applyReducedModeClass();
  if (!reducedMode) {
    buildWordmarkParticles();
    applyReducedModeClass();
  }
  ensureLoopRunning();
}

if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(init).catch(init);
} else {
  init();
}
