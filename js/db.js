/** Local IndexedDB store. Nothing is uploaded. */

const DB_NAME = "hair-track";
const DB_VERSION = 1;

export const ANGLES = [
  {
    id: "front",
    name: "Front / hairline",
    short: "Front",
    tip: "Same lighting, hair dry, hairline fully visible. Face the light, chin level.",
    facing: "user",
  },
  {
    id: "left-temple",
    name: "Left temple",
    short: "Left",
    tip: "Turn your left side to the camera. Keep hair pulled back from the temple and the part flat.",
    facing: "environment",
  },
  {
    id: "right-temple",
    name: "Right temple",
    short: "Right",
    tip: "Turn your right side to the camera. Match the distance and height you used on the left.",
    facing: "environment",
  },
  {
    id: "top",
    name: "Top (overhead)",
    short: "Top",
    tip: "Camera above the crown, looking down. Part your hair the same way each time.",
    facing: "environment",
  },
  {
    id: "crown",
    name: "Crown",
    short: "Crown",
    tip: "Aim at the crown / vertex. Use the timer or a second mirror. Same distance and tilt.",
    facing: "environment",
  },
  {
    id: "back",
    name: "Back",
    short: "Back",
    tip: "Camera behind the head, mid-height. Hair down, same style as last time.",
    facing: "environment",
  },
];

export function angleById(id) {
  return ANGLES.find((a) => a.id === id);
}

let dbPromise;

export function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("sessions")) {
          const sessions = db.createObjectStore("sessions", { keyPath: "id" });
          sessions.createIndex("byDate", "date", { unique: true });
        }
        if (!db.objectStoreNames.contains("photos")) {
          const photos = db.createObjectStore("photos", { keyPath: "id" });
          photos.createIndex("bySession", "sessionId", { unique: false });
          photos.createIndex("byAngle", "angleId", { unique: false });
          photos.createIndex("bySessionAngle", ["sessionId", "angleId"], { unique: true });
        }
        if (!db.objectStoreNames.contains("settings")) {
          db.createObjectStore("settings", { keyPath: "key" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(storeNames, mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(storeNames, mode);
        const stores = Object.fromEntries(
          (Array.isArray(storeNames) ? storeNames : [storeNames]).map((n) => [n, t.objectStore(n)])
        );
        let result;
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error("aborted"));
        result = fn(stores, t);
      })
  );
}

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function todayISO(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function formatDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatDateShort(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export async function getSetting(key, fallback) {
  const row = await tx("settings", "readonly", (s) => req(s.settings.get(key)));
  return row ? row.value : fallback;
}

export async function setSetting(key, value) {
  await tx("settings", "readwrite", (s) => s.settings.put({ key, value }));
}

export async function getAllSessions() {
  const list = await tx("sessions", "readonly", (s) => req(s.sessions.getAll()));
  return list.sort((a, b) => b.date.localeCompare(a.date));
}

export async function getSession(id) {
  return tx("sessions", "readonly", (s) => req(s.sessions.get(id)));
}

export async function getSessionByDate(date) {
  return tx("sessions", "readonly", (s) => req(s.sessions.index("byDate").get(date)));
}

export async function upsertSession({ id, date, notes }) {
  const existing = id ? await getSession(id) : await getSessionByDate(date);
  const now = new Date().toISOString();
  const session = existing
    ? { ...existing, date: date ?? existing.date, notes: notes ?? existing.notes, updatedAt: now }
    : { id: id || uid(), date, notes: notes || "", createdAt: now, updatedAt: now };
  await tx("sessions", "readwrite", (s) => s.sessions.put(session));
  return session;
}

export async function saveSessionNotes(id, notes) {
  const session = await getSession(id);
  if (!session) return;
  session.notes = notes;
  session.updatedAt = new Date().toISOString();
  await tx("sessions", "readwrite", (s) => s.sessions.put(session));
  return session;
}

export async function deleteSession(id) {
  await tx(["sessions", "photos"], "readwrite", (s) => {
    s.sessions.delete(id);
    const index = s.photos.index("bySession");
    const r = index.openCursor(IDBKeyRange.only(id));
    r.onsuccess = () => {
      const cursor = r.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
  });
}

export async function getPhotosForSession(sessionId) {
  return tx("photos", "readonly", (s) => req(s.photos.index("bySession").getAll(sessionId)));
}

export async function getPhotosForAngle(angleId) {
  const list = await tx("photos", "readonly", (s) => req(s.photos.index("byAngle").getAll(angleId)));
  return list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getPhoto(sessionId, angleId) {
  return tx("photos", "readonly", (s) =>
    req(s.photos.index("bySessionAngle").get([sessionId, angleId]))
  );
}

export async function getPreviousPhoto(angleId, beforeSessionId, beforeDate) {
  const photos = await getPhotosForAngle(angleId);
  if (!photos.length) return null;
  const sessions = await getAllSessions();
  const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));
  const earlier = photos.filter((p) => {
    if (beforeSessionId && p.sessionId === beforeSessionId) return false;
    const s = byId[p.sessionId];
    if (!s) return false;
    if (beforeDate) return s.date < beforeDate;
    return true;
  });
  if (!earlier.length) return null;
  earlier.sort((a, b) => {
    const da = byId[a.sessionId].date;
    const db = byId[b.sessionId].date;
    return db.localeCompare(da);
  });
  return earlier[0];
}

export async function savePhoto({ sessionId, angleId, blob, width, height }) {
  const existing = await getPhoto(sessionId, angleId);
  const photo = {
    id: existing ? existing.id : uid(),
    sessionId,
    angleId,
    blob,
    width,
    height,
    createdAt: new Date().toISOString(),
  };
  await tx("photos", "readwrite", (s) => s.photos.put(photo));
  return photo;
}

export async function deletePhoto(id) {
  await tx("photos", "readwrite", (s) => s.photos.delete(id));
}

export async function getAllPhotos() {
  return tx("photos", "readonly", (s) => req(s.photos.getAll()));
}

export async function estimateStorage() {
  const photos = await getAllPhotos();
  const bytes = photos.reduce((n, p) => n + (p.blob?.size || 0), 0);
  let quota = null;
  if (navigator.storage?.estimate) {
    try {
      quota = await navigator.storage.estimate();
    } catch {
      /* ignore */
    }
  }
  return { bytes, count: photos.length, quota };
}

/**
 * Compress an image blob/file to JPEG, longest edge ~maxEdge.
 * Honors EXIF orientation via createImageBitmap.
 */
export async function compressImage(source, maxEdge = 1600, quality = 0.85) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(source, { imageOrientation: "from-image" });
  } catch {
    bitmap = await createImageBitmap(source);
  }
  let { width, height } = bitmap;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  width = Math.max(1, Math.round(width * scale));
  height = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Could not compress image"))),
      "image/jpeg",
      quality
    );
  });
  return { blob, width, height };
}

export const BACKUP_VERSION = 1;

export async function exportBackup() {
  if (typeof JSZip === "undefined") throw new Error("JSZip is missing");
  const zip = new JSZip();
  const sessions = await getAllSessions();
  const photos = await getAllPhotos();
  const intervalDays = await getSetting("intervalDays", 7);
  const manifest = {
    version: BACKUP_VERSION,
    app: "hair-track",
    exportedAt: new Date().toISOString(),
    settings: { intervalDays },
    sessions: sessions.map((s) => ({
      id: s.id,
      date: s.date,
      notes: s.notes || "",
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      photos: photos
        .filter((p) => p.sessionId === s.id)
        .map((p) => ({
          id: p.id,
          angleId: p.angleId,
          width: p.width,
          height: p.height,
          createdAt: p.createdAt,
          file: `photos/${s.date}_${p.angleId}.jpg`,
        })),
    })),
  };
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));
  for (const p of photos) {
    const session = sessions.find((s) => s.id === p.sessionId);
    const date = session?.date || "unknown";
    zip.file(`photos/${date}_${p.angleId}.jpg`, p.blob);
  }
  return zip.generateAsync({ type: "blob" });
}

export async function importBackup(file) {
  if (typeof JSZip === "undefined") throw new Error("JSZip is missing");
  const zip = await JSZip.loadAsync(file);
  const manifestFile = zip.file("manifest.json");
  if (!manifestFile) throw new Error("This zip isn’t a Hair Track backup (missing manifest.json).");
  const manifest = JSON.parse(await manifestFile.async("string"));
  if (!manifest.sessions) throw new Error("Backup manifest is missing sessions.");

  let imported = 0;
  for (const s of manifest.sessions) {
    const existing = await getSessionByDate(s.date);
    const session = await upsertSession({
      id: existing?.id,
      date: s.date,
      notes: existing?.notes && !s.notes ? existing.notes : s.notes || existing?.notes || "",
    });
    for (const p of s.photos || []) {
      const entry = zip.file(p.file);
      if (!entry) continue;
      const raw = await entry.async("blob");
      const type = raw.type && raw.type !== "application/octet-stream" ? raw.type : "image/jpeg";
      const blob = raw.type === type ? raw : new Blob([raw], { type });
      const compressed = blob.type === "image/jpeg" && (p.width || 0) <= 1600
        ? { blob, width: p.width, height: p.height }
        : await compressImage(blob);
      await savePhoto({
        sessionId: session.id,
        angleId: p.angleId,
        blob: compressed.blob,
        width: compressed.width,
        height: compressed.height,
      });
      imported += 1;
    }
  }
  if (manifest.settings?.intervalDays) {
    await setSetting("intervalDays", Number(manifest.settings.intervalDays) || 7);
  }
  return { sessions: manifest.sessions.length, photos: imported };
}
