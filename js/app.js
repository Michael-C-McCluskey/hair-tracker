import {
  ANGLES,
  angleById,
  openDb,
  todayISO,
  formatDate,
  formatDateShort,
  getSetting,
  setSetting,
  getAllSessions,
  getSession,
  getSessionByDate,
  upsertSession,
  saveSessionNotes,
  deleteSession,
  getPhotosForSession,
  getPhotosForAngle,
  getPreviousPhoto,
  savePhoto,
  estimateStorage,
  compressImage,
  exportBackup,
  importBackup,
} from "./db.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  view: "home",
  sessionId: null,
  captureIndex: 0,
  facingMode: "user",
  stream: null,
  reviewing: false,
  reviewBlob: null,
  timerSec: 0,
  countdown: null,
  ghostUrl: null,
  photoUrls: new Map(), // key -> objectURL
  intervalDays: 7,
  compareMode: "side",
  deferredPrompt: null,
  wakeLock: null,
};

function revoke(url) {
  if (url) URL.revokeObjectURL(url);
}

function urlFor(key, blob) {
  const prev = state.photoUrls.get(key);
  if (prev) URL.revokeObjectURL(prev);
  const url = URL.createObjectURL(blob);
  state.photoUrls.set(key, url);
  return url;
}

/* ---------- routing ---------- */

function parseHash() {
  const hash = (location.hash || "#/home").replace(/^#\/?/, "");
  const [view, ...rest] = hash.split("/").filter(Boolean);
  return { view: view || "home", rest };
}

function navigate(path) {
  if (!path.startsWith("#")) path = "#/" + path.replace(/^\//, "");
  if (location.hash === path) route();
  else location.hash = path;
}

async function route() {
  const toastEl = $("#toast");
  if (toastEl) toastEl.hidden = true;
  const { view, rest } = parseHash();
  const fullscreen = view === "capture" || view === "complete";
  $("#tabbar").classList.toggle("is-hidden", fullscreen);

  if (view !== "capture") await stopCamera();

  $$(".tab").forEach((t) => t.classList.toggle("is-active", t.dataset.nav === view || (view === "session" && t.dataset.nav === "timeline")));

  if (view === "session" && rest[0]) {
    showView("session");
    await renderSession(rest[0]);
    return;
  }

  showView(view === "index" ? "home" : view);
  if (view === "home" || !view) await renderHome();
  else if (view === "timeline") await renderTimeline();
  else if (view === "compare") await renderCompare();
  else if (view === "settings") await renderSettings();
  else if (view === "capture") await startCapture(rest[0]);
  else if (view === "complete") await renderComplete();
  else {
    showView("home");
    await renderHome();
  }
}

function showView(name) {
  state.view = name;
  $$(".view").forEach((v) => {
    v.hidden = v.dataset.view !== name;
  });
}

/* ---------- toast / modal / lightbox ---------- */

let toastTimer;
function toast(msg, ms = 2400) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, ms);
}

function confirmModal({ title, body, ok = "Delete" }) {
  return new Promise((resolve) => {
    const modal = $("#modal");
    $("#modal-title").textContent = title;
    $("#modal-body").textContent = body;
    $("#modal-ok").textContent = ok;
    modal.hidden = false;
    const done = (val) => {
      modal.hidden = true;
      $("#modal-ok").removeEventListener("click", onOk);
      $("#modal-cancel").removeEventListener("click", onCancel);
      modal.removeEventListener("click", onBackdrop);
      resolve(val);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onBackdrop = (e) => {
      if (e.target === modal) done(false);
    };
    $("#modal-ok").addEventListener("click", onOk);
    $("#modal-cancel").addEventListener("click", onCancel);
    modal.addEventListener("click", onBackdrop);
  });
}

function openLightbox(src, caption) {
  $("#lightbox-img").src = src;
  $("#lightbox-caption").textContent = caption || "";
  $("#lightbox").hidden = false;
}

function closeLightbox() {
  $("#lightbox").hidden = true;
  $("#lightbox-img").src = "";
}

/* ---------- home ---------- */

async function renderHome() {
  const sessions = await getAllSessions();
  const interval = Number(await getSetting("intervalDays", 7)) || 7;
  state.intervalDays = interval;
  const last = sessions[0];
  const reminder = $("#home-reminder");
  const startBtn = $("#btn-start-session");

  if (!last) {
    reminder.className = "reminder-card";
    reminder.innerHTML = `
      <div class="days">—</div>
      <p class="days-label">No sessions yet</p>
      <p class="hint">Take the same six angles every week or so. Photos stay on this phone.</p>`;
    startBtn.textContent = "Start first session";
  } else {
    const today = todayISO();
    const lastDate = last.date;
    const days = daysBetween(lastDate, today);
    const due = days >= interval;
    const isToday = days === 0;
    reminder.className = "reminder-card" + (isToday ? " is-today" : due ? " is-due" : "");
    const remaining = Math.max(0, interval - days);
    const pct = Math.min(100, Math.round((days / interval) * 100));
    let status;
    if (isToday) status = "You already logged a session today.";
    else if (due) status = "Due for a new set of photos.";
    else status = `Next check-in in ${remaining} day${remaining === 1 ? "" : "s"}.`;
    reminder.innerHTML = `
      <div class="days">${days}</div>
      <p class="days-label">${days === 1 ? "day" : "days"} since your last session</p>
      <div class="progress" aria-hidden="true"><span style="width:${pct}%"></span></div>
      <div class="progress-meta"><span>${formatDateShort(lastDate)}</span><span>${status}</span></div>`;

    const todaySession = await getSessionByDate(today);
    if (todaySession) {
      const photos = await getPhotosForSession(todaySession.id);
      const n = photos.length;
      startBtn.textContent = n >= ANGLES.length ? "Retake today’s photos" : `Continue today’s session · ${n} of ${ANGLES.length}`;
    } else {
      startBtn.textContent = "Start session";
    }
  }

  const lastWrap = $("#home-last-session");
  if (last) {
    lastWrap.innerHTML = `
      <p class="section-label">Latest session</p>
      ${await sessionCardHtml(last, { href: `#/session/${last.id}` })}`;
    lastWrap.querySelector("a.session-card")?.addEventListener("click", (e) => {
      e.preventDefault();
      navigate(`#/session/${last.id}`);
    });
  } else {
    lastWrap.innerHTML = "";
  }

  maybeShowInstall();
}

function daysBetween(fromISO, toISO) {
  const [y1, m1, d1] = fromISO.split("-").map(Number);
  const [y2, m2, d2] = toISO.split("-").map(Number);
  const a = Date.UTC(y1, m1 - 1, d1);
  const b = Date.UTC(y2, m2 - 1, d2);
  return Math.round((b - a) / 86400000);
}

async function sessionCardHtml(session, { href } = {}) {
  const photos = await getPhotosForSession(session.id);
  const byAngle = Object.fromEntries(photos.map((p) => [p.angleId, p]));
  const thumbs = ANGLES.map((a) => {
    const p = byAngle[a.id];
    if (p) {
      const src = urlFor(p.id, p.blob);
      return `<div class="thumb"><img src="${src}" alt="${esc(a.short)}"><span class="thumb-label">${esc(a.short)}</span></div>`;
    }
    return `<div class="thumb empty">${esc(a.short)}</div>`;
  }).join("");
  const notes = session.notes ? `<p class="notes-excerpt">${esc(session.notes)}</p>` : "";
  const count = `${photos.length} of ${ANGLES.length}`;
  const inner = `
    <div class="session-card-head"><h2>${esc(formatDate(session.date))}</h2><span class="count">${count}</span></div>
    <div class="thumb-grid">${thumbs}</div>
    ${notes}`;
  if (href) return `<a class="session-card" href="${href}">${inner}</a>`;
  return `<div class="session-card">${inner}</div>`;
}

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function startSessionForDate(date) {
  const session = await upsertSession({ date, notes: (await getSessionByDate(date))?.notes });
  const photos = await getPhotosForSession(session.id);
  const firstMissing = ANGLES.findIndex((a) => !photos.some((p) => p.angleId === a.id));
  state.sessionId = session.id;
  state.captureIndex = firstMissing === -1 ? 0 : firstMissing;
  navigate("#/capture");
}

/* ---------- timeline / session ---------- */

async function renderTimeline() {
  const sessions = await getAllSessions();
  $("#timeline-count").textContent = sessions.length
    ? `${sessions.length} session${sessions.length === 1 ? "" : "s"}`
    : "No sessions yet";
  const list = $("#timeline-list");
  if (!sessions.length) {
    list.innerHTML = `<div class="empty-state"><h2>Nothing here yet</h2><p>Start a session from the home screen. Your photos will show up here by date.</p></div>`;
    return;
  }
  const cards = [];
  for (const s of sessions) cards.push(await sessionCardHtml(s, { href: `#/session/${s.id}` }));
  list.innerHTML = cards.join("");
  list.querySelectorAll("a.session-card").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      navigate(a.getAttribute("href"));
    });
  });
}

async function renderSession(id) {
  const session = await getSession(id);
  if (!session) {
    toast("Session not found");
    navigate("#/timeline");
    return;
  }
  state.sessionId = session.id;
  $("#session-title").textContent = formatDate(session.date);
  const photos = await getPhotosForSession(session.id);
  $("#session-meta").textContent = `${photos.length} of ${ANGLES.length} angles`;
  const byAngle = Object.fromEntries(photos.map((p) => [p.angleId, p]));
  const grid = $("#session-grid");
  grid.innerHTML = ANGLES.map((a) => {
    const p = byAngle[a.id];
    if (p) {
      const src = urlFor(p.id, p.blob);
      return `<button type="button" class="cell" data-photo="${p.id}" data-src="${src}" data-caption="${esc(a.name)} · ${esc(formatDateShort(session.date))}">
        <img src="${src}" alt="${esc(a.name)}"><span class="cell-label">${esc(a.name)}</span>
      </button>`;
    }
    return `<button type="button" class="cell empty" data-missing="${a.id}">Add ${esc(a.short)}</button>`;
  }).join("");
  grid.querySelectorAll(".cell[data-src]").forEach((btn) => {
    btn.addEventListener("click", () => openLightbox(btn.dataset.src, btn.dataset.caption));
  });
  grid.querySelectorAll(".cell[data-missing]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = ANGLES.findIndex((a) => a.id === btn.dataset.missing);
      state.captureIndex = Math.max(0, idx);
      navigate("#/capture");
    });
  });
  const notes = $("#session-notes");
  notes.value = session.notes || "";
  notes.oninput = debounce(() => saveSessionNotes(session.id, notes.value), 400);
  notes.onchange = () => saveSessionNotes(session.id, notes.value);
  $("#btn-session-continue").onclick = () => {
    const firstMissing = ANGLES.findIndex((a) => !byAngle[a.id]);
    state.captureIndex = firstMissing === -1 ? 0 : firstMissing;
    navigate("#/capture");
  };
  $("#btn-session-back").onclick = () => navigate("#/timeline");
  $("#btn-session-delete").onclick = async () => {
    const ok = await confirmModal({
      title: "Delete this session?",
      body: "All photos and notes from this date will be removed from this phone. This can’t be undone.",
      ok: "Delete",
    });
    if (!ok) return;
    await deleteSession(session.id);
    toast("Session deleted");
    navigate("#/timeline");
  };
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ---------- capture ---------- */

const GUIDE = {
  front: `<svg viewBox="0 0 100 140" preserveAspectRatio="xMidYMid meet" fill="none" stroke="rgba(243,237,228,0.55)" stroke-width="1.2">
    <ellipse cx="50" cy="68" rx="24" ry="32"/>
    <path d="M28 62c4-22 40-22 44 0" stroke-linecap="round"/>
    <path d="M50 28v22"/>
  </svg>`,
  "left-temple": `<svg viewBox="0 0 100 140" preserveAspectRatio="xMidYMid meet" fill="none" stroke="rgba(243,237,228,0.55)" stroke-width="1.2">
    <path d="M62 36c-16-4-30 10-30 34s12 40 30 36c8-2 16-14 16-36s-8-32-16-34z"/>
    <path d="M48 40c8-10 24-8 28 2" stroke-linecap="round"/>
  </svg>`,
  "right-temple": `<svg viewBox="0 0 100 140" preserveAspectRatio="xMidYMid meet" fill="none" stroke="rgba(243,237,228,0.55)" stroke-width="1.2">
    <path d="M38 36c16-4 30 10 30 34s-12 40-30 36c-8-2-16-14-16-36s8-32 16-34z"/>
    <path d="M52 40c-8-10-24-8-28 2" stroke-linecap="round"/>
  </svg>`,
  top: `<svg viewBox="0 0 100 140" preserveAspectRatio="xMidYMid meet" fill="none" stroke="rgba(243,237,228,0.55)" stroke-width="1.2">
    <ellipse cx="50" cy="70" rx="30" ry="36"/>
    <path d="M50 36v68" stroke-dasharray="3 3"/>
  </svg>`,
  crown: `<svg viewBox="0 0 100 140" preserveAspectRatio="xMidYMid meet" fill="none" stroke="rgba(243,237,228,0.55)" stroke-width="1.2">
    <circle cx="50" cy="70" r="28"/>
    <circle cx="50" cy="70" r="4"/>
    <path d="M50 42v8M50 90v8M22 70h8M70 70h8"/>
  </svg>`,
  back: `<svg viewBox="0 0 100 140" preserveAspectRatio="xMidYMid meet" fill="none" stroke="rgba(243,237,228,0.55)" stroke-width="1.2">
    <ellipse cx="50" cy="68" rx="24" ry="32"/>
    <path d="M28 58c6-18 38-18 44 0" stroke-linecap="round"/>
  </svg>`,
};

async function startCapture(sessionIdFromRoute) {
  if (sessionIdFromRoute) state.sessionId = sessionIdFromRoute;
  if (!state.sessionId) {
    const session = await upsertSession({ date: todayISO() });
    state.sessionId = session.id;
  }
  state.reviewing = false;
  state.reviewBlob = null;
  hideReview();
  const angle = ANGLES[state.captureIndex] || ANGLES[0];
  if (!ANGLES[state.captureIndex]) state.captureIndex = 0;
  state.facingMode = angle.facing || "environment";
  renderCaptureChrome();
  await setupGhostAndGuide();
  await startCamera();
  requestWakeLock();
}

function renderCaptureChrome() {
  const angle = ANGLES[state.captureIndex];
  $("#capture-step").textContent = `${state.captureIndex + 1} of ${ANGLES.length}`;
  $("#capture-angle-name").textContent = angle.name;
  $("#capture-tip").textContent = angle.tip;
  $("#timer-label").textContent = state.timerSec ? `${state.timerSec}s` : "Timer";
  $("#btn-timer").classList.toggle("is-on", !!state.timerSec);
}

async function setupGhostAndGuide() {
  const angle = ANGLES[state.captureIndex];
  const session = await getSession(state.sessionId);
  const prev = await getPreviousPhoto(angle.id, state.sessionId, session?.date);
  const ghost = $("#ghost");
  const guide = $("#guide");
  const row = $("#ghost-row");
  if (state.ghostUrl) {
    revoke(state.ghostUrl);
    state.ghostUrl = null;
  }
  if (prev?.blob) {
    state.ghostUrl = URL.createObjectURL(prev.blob);
    ghost.src = state.ghostUrl;
    ghost.hidden = false;
    const opacity = Number(sessionStorage.getItem("ghostOpacity") ?? 40);
    $("#ghost-opacity").value = String(opacity);
    ghost.style.opacity = String(opacity / 100);
    row.hidden = false;
    guide.hidden = true;
  } else {
    ghost.hidden = true;
    ghost.removeAttribute("src");
    row.hidden = true;
    guide.innerHTML = GUIDE[angle.id] || GUIDE.front;
    guide.hidden = false;
  }
}

function streamIsLive(stream) {
  return !!stream && stream.getVideoTracks().some((t) => t.readyState === "live");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startCamera() {
  const video = $("#camera");
  const fallback = $("#camera-fallback");
  fallback.hidden = true;
  // Fully release the previous stream (including srcObject) before opening
  // a new one. Android Chrome often keeps showing the last frame — and can
  // refuse a front/rear switch — if the old tracks are stopped but still
  // attached to the <video> element.
  await stopCamera(true, { releaseLock: false });
  await delay(50);
  const constraints = {
    audio: false,
    video: {
      facingMode: { ideal: state.facingMode },
      width: { ideal: 1920 },
      height: { ideal: 1440 },
    },
  };
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("no mediaDevices");
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    state.stream = stream;
    video.srcObject = stream;
    video.classList.toggle("is-front", state.facingMode === "user");
    video.hidden = false;
    fallback.hidden = true;
    try {
      await video.play();
    } catch {
      await delay(50);
      await video.play();
    }
  } catch (err) {
    console.warn("Camera unavailable:", err);
    video.hidden = true;
    fallback.hidden = false;
  }
}

async function stopCamera(clearVideo = true, { releaseLock = true } = {}) {
  if (releaseLock) releaseWakeLock();
  if (state.countdown) {
    clearInterval(state.countdown);
    state.countdown = null;
    $("#countdown").hidden = true;
  }
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
  if (clearVideo) {
    const video = $("#camera");
    video.srcObject = null;
  }
}

/** Hide the review still and make sure the live preview is playing. */
async function ensureLivePreview({ restart = false } = {}) {
  hideReview();
  const video = $("#camera");
  const live = !restart && streamIsLive(state.stream) && video.srcObject === state.stream;
  if (live) {
    video.hidden = false;
    try {
      await video.play();
    } catch {
      await startCamera();
    }
    return;
  }
  await startCamera();
}

async function flipCamera() {
  state.facingMode = state.facingMode === "user" ? "environment" : "user";
  await startCamera();
}

function cycleTimer() {
  const opts = [0, 3, 5, 10];
  const i = opts.indexOf(state.timerSec);
  state.timerSec = opts[(i + 1) % opts.length];
  renderCaptureChrome();
}

async function onShutter() {
  if (state.reviewing) return;
  if (state.countdown) return;
  if (!$("#camera").srcObject) {
    ($("#file-input-camera") || $("#file-input")).click();
    return;
  }
  if (state.timerSec) {
    await runTimer(state.timerSec);
  }
  await captureFrame();
}

function runTimer(seconds) {
  return new Promise((resolve) => {
    const el = $("#countdown");
    let left = seconds;
    el.textContent = String(left);
    el.hidden = false;
    state.countdown = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(state.countdown);
        state.countdown = null;
        el.hidden = true;
        resolve();
      } else {
        el.textContent = String(left);
      }
    }, 1000);
  });
}

async function captureFrame() {
  const video = $("#camera");
  if (!video.srcObject || !video.videoWidth) {
    toast("Camera isn’t ready yet");
    return;
  }
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  // Preview is mirrored for the front camera, but we save the unmirrored frame
  // so comparisons stay consistent with rear-camera angles.
  ctx.drawImage(video, 0, 0);
  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("capture failed"))), "image/jpeg", 0.95)
  );
  await enterReview(blob, { mirrored: state.facingMode === "user" });
}

async function enterReview(blob, { mirrored = false } = {}) {
  state.reviewing = true;
  state.reviewBlob = blob;
  const canvas = $("#freeze-canvas");
  const bmp = await createImageBitmap(blob);
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext("2d").drawImage(bmp, 0, 0);
  bmp.close();
  canvas.classList.toggle("is-front", !!mirrored);
  canvas.hidden = false;
  $("#review-bar").hidden = false;
  $(".capture-dock").hidden = true;
  $("#btn-skip").hidden = true;
}

function hideReview() {
  state.reviewing = false;
  state.reviewBlob = null;
  const canvas = $("#freeze-canvas");
  canvas.hidden = true;
  const ctx = canvas.getContext("2d");
  if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  canvas.width = 1;
  canvas.height = 1;
  $("#review-bar").hidden = true;
  $(".capture-dock").hidden = false;
  $("#btn-skip").hidden = false;
}

async function keepPhoto() {
  if (!state.reviewBlob || !state.sessionId) return;
  try {
    const compressed = await compressImage(state.reviewBlob);
    const angle = ANGLES[state.captureIndex];
    await savePhoto({
      sessionId: state.sessionId,
      angleId: angle.id,
      blob: compressed.blob,
      width: compressed.width,
      height: compressed.height,
    });
    toast(`${angle.short} saved`);
    await gotoNextAngle();
  } catch (err) {
    console.error(err);
    toast("Couldn’t save that photo");
  }
}

async function retake() {
  // Stay on this angle: drop the still and resume the live preview.
  await ensureLivePreview();
}

async function skipAngle() {
  if (state.reviewing) return;
  await gotoNextAngle();
}

async function gotoNextAngle() {
  hideReview();
  if (state.captureIndex < ANGLES.length - 1) {
    state.captureIndex += 1;
    const angle = ANGLES[state.captureIndex];
    state.facingMode = angle.facing || "environment";
    renderCaptureChrome();
    await setupGhostAndGuide();
    // Always restart the stream so a stopped or front/rear-switched camera
    // comes back as a live preview, not the previous still frame.
    await startCamera();
    requestWakeLock();
  } else {
    await stopCamera();
    navigate("#/complete");
  }
}

async function onFileChosen(file) {
  if (!file) return;
  try {
    const compressed = await compressImage(file);
    await enterReview(compressed.blob, { mirrored: false });
  } catch (err) {
    console.error(err);
    toast("Couldn’t read that image");
  }
}

async function renderComplete() {
  const session = await getSession(state.sessionId);
  if (!session) {
    navigate("#/home");
    return;
  }
  const photos = await getPhotosForSession(session.id);
  $("#complete-meta").textContent =
    photos.length === ANGLES.length
      ? `${formatDate(session.date)} · all ${ANGLES.length} angles`
      : `${formatDate(session.date)} · ${photos.length} of ${ANGLES.length} angles. You can add the rest later.`;
  const byAngle = Object.fromEntries(photos.map((p) => [p.angleId, p]));
  $("#complete-thumbs").innerHTML = ANGLES.map((a) => {
    const p = byAngle[a.id];
    if (p) {
      const src = urlFor(p.id, p.blob);
      return `<div class="cell"><img src="${src}" alt="${esc(a.name)}"><span class="cell-label">${esc(a.name)}</span></div>`;
    }
    return `<div class="cell empty">${esc(a.short)} skipped</div>`;
  }).join("");
  const notes = $("#complete-notes");
  notes.value = session.notes || "";
  notes.oninput = debounce(() => saveSessionNotes(session.id, notes.value), 400);
  $("#btn-complete-done").onclick = async () => {
    await saveSessionNotes(session.id, notes.value);
    navigate("#/home");
  };
}

/* ---------- compare ---------- */

async function renderCompare() {
  const angleSel = $("#compare-angle");
  if (!angleSel.options.length) {
    angleSel.innerHTML = ANGLES.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join("");
  }
  const dates = await refreshCompareDates();
  if (dates.length >= 2 && !$("#compare-date-a").dataset.touched) {
    $("#compare-date-a").value = dates[0].sessionId;
    $("#compare-date-b").value = dates[dates.length - 1].sessionId;
  }
  await drawCompare();
}

async function refreshCompareDates() {
  const angleId = $("#compare-angle").value || ANGLES[0].id;
  const photos = await getPhotosForAngle(angleId);
  const sessions = await getAllSessions();
  const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));
  const dates = [];
  const seen = new Set();
  for (const p of photos) {
    const s = byId[p.sessionId];
    if (!s || seen.has(s.date)) continue;
    seen.add(s.date);
    dates.push({ date: s.date, sessionId: s.id, photo: p });
  }
  dates.sort((a, b) => a.date.localeCompare(b.date));
  const fill = (sel, prefer) => {
    const current = prefer ?? sel.value;
    sel.innerHTML = dates.length
      ? dates.map((d) => `<option value="${d.sessionId}">${esc(formatDateShort(d.date))}</option>`).join("")
      : `<option value="">No photos yet</option>`;
    if (current && [...sel.options].some((o) => o.value === current)) sel.value = current;
  };
  fill($("#compare-date-a"));
  fill($("#compare-date-b"));
  return dates;
}

async function applyFirstLatest() {
  const dates = await refreshCompareDates();
  if (dates.length < 2) {
    toast("Need at least two dates for this angle");
    return;
  }
  $("#compare-date-a").value = dates[0].sessionId;
  $("#compare-date-b").value = dates[dates.length - 1].sessionId;
  await drawCompare();
}

async function drawCompare() {
  const stage = $("#compare-stage");
  const angleId = $("#compare-angle").value;
  const idA = $("#compare-date-a").value;
  const idB = $("#compare-date-b").value;
  if (!idA || !idB) {
    stage.innerHTML = `<div class="compare-empty">Log the same angle on two different days to compare them here.</div>`;
    return;
  }
  const [sessionA, sessionB] = await Promise.all([getSession(idA), getSession(idB)]);
  const [photosA, photosB] = await Promise.all([getPhotosForSession(idA), getPhotosForSession(idB)]);
  const pA = photosA.find((p) => p.angleId === angleId);
  const pB = photosB.find((p) => p.angleId === angleId);
  if (!pA || !pB) {
    stage.innerHTML = `<div class="compare-empty">One of those dates is missing this angle.</div>`;
    return;
  }
  const srcA = urlFor("cmp-a", pA.blob);
  const srcB = urlFor("cmp-b", pB.blob);
  const labelA = formatDateShort(sessionA.date);
  const labelB = formatDateShort(sessionB.date);

  if (state.compareMode === "slider") {
    stage.innerHTML = `
      <div class="slider-wrap" id="slider-wrap">
        <img src="${srcB}" alt="After ${esc(labelB)}">
        <div class="slider-before" id="slider-before" style="width:50%">
          <img src="${srcA}" alt="Before ${esc(labelA)}" id="slider-before-img">
        </div>
        <div class="slider-handle" id="slider-handle" style="left:50%">
          <span class="slider-knob" aria-hidden="true">
            <svg viewBox="0 0 32 32" width="18" height="18"><path d="M12 8 6 16l6 8M20 8l6 8-6 8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </span>
        </div>
        <figcaption style="left:8px">${esc(labelA)}</figcaption>
        <figcaption style="left:auto;right:8px">${esc(labelB)}</figcaption>
      </div>`;
    wireSlider();
  } else {
    stage.innerHTML = `
      <div class="side-by-side">
        <figure><img src="${srcA}" alt="Before ${esc(labelA)}"><figcaption>${esc(labelA)}</figcaption></figure>
        <figure><img src="${srcB}" alt="After ${esc(labelB)}"><figcaption>${esc(labelB)}</figcaption></figure>
      </div>`;
  }
}

function wireSlider() {
  const wrap = $("#slider-wrap");
  const before = $("#slider-before");
  const handle = $("#slider-handle");
  const beforeImg = $("#slider-before-img");
  if (!wrap) return;

  const syncWidth = () => {
    beforeImg.style.width = wrap.clientWidth + "px";
    beforeImg.style.height = wrap.clientHeight + "px";
  };
  syncWidth();
  new ResizeObserver(syncWidth).observe(wrap);

  const setPos = (clientX) => {
    const rect = wrap.getBoundingClientRect();
    let pct = ((clientX - rect.left) / rect.width) * 100;
    pct = Math.min(96, Math.max(4, pct));
    before.style.width = pct + "%";
    handle.style.left = pct + "%";
  };

  let dragging = false;
  const down = (e) => {
    dragging = true;
    wrap.setPointerCapture?.(e.pointerId);
    setPos(e.clientX);
    e.preventDefault();
  };
  const move = (e) => {
    if (!dragging) return;
    setPos(e.clientX);
  };
  const up = () => {
    dragging = false;
  };
  handle.addEventListener("pointerdown", down);
  wrap.addEventListener("pointerdown", down);
  wrap.addEventListener("pointermove", move);
  wrap.addEventListener("pointerup", up);
  wrap.addEventListener("pointercancel", up);
}

/* ---------- settings / backup ---------- */

async function renderSettings() {
  const interval = Number(await getSetting("intervalDays", 7)) || 7;
  state.intervalDays = interval;
  $("#interval-value").textContent = String(interval);
  const { bytes, count, quota } = await estimateStorage();
  const mb = (bytes / (1024 * 1024)).toFixed(bytes > 1024 * 1024 ? 1 : 2);
  let text = `${count} photo${count === 1 ? "" : "s"} · ${mb} MB on this device`;
  if (quota?.quota) {
    const usedMb = ((quota.usage || bytes) / (1024 * 1024)).toFixed(1);
    const totMb = (quota.quota / (1024 * 1024)).toFixed(0);
    text += ` · site storage ${usedMb} / ${totMb} MB`;
  }
  $("#storage-usage").textContent = text;
  const inst = $("#btn-settings-install");
  inst.hidden = !state.deferredPrompt;
}

async function changeInterval(delta) {
  let n = Number(await getSetting("intervalDays", 7)) || 7;
  n = Math.min(60, Math.max(1, n + delta));
  await setSetting("intervalDays", n);
  $("#interval-value").textContent = String(n);
  state.intervalDays = n;
}

async function doExport() {
  try {
    toast("Preparing backup…", 4000);
    const blob = await exportBackup();
    const a = document.createElement("a");
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = `hair-track-backup-${todayISO()}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast("Backup downloaded");
  } catch (err) {
    console.error(err);
    toast("Export failed");
  }
}

async function doImport(file) {
  if (!file) return;
  try {
    toast("Importing…", 4000);
    const result = await importBackup(file);
    toast(`Imported ${result.photos} photos from ${result.sessions} sessions`);
    await renderSettings();
  } catch (err) {
    console.error(err);
    toast(err.message || "Import failed");
  }
}

/* ---------- install / wake lock / sw ---------- */

function maybeShowInstall() {
  const banner = $("#home-install");
  const dismissed = localStorage.getItem("installDismissed") === "1";
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  banner.hidden = standalone || dismissed || !state.deferredPrompt;
  $("#btn-settings-install").hidden = !state.deferredPrompt || standalone;
}

async function promptInstall() {
  const ev = state.deferredPrompt;
  if (!ev) {
    toast("Use Chrome’s menu: Install app, or Add to Home screen");
    return;
  }
  ev.prompt();
  try {
    await ev.userChoice;
  } catch {
    /* ignored */
  }
  state.deferredPrompt = null;
  maybeShowInstall();
}

async function requestWakeLock() {
  try {
    if (navigator.wakeLock) {
      state.wakeLock = await navigator.wakeLock.request("screen");
      state.wakeLock.addEventListener("release", () => {
        state.wakeLock = null;
      });
    }
  } catch {
    /* unsupported or denied */
  }
}

function releaseWakeLock() {
  state.wakeLock?.release().catch(() => {});
  state.wakeLock = null;
}

function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  const swUrl = new URL("../sw.js", import.meta.url);
  navigator.serviceWorker.register(swUrl.href).catch((err) => {
    console.warn("SW registration failed:", err);
  });
  // Reload once when a new worker takes control so the phone picks up the
  // bumped cache. Only listen if a worker already controls this page, so
  // the first install doesn't reload immediately after clients.claim().
  if (navigator.serviceWorker.controller) {
    let refreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshing) return;
      refreshing = true;
      location.reload();
    });
  }
}

/* ---------- events ---------- */

function bindEvents() {
  window.addEventListener("hashchange", route);
  $("#btn-start-session").addEventListener("click", () => startSessionForDate(todayISO()));
  $("#btn-other-date").addEventListener("click", () => {
    const picker = $("#date-picker");
    picker.value = todayISO();
    picker.max = todayISO();
    const onChange = async () => {
      picker.removeEventListener("change", onChange);
      if (picker.value) await startSessionForDate(picker.value);
    };
    picker.addEventListener("change", onChange);
    if (typeof picker.showPicker === "function") picker.showPicker();
    else picker.click();
  });

  $("#btn-install").addEventListener("click", promptInstall);
  $("#btn-settings-install").addEventListener("click", promptInstall);
  $("#btn-install-dismiss").addEventListener("click", () => {
    localStorage.setItem("installDismissed", "1");
    $("#home-install").hidden = true;
  });
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    state.deferredPrompt = e;
    maybeShowInstall();
  });

  $("#btn-capture-close").addEventListener("click", () => navigate("#/home"));
  $("#btn-skip").addEventListener("click", skipAngle);
  $("#btn-shutter").addEventListener("click", onShutter);
  $("#btn-flip").addEventListener("click", flipCamera);
  $("#btn-timer").addEventListener("click", cycleTimer);
  $("#btn-retake").addEventListener("click", retake);
  $("#btn-keep").addEventListener("click", keepPhoto);
  const onFileInput = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) await onFileChosen(file);
  };
  $("#btn-choose-file").addEventListener("click", () => $("#file-input").click());
  $("#btn-pick-photo").addEventListener("click", () => ($("#file-input-camera") || $("#file-input")).click());
  $("#file-input").addEventListener("change", onFileInput);
  const camInput = $("#file-input-camera");
  if (camInput) camInput.addEventListener("change", onFileInput);
  $("#ghost-opacity").addEventListener("input", (e) => {
    const v = Number(e.target.value);
    sessionStorage.setItem("ghostOpacity", String(v));
    $("#ghost").style.opacity = String(v / 100);
  });

  $("#compare-angle").addEventListener("change", async () => {
    const dates = await refreshCompareDates();
    if (dates.length >= 2) {
      $("#compare-date-a").value = dates[0].sessionId;
      $("#compare-date-b").value = dates[dates.length - 1].sessionId;
    }
    await drawCompare();
  });
  $("#compare-date-a").addEventListener("change", () => {
    $("#compare-date-a").dataset.touched = "1";
    drawCompare();
  });
  $("#compare-date-b").addEventListener("change", () => {
    $("#compare-date-b").dataset.touched = "1";
    drawCompare();
  });
  $("#btn-first-latest").addEventListener("click", applyFirstLatest);
  $("#mode-side").addEventListener("click", () => setCompareMode("side"));
  $("#mode-slider").addEventListener("click", () => setCompareMode("slider"));

  $("#interval-dec").addEventListener("click", () => changeInterval(-1));
  $("#interval-inc").addEventListener("click", () => changeInterval(1));
  $("#btn-export").addEventListener("click", doExport);
  $("#btn-import").addEventListener("click", () => $("#import-file").click());
  $("#import-file").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) await doImport(file);
  });

  $("#lightbox-close").addEventListener("click", closeLightbox);
  $("#lightbox").addEventListener("click", (e) => {
    if (e.target.id === "lightbox") closeLightbox();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.view === "capture" && !state.stream && !state.reviewing) {
      startCamera();
      requestWakeLock();
    }
  });
}

function setCompareMode(mode) {
  state.compareMode = mode;
  $("#mode-side").classList.toggle("is-active", mode === "side");
  $("#mode-slider").classList.toggle("is-active", mode === "slider");
  drawCompare();
}

/* ---------- boot ---------- */

async function boot() {
  bindEvents();
  await openDb();
  state.intervalDays = Number(await getSetting("intervalDays", 7)) || 7;
  registerSW();
  await route();
  document.documentElement.dataset.ready = "1";
}

boot().catch((err) => {
  console.error(err);
  toast("Something went wrong starting the app");
  document.documentElement.dataset.ready = "1";
});

// Test/debug hook used by the local Playwright script.
window.HairTrack = {
  ANGLES,
  state,
  navigate,
  startSessionForDate,
  compressImage,
  openDb,
  todayISO,
  getAllSessions,
  upsertSession,
  savePhoto,
  getSetting,
  setSetting,
  getPhotosForSession,
};
