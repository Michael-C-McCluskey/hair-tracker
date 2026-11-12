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
    intro: "Face the camera, looking straight ahead. I'll wait until you're square to the lens.",
    hold: "Hold still.",
    kind: "face",
    targetYaw: 0,
    yawMin: -15,
    yawMax: 15,
    targetPitch: 0,
    pitchTol: 18,
  },
  {
    angleId: "left-temple",
    title: "Left temple",
    intro: "Slowly turn your head to your right, until your left temple faces the camera. I'll tell you when to stop.",
    hold: "Hold.",
    kind: "face",
    targetYaw: 45,
    yawMin: 35,
    yawMax: 55,
    targetPitch: 0,
    pitchTol: 20,
  },
  {
    angleId: "right-temple",
    title: "Right temple",
    intro: "Come back to center. Now slowly turn your head to your left, until your right temple faces the camera.",
    hold: "Hold.",
    kind: "face",
    targetYaw: -45,
    yawMin: -55,
    yawMax: -35,
    targetPitch: 0,
    pitchTol: 20,
  },
  {
    angleId: "top",
    title: "Top",
    intro: "Come back to center. Now tilt your head down toward the camera, to show the top of your head. I'll wait until I can see it.",
    hold: "Hold.",
    kind: "top",
    targetYaw: 0,
    yawMin: -30,
    yawMax: 30,
    targetPitch: 35,
    pitchTol: 18,
  },
  {
    angleId: "back",
    title: "Back",
    intro: "Turn your back to the camera, so I can see the back of your head. I'll wait until your face is out of the frame.",
    hold: "Hold still.",
    kind: "back",
  },
  {
    angleId: "crown",
    title: "Crown",
    intro: "Keeping your back to the camera, tilt your head forward, to show the crown. I'll wait, then count down.",
    hold: "Hold.",
    kind: "back",
  },
];

const DISTANCE = {
  minWidth: 0.26,
  maxWidth: 0.58,
  cxMin: 0.36,
  cxMax: 0.64,
  cyMin: 0.30,
  cyMax: 0.70,
};

export const sweep = {
  running: false,
  aborted: false,
  testMode: false,
  facing: "environment",
  streamFacing: null,
  cameraError: "",
  mediaPipe: "pending", // "ready" | "fallback" | "pending"
  landmarker: null,
  stream: null,
  audioCtx: null,
  timer: null,
  segmentIndex: -1,
  segmentStartedAt: 0,
  phase: "",
  phaseStartedAt: 0,
  skipRequested: false,
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
  // Always score the raw video pixels, which are unmirrored. CSS scaleX(-1)
  // is preview-only (front camera), so do not invert yaw for a selfie stream.
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
    source: "landmarks",
  };
}

function yawPitchFromMatrix(matrix) {
  const m = matrix?.data || matrix;
  if (!m || m.length < 16) return null;
  // Column-major 4x4; yaw around Y, pitch around X, in degrees.
  const yaw = Math.atan2(m[8], m[10]) * (180 / Math.PI);
  const pitch = Math.asin(Math.max(-1, Math.min(1, -m[9]))) * (180 / Math.PI);
  if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return null;
  if (Math.abs(yaw) > 90 || Math.abs(pitch) > 90) return null;
  return { yaw, pitch };
}

function fusePose(landmarks, matrix) {
  const pose = poseFromLandmarks(landmarks);
  if (!pose) return null;
  const mat = yawPitchFromMatrix(matrix);
  if (!mat) return pose;
  // Landmark sign is the source of truth (unmirrored frame). Flip matrix if needed.
  if (mat.yaw !== 0 && pose.yaw !== 0 && Math.sign(mat.yaw) !== Math.sign(pose.yaw)) {
    mat.yaw = -mat.yaw;
  }
  if (Math.abs(mat.yaw - pose.yaw) <= 25) {
    pose.yaw = mat.yaw;
    pose.pitch = mat.pitch;
    pose.source = "matrix";
  }
  return pose;
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
  if (seg.targetYaw == null || !pose || pose.yaw == null) return 0;
  const span = Math.max(8, ((seg.yawMax ?? 16) - (seg.yawMin ?? -16)) / 2);
  const yawErr = Math.abs(pose.yaw - seg.targetYaw) / span;
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
  if (seg.kind === "back") {
    const noFace = hasFace ? 0.15 : 1;
    return noFace * 0.5 + sharp * 0.3 + bright * 0.2;
  }
  if (seg.kind === "top") {
    if (!hasFace) return sharp * 0.55 + bright * 0.3;
    const poseS = poseScore(pose, seg);
    return poseS * 0.4 + sharp * 0.35 + bright * 0.15 + sizeCenterScore(pose) * 0.1;
  }
  const poseS = poseScore(pose, seg);
  const sizeS = sizeCenterScore(pose);
  if (!hasFace) return sharp * 0.15 + bright * 0.1;
  return poseS * 0.48 + sharp * 0.24 + bright * 0.13 + sizeS * 0.15;
}

function yawInRange(yaw, seg) {
  if (yaw == null || seg.yawMin == null || seg.yawMax == null) return false;
  return yaw >= seg.yawMin && yaw <= seg.yawMax;
}

function facePoseVerified(obs, seg) {
  if (seg.kind !== "face") return false;
  if (!obs?.hasFace || obs.yaw == null) return false;
  if (!yawInRange(obs.yaw, seg)) return false;
  const pitch = obs.pitch ?? 0;
  if (Math.abs(pitch - (seg.targetPitch || 0)) > (seg.pitchTol || 20)) return false;
  return true;
}

function distanceStatus(pose) {
  if (!pose) return { ok: false, cues: ["I can't see your face yet. Step into the outline."] };
  const cues = [];
  if (pose.faceWidth < DISTANCE.minWidth) cues.push("Move closer.");
  else if (pose.faceWidth > DISTANCE.maxWidth) cues.push("Move back.");
  // Unmirrored frame: face on the left of the photo (small cx) means the
  // person is too far to their own right, so they should move left.
  if (pose.cx < DISTANCE.cxMin) cues.push("Move left.");
  else if (pose.cx > DISTANCE.cxMax) cues.push("Move right.");
  if (pose.cy < DISTANCE.cyMin) cues.push("Move down a little.");
  else if (pose.cy > DISTANCE.cyMax) cues.push("Move up a little.");
  return { ok: cues.length === 0, cues };
}

/* ---------- camera + sampling ---------- */

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function streamIsLive(stream) {
  return !!(stream && stream.getVideoTracks().some((t) => t.readyState === "live"));
}

function sweepVideoEls() {
  return [$("#sweep-preview"), $("#sweep-camera")].filter(Boolean);
}

function cameraErrorMessage(err) {
  const name = err?.name || "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "Camera permission is blocked. Allow the camera in Chrome, then try again.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return sweep.facing === "user"
      ? "No front camera was found. Try the rear camera, or use a photo session."
      : "No camera was found. Try the other camera, or use a photo session.";
  }
  if (sweep.facing === "user") {
    return "Can't open the front camera. Try again, or switch to the rear camera.";
  }
  return "Can't open the camera. Try the other camera, or use a photo session.";
}

export function showSweepCameraError(err) {
  const msg = typeof err === "string" ? err : cameraErrorMessage(err);
  sweep.cameraError = msg;
  for (const id of ["sweep-setup-error", "sweep-camera-error"]) {
    const el = $(`#${id}`);
    if (!el) continue;
    el.textContent = msg;
    el.hidden = false;
  }
  speak(msg);
  return msg;
}

export function clearSweepCameraError() {
  sweep.cameraError = "";
  for (const id of ["sweep-setup-error", "sweep-camera-error"]) {
    const el = $(`#${id}`);
    if (!el) continue;
    el.textContent = "";
    el.hidden = true;
  }
}

function applyFrontMirror(facing) {
  const isFront = facing === "user";
  $("#sweep-preview")?.classList.toggle("is-front", isFront);
  $("#sweep-camera")?.classList.toggle("is-front", isFront);
}

function trackFacing(stream) {
  const track = stream?.getVideoTracks?.()[0];
  if (!track) return null;
  const settings = track.getSettings?.() || {};
  if (settings.facingMode === "user" || settings.facingMode === "environment") {
    return settings.facingMode;
  }
  const label = track.label || "";
  if (/front|user|selfie|facing\s*(user|front)/i.test(label)) return "user";
  if (/back|rear|environment|facing\s*(back|environment)/i.test(label)) return "environment";
  return null;
}

async function findFacingDeviceId(facing) {
  if (!navigator.mediaDevices?.enumerateDevices) return null;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videos = devices.filter((d) => d.kind === "videoinput");
    const re =
      facing === "user"
        ? /front|user|selfie|facing\s*(user|front)/i
        : /back|rear|environment|facing\s*(back|environment)/i;
    const match = videos.find((d) => re.test(d.label || ""));
    return match?.deviceId || null;
  } catch {
    return null;
  }
}

async function constraintAttempts(facing) {
  const sized = { width: { ideal: 1920 }, height: { ideal: 1440 } };
  const compact = { width: { ideal: 1280 }, height: { ideal: 960 } };
  const attempts = [
    { audio: false, video: { ...sized, facingMode: { ideal: facing } } },
    { audio: false, video: { ...compact, facingMode: { ideal: facing } } },
    { audio: false, video: { facingMode: facing } },
  ];
  const deviceId = await findFacingDeviceId(facing);
  if (deviceId) {
    attempts.push({ audio: false, video: { ...sized, deviceId: { exact: deviceId } } });
    attempts.push({ audio: false, video: { ...compact, deviceId: { exact: deviceId } } });
    attempts.push({ audio: false, video: { deviceId: { exact: deviceId } } });
  }
  return attempts;
}

async function playVideoOrThrow(video) {
  try {
    await video.play();
    return;
  } catch (err) {
    await delay(50);
    try {
      await video.play();
    } catch (err2) {
      throw Object.assign(new Error(cameraErrorMessage(err2)), { cause: err2 });
    }
  }
}

let openGen = 0;

/** Stop tracks (optional) and detach srcObject from both sweep videos. */
export async function stopSweepStream({ releaseTracks = true } = {}) {
  const stream = sweep.stream;
  if (releaseTracks && stream) {
    stream.getTracks().forEach((t) => t.stop());
    sweep.stream = null;
    sweep.streamFacing = null;
  }
  for (const el of sweepVideoEls()) el.srcObject = null;
}

/**
 * Open (or reuse) the camera and attach it to `video`.
 * Reuses the live stream when the facing hasn't changed so Android Chrome
 * does not have to stop and reopen — that is what often breaks the front camera.
 */
export async function attachSweepStream(video, { facing, forceRestart = false } = {}) {
  if (facing) sweep.facing = facing === "user" ? "user" : "environment";
  const want = sweep.facing === "user" ? "user" : "environment";
  if (!video) throw new Error("Camera preview is missing.");
  applyFrontMirror(want);
  clearSweepCameraError();

  const gen = ++openGen;

  if (!forceRestart && streamIsLive(sweep.stream) && sweep.streamFacing === want) {
    for (const el of sweepVideoEls()) {
      if (el !== video) el.srcObject = null;
    }
    if (video.srcObject !== sweep.stream) video.srcObject = sweep.stream;
    video.hidden = false;
    applyFrontMirror(want);
    await playVideoOrThrow(video);
    return sweep.stream;
  }

  await stopSweepStream({ releaseTracks: true });
  await delay(80);
  if (gen !== openGen) return null;

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Can't open the camera. This browser has no camera access.");
  }

  const attempts = await constraintAttempts(want);
  let lastErr = null;
  for (const constraints of attempts) {
    if (gen !== openGen) return null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (gen !== openGen) {
        stream.getTracks().forEach((t) => t.stop());
        return null;
      }
      const got = trackFacing(stream);
      // Only reject when we can positively tell this is the wrong camera.
      if (got && got !== want) {
        stream.getTracks().forEach((t) => t.stop());
        lastErr = new Error("wrong camera");
        continue;
      }
      sweep.stream = stream;
      sweep.streamFacing = want;
      for (const el of sweepVideoEls()) el.srcObject = null;
      video.srcObject = stream;
      video.hidden = false;
      applyFrontMirror(want);
      await playVideoOrThrow(video);
      return stream;
    } catch (err) {
      lastErr = err;
      await stopSweepStream({ releaseTracks: true });
      await delay(80);
    }
  }
  const fail = lastErr || new Error("Can't open the camera");
  throw Object.assign(new Error(cameraErrorMessage(fail)), { cause: fail });
}

export async function startSweepPreview() {
  const video = $("#sweep-preview");
  if (!video) return null;
  return attachSweepStream(video, { facing: sweep.facing });
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

function timings() {
  if (sweep.testMode) {
    return {
      sampleEvery: 40,
      holdMs: 80,
      distanceHoldMs: 80,
      cueEvery: 40,
      skipAfterMs: 2400,
      noFaceCountdownMs: 120,
      captureWindowMs: 90,
      pauseMs: 20,
      settleMs: 90,
    };
  }
  return {
    sampleEvery: 110,
    holdMs: 1000,
    distanceHoldMs: 1000,
    cueEvery: 2800,
    skipAfterMs: 20000,
    noFaceCountdownMs: 3000,
    captureWindowMs: 1400,
    pauseMs: 500,
    settleMs: 0,
  };
}

function defaultTestObservation() {
  const t = timings();
  const elapsed = now() - (sweep.phaseStartedAt || now());
  const settled = elapsed >= t.settleMs;
  const good = {
    yaw: 0,
    pitch: 0,
    faceWidth: 0.4,
    faceHeight: 0.52,
    cx: 0.5,
    cy: 0.48,
  };
  const phase = sweep.phase || "";
  if (phase === "distance") {
    if (!settled) {
      return { hasFace: true, pose: { ...good, faceWidth: 0.16, faceHeight: 0.22 } };
    }
    return { hasFace: true, pose: { ...good } };
  }
  if (phase === "front") {
    if (!settled) return { hasFace: true, pose: { ...good, yaw: 22 } };
    return { hasFace: true, pose: { ...good, yaw: 3, pitch: 1 } };
  }
  if (phase === "left-temple") {
    if (!settled) return { hasFace: true, pose: { ...good, yaw: 8 } };
    return { hasFace: true, pose: { ...good, yaw: 44, pitch: 2 } };
  }
  if (phase === "right-temple") {
    if (!settled) return { hasFace: true, pose: { ...good, yaw: 12 } };
    return { hasFace: true, pose: { ...good, yaw: -43, pitch: 1 } };
  }
  if (phase === "top") {
    if (!settled) return { hasFace: true, pose: { ...good, yaw: 2, pitch: 6 } };
    return { hasFace: true, pose: { ...good, yaw: 1, pitch: 38, faceWidth: 0.34 } };
  }
  if (phase === "back" || phase === "crown") {
    if (!settled) return { hasFace: true, pose: { ...good } };
    return { hasFace: false, pose: null };
  }
  return { hasFace: false, pose: null };
}

function readPose(video) {
  if (sweep.testMode) {
    if (typeof sweep.testPoseFn === "function") return sweep.testPoseFn();
    return defaultTestObservation();
  }
  if (!sweep.landmarker) return { hasFace: false, pose: null };
  try {
    const res = sweep.landmarker.detectForVideo(video, Math.round(now()));
    const marks = res?.faceLandmarks?.[0];
    if (marks && marks.length) {
      const matrix = res?.facialTransformationMatrixes?.[0];
      return { hasFace: true, pose: fusePose(marks, matrix) };
    }
  } catch {
    /* keep going */
  }
  return { hasFace: false, pose: null };
}

async function analyzeFrame(video, seg) {
  if (!video?.srcObject || !video.videoWidth) return null;
  const { blob, width, height, canvas } = await captureJpeg(video);
  const { gray, w, h } = downscaleGray(canvas, 160);
  const sharpness = laplacianVariance(gray, w, h);
  const brightness = lumaStats(gray, w * h);
  const { hasFace, pose } = readPose(video);
  const score = seg ? scoreFrame({ sharpness, brightness, pose, hasFace, seg }) : 0;
  return {
    blob,
    width,
    height,
    score,
    sharpness,
    brightness,
    hasFace,
    yaw: pose?.yaw ?? null,
    pitch: pose?.pitch ?? null,
    faceWidth: pose?.faceWidth ?? null,
    cx: pose?.cx ?? null,
    cy: pose?.cy ?? null,
    pose,
    poseVerified: false,
    at: Date.now(),
  };
}

/* ---------- UI helpers ---------- */

function setStatus(title, detail) {
  sweep.status = detail || title;
  const t = $("#sweep-status");
  const d = $("#sweep-detail");
  const step = $("#sweep-step");
  if (t) t.textContent = title;
  if (d) d.textContent = detail || "";
  if (step) {
    if (sweep.segmentIndex >= 0) step.textContent = `${sweep.segmentIndex + 1} of ${SEGMENTS.length}`;
    else step.textContent = "Get set";
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

function setGuide({ visible = false, good = false } = {}) {
  const g = $("#sweep-guide");
  if (!g) return;
  g.hidden = !visible;
  g.classList.toggle("is-good", !!good);
  g.classList.toggle("is-front", sweep.facing === "user");
}

function setSkipVisible(on) {
  const btn = $("#btn-sweep-skip");
  if (btn) btn.hidden = !on;
}

export function requestSkip() {
  sweep.skipRequested = true;
}

function consumeSkip() {
  if (!sweep.skipRequested) return false;
  sweep.skipRequested = false;
  return true;
}

function buzz(ms = 200) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* no haptic */
  }
}

function flashGreen() {
  const el = $("#sweep-flash");
  if (!el) return;
  el.hidden = false;
  el.classList.remove("is-on");
  requestAnimationFrame(() => {
    el.classList.add("is-on");
    setTimeout(() => {
      el.classList.remove("is-on");
      el.hidden = true;
    }, 280);
  });
}

function celebrateCapture() {
  buzz(200);
  beep("good");
  flashGreen();
}

let lastCue = "";
let lastCueAt = 0;

function resetCoach() {
  lastCue = "";
  lastCueAt = 0;
}

function coach(title, line, { force = false } = {}) {
  const t = timings();
  if (!force && line === lastCue && now() - lastCueAt < t.cueEvery) {
    setStatus(title, line);
    return;
  }
  lastCue = line;
  lastCueAt = now();
  setStatus(title, line);
  speak(line);
}

function beginPhase(name) {
  sweep.phase = name;
  sweep.phaseStartedAt = now();
  sweep.skipRequested = false;
  setSkipVisible(false);
  resetCoach();
}

async function offerSkip(title, label) {
  const line = `I still don't have a clear ${label} yet. I'll keep waiting. Tap skip if you want to move on.`;
  coach(title, line, { force: true });
  setSkipVisible(true);
}

function yawCoach(obs, seg) {
  if (!obs?.hasFace || obs.yaw == null) {
    return "I can't see your face. Step into the outline.";
  }
  const yaw = obs.yaw;
  if (yawInRange(yaw, seg) && Math.abs((obs.pitch ?? 0) - (seg.targetPitch || 0)) <= (seg.pitchTol || 20)) {
    return seg.hold || "Hold.";
  }
  if (seg.angleId === "front") {
    if (yaw > seg.yawMax) return "Turn back to your left, and face the camera.";
    if (yaw < seg.yawMin) return "Turn back to your right, and face the camera.";
    return "Keep your head level, and face the camera.";
  }
  if (seg.angleId === "left-temple") {
    if (yaw < seg.yawMin) {
      return yaw < 15 ? "Turn your head to your right." : "Turn a little more.";
    }
    if (yaw > seg.yawMax) return "Too far, come back.";
    return "Keep your head level.";
  }
  if (seg.angleId === "right-temple") {
    if (yaw > seg.yawMax) {
      return yaw > -15 ? "Turn your head to your left." : "Turn a little more.";
    }
    if (yaw < seg.yawMin) return "Too far, come back.";
    return "Keep your head level.";
  }
  return "Keep going, slowly.";
}

async function waitLoop(video, { until, title, onTick, seg = null }) {
  const t = timings();
  let skipOffered = false;
  const started = now();
  while (!sweep.aborted) {
    if (consumeSkip()) return "skipped";
    const elapsed = now() - started;
    if (!skipOffered && elapsed >= t.skipAfterMs) {
      skipOffered = true;
      await offerSkip(title, title.toLowerCase());
    }
    const obs = await analyzeFrame(video, seg).catch(() => null);
    const result = until(obs, elapsed);
    if (result) return result;
    if (onTick) onTick(obs, elapsed);
    await delay(t.sampleEvery);
  }
  return "aborted";
}

async function captureWindow(video, seg, { verify } = {}) {
  const t = timings();
  const end = now() + t.captureWindowMs;
  let any = false;
  while (!sweep.aborted && now() < end) {
    const obs = await analyzeFrame(video, seg).catch(() => null);
    if (obs && (!verify || verify(obs))) {
      obs.poseVerified = true;
      keepCandidate(seg.angleId, obs);
      any = true;
    }
    await delay(t.sampleEvery);
  }
  return any;
}

async function countDownCapture(secondsLabel = true) {
  const t = timings();
  if (sweep.testMode) {
    beep("tick");
    await delay(t.noFaceCountdownMs);
    return;
  }
  await speak("Hold still. Three.");
  beep("tick");
  if (sweep.aborted) return;
  await delay(Math.max(0, t.noFaceCountdownMs / 3 - 200));
  await speak("Two.");
  beep("tick");
  if (sweep.aborted) return;
  await delay(Math.max(0, t.noFaceCountdownMs / 3 - 200));
  await speak("One.");
  beep("tick");
  await delay(Math.max(0, t.noFaceCountdownMs / 3 - 200));
}

/**
 * Pose-gated distance check. Outline turns green and we buzz once the
 * face is sized and centered, then require a ~1s hold.
 */
async function runDistanceStep(video, { brief = false } = {}) {
  beginPhase("distance");
  sweep.segmentIndex = -1;
  setGuide({ visible: true, good: false });
  const t = timings();
  const title = "Distance";
  if (!brief) {
    coach(title, "First, let's get the distance. Stand so your face fills the outline.", { force: true });
  } else {
    coach(title, "Stay in the outline.", { force: true });
  }

  if (!sweep.testMode && !sweep.landmarker) {
    coach(title, "I can't measure distance, so listen for the prompts.", { force: true });
    setGuide({ visible: true, good: false });
    await delay(t.pauseMs);
    return "fallback";
  }

  let inRangeSince = 0;
  let celebratedReady = false;
  const outcome = await waitLoop(video, {
    title,
    until: (obs) => {
      const { ok } = distanceStatus(obs?.pose);
      setGuide({ visible: true, good: ok });
      if (ok) {
        if (!inRangeSince) inRangeSince = now();
        if (!celebratedReady) {
          celebratedReady = true;
          buzz(200);
          beep("good");
        }
        if (now() - inRangeSince >= t.distanceHoldMs) return "ok";
      } else {
        inRangeSince = 0;
        celebratedReady = false;
      }
      return null;
    },
    onTick: (obs) => {
      const { ok, cues } = distanceStatus(obs?.pose);
      if (ok) {
        if (inRangeSince && now() - inRangeSince < t.distanceHoldMs) {
          coach(title, "That's it. Hold still.");
        }
      } else {
        coach(title, (cues && cues.join(" ")) || "Step into the outline.");
      }
    },
  });
  if (outcome === "ok") {
    setGuide({ visible: true, good: true });
  }
  return outcome;
}

async function runFaceAngle(video, seg, index) {
  beginPhase(seg.angleId);
  sweep.segmentIndex = index;
  setGuide({ visible: true, good: false });
  const t = timings();
  const title = seg.title;
  coach(title, seg.intro, { force: true });
  sweep.candidates[seg.angleId] = [];
  sweep.chosen[seg.angleId] = 0;

  if (!sweep.testMode && !sweep.landmarker) {
    // Can't verify yaw: slow voice prompt, then capture sharpness-only and mark unverified.
    await delay(Math.max(t.captureWindowMs, 800));
    await speak(seg.hold);
    await captureWindow(video, seg, { verify: () => true });
    (sweep.candidates[seg.angleId] || []).forEach((c) => {
      c.poseVerified = false;
    });
    return (sweep.candidates[seg.angleId] || []).length ? "ok" : "skipped";
  }

  let inRangeSince = 0;
  const outcome = await waitLoop(video, {
    title,
    seg,
    until: (obs) => {
      const good = facePoseVerified(obs, seg);
      setGuide({ visible: true, good });
      if (good && obs) {
        if (!inRangeSince) inRangeSince = now();
        obs.poseVerified = true;
        keepCandidate(seg.angleId, obs);
        if (now() - inRangeSince >= t.holdMs) return "ok";
      } else {
        if (inRangeSince) sweep.candidates[seg.angleId] = [];
        inRangeSince = 0;
      }
      return null;
    },
    onTick: (obs) => {
      coach(title, yawCoach(obs, seg));
    },
  });

  if (outcome !== "ok") {
    sweep.candidates[seg.angleId] = [];
    return outcome;
  }

  // Grab a few more in-range frames if the hold window was short.
  if ((sweep.candidates[seg.angleId] || []).length < 2) {
    await captureWindow(video, seg, { verify: (obs) => facePoseVerified(obs, seg) });
  }
  if (!(sweep.candidates[seg.angleId] || []).length) {
    coach(title, "I lost the angle. " + yawCoach(null, seg), { force: true });
    return "retry";
  }
  celebrateCapture();
  setGuide({ visible: true, good: true });
  return "ok";
}

async function runHiddenAngle(video, seg, index) {
  beginPhase(seg.angleId);
  sweep.segmentIndex = index;
  setGuide({ visible: false, good: false });
  const title = seg.title;
  coach(title, seg.intro, { force: true });
  sweep.candidates[seg.angleId] = [];
  sweep.chosen[seg.angleId] = 0;

  const gate = (obs) => {
    if (seg.kind === "top") {
      if (!obs) return false;
      if (!obs.hasFace) return true;
      return (obs.pitch ?? 0) >= 28;
    }
    return !obs?.hasFace;
  };

  if (!sweep.testMode && !sweep.landmarker) {
    await delay(timings().pauseMs);
    await countDownCapture();
    if (sweep.aborted) return "aborted";
    await captureWindow(video, seg, { verify: () => true });
    (sweep.candidates[seg.angleId] || []).forEach((c) => {
      c.poseVerified = false;
    });
    if ((sweep.candidates[seg.angleId] || []).length) celebrateCapture();
    return (sweep.candidates[seg.angleId] || []).length ? "ok" : "skipped";
  }

  const waiting = seg.kind === "top"
    ? "Tilt the top of your head toward the camera, or step so I can't see your face."
    : "Turn until I can't see your face.";

  const outcome = await waitLoop(video, {
    title,
    until: (obs) => (gate(obs) ? "ok" : null),
    onTick: (obs) => {
      if (!gate(obs)) coach(title, waiting);
    },
  });
  if (outcome !== "ok") {
    sweep.candidates[seg.angleId] = [];
    return outcome;
  }

  setStatus(title, "Hold still.");
  await countDownCapture();
  if (sweep.aborted || consumeSkip()) {
    sweep.candidates[seg.angleId] = [];
    return sweep.aborted ? "aborted" : "skipped";
  }
  await captureWindow(video, seg, {
    verify: (obs) => {
      if (seg.kind === "top") return !obs.hasFace || (obs.pitch ?? 0) >= 22;
      return !obs.hasFace;
    },
  });
  // If the face came back during the window and we got nothing, don't assign a face frame.
  if (!(sweep.candidates[seg.angleId] || []).length) {
    return "retry";
  }
  (sweep.candidates[seg.angleId] || []).forEach((c) => {
    c.poseVerified = true;
  });
  celebrateCapture();
  return "ok";
}

async function runSegment(video, seg, index) {
  let attempts = 0;
  while (!sweep.aborted && attempts < 3) {
    attempts += 1;
    const result = seg.kind === "face"
      ? await runFaceAngle(video, seg, index)
      : await runHiddenAngle(video, seg, index);
    if (result === "ok" || result === "skipped" || result === "aborted" || result === "fallback") {
      setSkipVisible(false);
      return result;
    }
    // retry if the capture window missed
  }
  setSkipVisible(false);
  return "skipped";
}

async function maybeRecheckDistance(video, nextSeg) {
  if (nextSeg?.kind !== "face") return "ok";
  const result = await runDistanceStep(video, { brief: true });
  return result;
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
    await attachSweepStream(video, { facing: sweep.facing });
    const load = loadLandmarker();
    setStatus("Loading", "Setting up on-device tracking…");
    await Promise.race([
      load,
      new Promise((r) => setTimeout(r, sweep.testMode ? 12000 : 10000)),
    ]);
    if (!sweep.landmarker) sweep.mediaPipe = "fallback";

    const dist = await runDistanceStep(video);
    if (sweep.aborted || dist === "aborted") return { aborted: true };
    await delay(timings().pauseMs);

    for (let i = 0; i < SEGMENTS.length; i++) {
      if (sweep.aborted) return { aborted: true };
      const seg = SEGMENTS[i];
      if (i > 0 && seg.kind === "face") {
        const recheck = await maybeRecheckDistance(video, seg);
        if (sweep.aborted || recheck === "aborted") return { aborted: true };
      }
      await runSegment(video, seg, i);
      await delay(timings().pauseMs);
    }

    setGuide({ visible: false });
    setSkipVisible(false);
    const captured = SEGMENTS.filter((s) => (sweep.candidates[s.angleId] || []).length).length;
    const doneLine = `Done, ${captured} of ${SEGMENTS.length} captured.`;
    setStatus("Done", doneLine);
    beep("done");
    await speak(doneLine);
    return { aborted: false, captured, mediaPipe: sweep.mediaPipe };
  } catch (err) {
    console.error(err);
    const msg = showSweepCameraError(err);
    setStatus("Something went wrong", msg || "You can try again, or use the photo session instead.");
    throw err;
  } finally {
    sweep.running = false;
    setGuide({ visible: false });
    setSkipVisible(false);
    await stopSweepStream({ releaseTracks: true });
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
    await attachSweepStream(video, { facing: sweep.facing });
    await loadLandmarker();
    if (!sweep.landmarker) sweep.mediaPipe = "fallback";
    const index = SEGMENTS.findIndex((s) => s.angleId === angleId);
    if (seg.kind === "face") await runDistanceStep(video, { brief: true });
    if (!sweep.aborted) await runSegment(video, seg, index);
    setGuide({ visible: false });
    setSkipVisible(false);
  } catch (err) {
    console.error(err);
    showSweepCameraError(err);
    throw err;
  } finally {
    sweep.running = false;
    await stopSweepStream({ releaseTracks: true });
    silence();
  }
}

export function cancelSweep() {
  sweep.aborted = true;
  sweep.running = false;
  silence();
  setGuide({ visible: false });
  setSkipVisible(false);
  stopSweepStream({ releaseTracks: true });
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
