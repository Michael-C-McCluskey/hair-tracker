/**
 * Hands-free video sweep: voice-guided head turns, on-device pose scoring,
 * best-frame selection per angle. Nothing is uploaded.
 */
import { ANGLES, compressImage } from "./db.js";

const WASM_DIR = new URL("../vendor/mediapipe/wasm/", import.meta.url).href;
const MODEL_URL = new URL("../vendor/mediapipe/face_landmarker.task", import.meta.url).href;
const BUNDLE_URL = new URL("../vendor/mediapipe/vision_bundle.mjs", import.meta.url).href;

/** Target yaw: + = subject's left side toward the camera (they turned right). */
export const SEGMENTS = [
  {
    angleId: "front",
    title: "Front / hairline",
    intro: "Face the camera. Sit still.",
    hold: "Hold still.",
    keepGoing: null,
    moveMs: 2500,
    holdMs: 2500,
    requireFace: true,
    noFace: false,
    targetYaw: 0,
    targetPitch: 0,
    yawTol: 16,
    pitchTol: 16,
  },
  {
    angleId: "left-temple",
    title: "Left temple",
    intro: "Slowly turn your head to the right, until your left temple faces the camera.",
    keepGoing: "Keep going, slowly.",
    hold: "Hold.",
    moveMs: 4000,
    holdMs: 2000,
    requireFace: true,
    noFace: false,
    targetYaw: 45,
    targetPitch: 0,
    yawTol: 14,
    pitchTol: 18,
  },
  {
    angleId: "right-temple",
    title: "Right temple",
    intro: "Back to center. Now slowly turn your head to the left, until your right temple faces the camera.",
    keepGoing: "Keep going, slowly.",
    hold: "Hold.",
    moveMs: 4500,
    holdMs: 2000,
    requireFace: true,
    noFace: false,
    targetYaw: -45,
    targetPitch: 0,
    yawTol: 14,
    pitchTol: 18,
  },
  {
    angleId: "top",
    title: "Top",
    intro: "Back to center. Now tilt your head down toward the camera, to show the top of your head.",
    keepGoing: "A little more.",
    hold: "Hold.",
    moveMs: 3500,
    holdMs: 2000,
    requireFace: false,
    noFace: false,
    targetYaw: 0,
    targetPitch: 35,
    yawTol: 25,
    pitchTol: 18,
    // Face may only be partially visible; pose helps when it works.
    allowNoFace: true,
  },
  {
    angleId: "back",
    title: "Back",
    intro: "Turn your back to the camera. Stand still so I can see the back of your head.",
    keepGoing: null,
    hold: "Hold still.",
    moveMs: 4000,
    holdMs: 2000,
    requireFace: false,
    noFace: true,
    targetYaw: null,
    targetPitch: null,
    yawTol: 0,
    pitchTol: 0,
  },
  {
    angleId: "crown",
    title: "Crown",
    intro: "Keeping your back to the camera, tilt your head forward, to show the crown.",
    keepGoing: "Tilt a little more.",
    hold: "Hold.",
    moveMs: 3500,
    holdMs: 2000,
    requireFace: false,
    noFace: true,
    targetYaw: null,
    targetPitch: null,
    yawTol: 0,
    pitchTol: 0,
  },
];

export const sweep = {
  running: false,
  aborted: false,
  testMode: false,
  facing: "environment",
  mediaPipe: "pending", // "ready" | "fallback" | "pending"
  landmarker: null,
  stream: null,
  audioCtx: null,
  timer: null,
  segmentIndex: -1,
  segmentStartedAt: 0,
  candidates: {}, // angleId -> [{score, blob, width, height, yaw, pitch, sharpness, hasFace}]
  chosen: {}, // angleId -> index
  status: "",
};

function $(sel, root = document) {
  return root.querySelector(sel);
}

function now() {
  return performance.now();
}

/* ---------- audio / voice ---------- */

function unlockAudio() {
  try {
    if (!sweep.audioCtx) sweep.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (sweep.audioCtx.state === "suspended") sweep.audioCtx.resume();
  } catch {
    /* no Web Audio */
  }
}

export function beep(kind = "tick") {
  const ctx = sweep.audioCtx;
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  const t = ctx.currentTime;
  if (kind === "tick") {
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    osc.start(t);
    osc.stop(t + 0.1);
  } else if (kind === "good") {
    osc.frequency.value = 1174;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    osc.start(t);
    osc.stop(t + 0.2);
    const osc2 = ctx.createOscillator();
    const g2 = ctx.createGain();
    osc2.connect(g2);
    g2.connect(ctx.destination);
    osc2.frequency.value = 1568;
    g2.gain.setValueAtTime(0.0001, t + 0.12);
    g2.gain.exponentialRampToValueAtTime(0.14, t + 0.14);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    osc2.start(t + 0.12);
    osc2.stop(t + 0.34);
  } else if (kind === "done") {
    osc.frequency.value = 784;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    osc.start(t);
    osc.stop(t + 0.5);
  }
}

export function speak(text) {
  return new Promise((resolve) => {
    if (sweep.testMode || !text || !window.speechSynthesis) {
      resolve();
      return;
    }
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.02;
      u.pitch = 1;
      u.lang = "en-US";
      u.onend = () => resolve();
      u.onerror = () => resolve();
      speechSynthesis.speak(u);
      // Android can silently drop utterances; don't hang the sweep.
      setTimeout(resolve, Math.min(12000, 800 + text.length * 80));
    } catch {
      resolve();
    }
  });
}

export function silence() {
  try {
    speechSynthesis?.cancel();
  } catch {
    /* ignore */
  }
}

/* ---------- MediaPipe ---------- */

async function loadLandmarker() {
  if (sweep.landmarker) {
    sweep.mediaPipe = "ready";
    return sweep.landmarker;
  }
  try {
    const { FaceLandmarker, FilesetResolver } = await import(BUNDLE_URL);
    const fileset = await FilesetResolver.forVisionTasks(WASM_DIR.replace(/\/$/, ""));
    let landmarker;
    try {
      landmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
        runningMode: "VIDEO",
        numFaces: 1,
        outputFacialTransformationMatrixes: true,
        outputFaceBlendshapes: false,
      });
    } catch {
      landmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
        runningMode: "VIDEO",
        numFaces: 1,
        outputFacialTransformationMatrixes: true,
        outputFaceBlendshapes: false,
      });
    }
    sweep.landmarker = landmarker;
    sweep.mediaPipe = "ready";
    return landmarker;
  } catch (err) {
    console.warn("MediaPipe FaceLandmarker unavailable:", err);
    sweep.landmarker = null;
    sweep.mediaPipe = "fallback";
    return null;
  }
}

/* ---------- pose + scoring ---------- */

function poseFromLandmarks(landmarks) {
  if (!landmarks || landmarks.length < 264) return null;
  const nose = landmarks[1];
  const leftEye = landmarks[33]; // subject's left eye
  const rightEye = landmarks[263];
  const forehead = landmarks[10];
  const chin = landmarks[152];
  if (!nose || !leftEye || !rightEye) return null;
  const midX = (leftEye.x + rightEye.x) / 2;
  const midY = (leftEye.y + rightEye.y) / 2;
  const iod = Math.hypot(leftEye.x - rightEye.x, leftEye.y - rightEye.y);
  if (iod < 0.01) return null;
  // Positive yaw: nose shifts left in the unmirrored frame = subject turned right = left temple.
  const yaw = ((midX - nose.x) / iod) * 80;
  // Positive pitch: nose sits lower than usual = chin tucked / forehead toward a front camera = top of head.
  const noseDrop = (nose.y - midY) / iod;
  const pitch = (noseDrop - 0.95) * 70;
  const minX = Math.min(...landmarks.map((l) => l.x));
  const maxX = Math.max(...landmarks.map((l) => l.x));
  const minY = Math.min(forehead?.y ?? 0, ...landmarks.map((l) => l.y));
  const maxY = Math.max(chin?.y ?? 1, ...landmarks.map((l) => l.y));
  return {
    yaw,
    pitch,
    faceWidth: maxX - minX,
    faceHeight: maxY - minY,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
  };
}

function lumaStats(gray, n) {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += gray[i];
  return sum / n;
}

function laplacianVariance(gray, w, h) {
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const L = gray[i - w] + gray[i + w] + gray[i - 1] + gray[i + 1] - 4 * gray[i];
      sum += L;
      sum2 += L * L;
      n++;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

function downscaleGray(sourceCanvas, maxW = 160) {
  const scale = Math.min(1, maxW / sourceCanvas.width);
  const w = Math.max(16, Math.round(sourceCanvas.width * scale));
  const h = Math.max(16, Math.round(sourceCanvas.height * scale));
  const c = downscaleGray._c || (downscaleGray._c = document.createElement("canvas"));
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(sourceCanvas, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const gray = new Float32Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return { gray, w, h };
}

function sharpnessScore(variance) {
  // Laplacian variance is typically tens to thousands depending on scale.
  // Map a useful range to 0–1 without requiring a face.
  return Math.max(0, Math.min(1, (variance - 8) / 180));
}

function brightnessScore(mean) {
  if (mean < 25 || mean > 245) return 0;
  if (mean >= 60 && mean <= 190) return 1;
  if (mean < 60) return (mean - 25) / 35;
  return (245 - mean) / 55;
}

function poseScore(pose, seg) {
  if (seg.targetYaw == null) return 0;
  if (!pose) return 0;
  const yawErr = Math.abs(pose.yaw - seg.targetYaw) / (seg.yawTol || 16);
  const pitchErr = Math.abs(pose.pitch - (seg.targetPitch || 0)) / (seg.pitchTol || 16);
  const y = Math.max(0, 1 - yawErr);
  const p = Math.max(0, 1 - pitchErr);
  return y * 0.65 + p * 0.35;
}

function sizeCenterScore(pose) {
  if (!pose) return 0;
  const size = Math.max(0, Math.min(1, (pose.faceWidth - 0.18) / 0.42));
  const center = Math.max(0, 1 - Math.abs(pose.cx - 0.5) * 2.2);
  return size * 0.6 + center * 0.4;
}

function scoreFrame({ sharpness, brightness, pose, hasFace, seg }) {
  const sharp = sharpnessScore(sharpness);
  const bright = brightnessScore(brightness);
  if (seg.noFace) {
    const noFace = hasFace ? 0.15 : 1;
    return noFace * 0.5 + sharp * 0.3 + bright * 0.2;
  }
  const poseS = poseScore(pose, seg);
  const sizeS = sizeCenterScore(pose);
  if (seg.requireFace && !hasFace) return sharp * 0.15 + bright * 0.1;
  if (seg.allowNoFace && !hasFace) return sharp * 0.45 + bright * 0.25; // wait for pose if we can
  return poseS * 0.48 + sharp * 0.24 + bright * 0.13 + sizeS * 0.15;
}

function isGoodEnough(score, pose, hasFace, seg) {
  if (score < 0.55) return false;
  if (seg.noFace) return !hasFace && score >= 0.5;
  if (seg.requireFace && !hasFace) return false;
  if (pose && seg.targetYaw != null) {
    return (
      Math.abs(pose.yaw - seg.targetYaw) <= (seg.yawTol || 16) &&
      Math.abs(pose.pitch - (seg.targetPitch || 0)) <= (seg.pitchTol || 16)
    );
  }
  return score >= 0.62;
}

/* ---------- camera + sampling ---------- */

async function startSweepCamera(video) {
  await stopSweepCamera(video);
  const constraints = {
    audio: false,
    video: {
      facingMode: { ideal: sweep.facing },
      width: { ideal: 1920 },
      height: { ideal: 1440 },
    },
  };
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("no camera");
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  sweep.stream = stream;
  video.srcObject = stream;
  video.classList.toggle("is-front", sweep.facing === "user");
  video.hidden = false;
  try {
    await video.play();
  } catch {
    await new Promise((r) => setTimeout(r, 50));
    await video.play().catch(() => {});
  }
}

async function stopSweepCamera(video) {
  if (sweep.stream) {
    sweep.stream.getTracks().forEach((t) => t.stop());
    sweep.stream = null;
  }
  if (video) video.srcObject = null;
}

async function captureJpeg(video, quality = 0.9) {
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth || 1280;
  canvas.height = video.videoHeight || 720;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("frame encode failed"))), "image/jpeg", quality)
  );
  return { blob, width: canvas.width, height: canvas.height, canvas };
}

function keepCandidate(angleId, cand) {
  const list = sweep.candidates[angleId] || [];
  list.push(cand);
  list.sort((a, b) => b.score - a.score);
  while (list.length > 3) list.pop();
  sweep.candidates[angleId] = list;
  if (sweep.chosen[angleId] == null) sweep.chosen[angleId] = 0;
}

async function sampleFrame(video, seg) {
  if (!video?.srcObject || !video.videoWidth) return null;
  const { blob, width, height, canvas } = await captureJpeg(video);
  const { gray, w, h } = downscaleGray(canvas, 160);
  const sharpness = laplacianVariance(gray, w, h);
  const brightness = lumaStats(gray, w * h);
  let hasFace = false;
  let pose = null;
  if (sweep.landmarker) {
    try {
      const res = sweep.landmarker.detectForVideo(video, Math.round(now()));
      const marks = res?.faceLandmarks?.[0];
      if (marks && marks.length) {
        hasFace = true;
        pose = poseFromLandmarks(marks);
      }
    } catch {
      /* keep going */
    }
  }
  const score = scoreFrame({ sharpness, brightness, pose, hasFace, seg });
  const cand = {
    blob,
    width,
    height,
    score,
    sharpness,
    brightness,
    hasFace,
    yaw: pose?.yaw ?? null,
    pitch: pose?.pitch ?? null,
    at: Date.now(),
  };
  keepCandidate(seg.angleId, cand);
  return cand;
}

/* ---------- UI helpers ---------- */

function setStatus(title, detail) {
  sweep.status = detail || title;
  const t = $("#sweep-status");
  const d = $("#sweep-detail");
  const step = $("#sweep-step");
  if (t) t.textContent = title;
  if (d) d.textContent = detail || "";
  if (step && sweep.segmentIndex >= 0) {
    step.textContent = `${sweep.segmentIndex + 1} of ${SEGMENTS.length}`;
  }
  const pips = $("#sweep-pips");
  if (pips) {
    pips.innerHTML = SEGMENTS.map((s, i) => {
      const has = (sweep.candidates[s.angleId] || []).length > 0;
      const cls = i === sweep.segmentIndex ? "is-current" : has ? "is-done" : "";
      return `<span class="sweep-pip ${cls}" title="${s.title}"></span>`;
    }).join("");
  }
}

function segmentDurations(seg) {
  if (sweep.testMode) {
    return { moveMs: 180, holdMs: 180, keepAt: 80 };
  }
  return { moveMs: seg.moveMs, holdMs: seg.holdMs, keepAt: Math.min(2200, Math.round(seg.moveMs * 0.55)) };
}

async function countdown() {
  setStatus("Get ready", "Starting in a moment.");
  if (sweep.testMode) {
    beep("tick");
    return;
  }
  await speak("Get ready. Starting in three.");
  if (sweep.aborted) return;
  beep("tick");
  await new Promise((r) => setTimeout(r, 500));
  await speak("Two.");
  beep("tick");
  await new Promise((r) => setTimeout(r, 400));
  await speak("One.");
  beep("tick");
  await new Promise((r) => setTimeout(r, 400));
}

async function runSegment(video, seg, index) {
  sweep.segmentIndex = index;
  setStatus(seg.title, seg.intro);
  const { moveMs, holdMs, keepAt } = segmentDurations(seg);
  const speakPromise = speak(seg.intro);
  const start = now();
  let keepGoingSaid = false;
  let holdSaid = false;
  let good = false;
  const sampleEvery = sweep.testMode ? 50 : 110;

  while (!sweep.aborted) {
    const elapsed = now() - start;
    const cand = await sampleFrame(video, seg).catch(() => null);
    if (cand && isGoodEnough(cand.score, cand.hasFace ? { yaw: cand.yaw, pitch: cand.pitch } : null, cand.hasFace, seg)) {
      // Prefer a confirmation after we've entered the hold, or late in the move.
      if (elapsed >= moveMs * 0.45) {
        good = true;
        break;
      }
    }
    if (!keepGoingSaid && seg.keepGoing && elapsed >= keepAt) {
      keepGoingSaid = true;
      speak(seg.keepGoing);
    }
    if (!holdSaid && elapsed >= moveMs) {
      holdSaid = true;
      speak(seg.hold);
      setStatus(seg.title, seg.hold);
    }
    if (elapsed >= moveMs + holdMs) break;
    await new Promise((r) => setTimeout(r, sampleEvery));
  }
  await speakPromise.catch(() => {});
  if (sweep.aborted) return false;
  const list = sweep.candidates[seg.angleId] || [];
  if (good || list.length) {
    beep("good");
  }
  return list.length > 0;
}

/* ---------- public flow ---------- */

export async function prepareSweep({ facing, testMode } = {}) {
  if (facing) sweep.facing = facing;
  if (testMode != null) sweep.testMode = !!testMode;
  sweep.aborted = false;
  sweep.candidates = {};
  sweep.chosen = {};
  sweep.segmentIndex = -1;
  sweep.mediaPipe = sweep.landmarker ? "ready" : "pending";
  unlockAudio();
  // Warm the model in the background while the user reads the setup.
  loadLandmarker().catch(() => {});
}

export async function runSweep({ facing, testMode } = {}) {
  if (facing) sweep.facing = facing;
  if (testMode != null) sweep.testMode = !!testMode;
  sweep.aborted = false;
  sweep.running = true;
  sweep.candidates = {};
  sweep.chosen = {};
  unlockAudio();

  const video = $("#sweep-camera");
  try {
    if (!video.srcObject) await startSweepCamera(video);
    const load = loadLandmarker();
    setStatus("Loading", "Setting up on-device tracking…");
    await Promise.race([
      load,
      new Promise((r) => setTimeout(r, sweep.testMode ? 12000 : 10000)),
    ]);
    if (!sweep.landmarker) sweep.mediaPipe = "fallback";

    await countdown();
    if (sweep.aborted) return { aborted: true };

    for (let i = 0; i < SEGMENTS.length; i++) {
      if (sweep.aborted) return { aborted: true };
      await runSegment(video, SEGMENTS[i], i);
    }

    const captured = SEGMENTS.filter((s) => (sweep.candidates[s.angleId] || []).length).length;
    const doneLine = `Done, ${captured} of ${SEGMENTS.length} captured.`;
    setStatus("Done", doneLine);
    beep("done");
    await speak(doneLine);
    return { aborted: false, captured, mediaPipe: sweep.mediaPipe };
  } catch (err) {
    console.error(err);
    setStatus("Something went wrong", "You can try again, or use the photo session instead.");
    throw err;
  } finally {
    sweep.running = false;
    await stopSweepCamera(video);
    silence();
  }
}

export async function retakeSweepAngle(angleId) {
  const seg = SEGMENTS.find((s) => s.angleId === angleId);
  if (!seg) return;
  sweep.aborted = false;
  sweep.running = true;
  sweep.candidates[angleId] = [];
  sweep.chosen[angleId] = 0;
  unlockAudio();
  const video = $("#sweep-camera");
  try {
    await startSweepCamera(video);
    await loadLandmarker();
    if (!sweep.landmarker) sweep.mediaPipe = "fallback";
    const index = SEGMENTS.findIndex((s) => s.angleId === angleId);
    await countdown();
    if (!sweep.aborted) await runSegment(video, seg, index);
  } finally {
    sweep.running = false;
    await stopSweepCamera(video);
    silence();
  }
}

export function cancelSweep() {
  sweep.aborted = true;
  sweep.running = false;
  silence();
  const video = $("#sweep-camera");
  stopSweepCamera(video);
}

export function picks() {
  return SEGMENTS.map((s) => {
    const list = sweep.candidates[s.angleId] || [];
    const idx = Math.min(sweep.chosen[s.angleId] ?? 0, Math.max(0, list.length - 1));
    return { angleId: s.angleId, title: s.title, list, chosen: idx, pick: list[idx] || null };
  });
}

export function cycleCandidate(angleId, dir) {
  const list = sweep.candidates[angleId] || [];
  if (!list.length) return 0;
  const n = list.length;
  const cur = sweep.chosen[angleId] ?? 0;
  const next = (cur + dir + n) % n;
  sweep.chosen[angleId] = next;
  return next;
}

export async function saveSweepPhotos(sessionId) {
  const saved = [];
  for (const row of picks()) {
    if (!row.pick?.blob) continue;
    const compressed = await compressImage(row.pick.blob);
    saved.push({ angleId: row.angleId, ...compressed });
  }
  return saved;
}

export const SWEEP_ASSET_URLS = { WASM_DIR, MODEL_URL, BUNDLE_URL };
