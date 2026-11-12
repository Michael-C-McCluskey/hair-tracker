#!/usr/bin/env node
/**
 * Smoke-test Hair Track in a mobile viewport:
 * manifest + service worker, save/view photos, no unexpected console errors,
 * and 3 screenshots under screenshots/.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SCREENSHOTS = path.join(ROOT, "screenshots");
const FIXTURES = path.join(ROOT, "test-fixtures");
const PORT = Number(process.env.PORT) || 4173;
const BASE = `http://127.0.0.1:${PORT}`;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, BASE);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/index.html";
    const file = path.normalize(path.join(ROOT, pathname));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403);
      return res.end("forbidden");
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("not found");
      }
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(PORT, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
}

function loadFixtures() {
  const dates = ["2026-09-15", "2026-10-20", "2026-11-08"];
  const notes = {
    "2026-09-15": "Baseline. Hair dry, bathroom lighting. Started minoxidil.",
    "2026-10-20": "Five weeks in. Normal shed this week.",
    "2026-11-08": "Same part, same light. Feeling a bit thicker on top.",
  };
  const angles = ["front", "left-temple", "right-temple", "top", "crown", "back"];
  const catalog = [];
  for (const date of dates) {
    for (const angle of angles) {
      const buf = fs.readFileSync(path.join(FIXTURES, `${date}_${angle}.jpg`));
      catalog.push({ date, angle, b64: buf.toString("base64"), notes: notes[date] });
    }
  }
  return { dates, notes, angles, catalog };
}

async function seed(page, fixtures) {
  await page.evaluate(async ({ catalog, notes }) => {
    const HT = window.HairTrack;
    const dates = [...new Set(catalog.map((c) => c.date))];
    for (const date of dates) {
      const session = await HT.upsertSession({ date, notes: notes[date] });
      for (const item of catalog.filter((c) => c.date === date)) {
        const binary = atob(item.b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: "image/jpeg" });
        const compressed = await HT.compressImage(blob);
        await HT.savePhoto({
          sessionId: session.id,
          angleId: item.angle,
          blob: compressed.blob,
          width: compressed.width,
          height: compressed.height,
        });
      }
    }
    await HT.setSetting("intervalDays", 7);
  }, fixtures);
}


async function previewState(page) {
  return page.evaluate(() => {
    const video = document.getElementById("camera");
    const freeze = document.getElementById("freeze-canvas");
    const review = document.getElementById("review-bar");
    const ghost = document.getElementById("ghost");
    const guide = document.getElementById("guide");
    const freezeHidden = !freeze || freeze.hidden || freeze.getClientRects().length === 0;
    const overlay =
      (ghost && !ghost.hidden && ghost.naturalWidth > 0 && Number(getComputedStyle(ghost).opacity) > 0) ||
      (guide && !guide.hidden && !!guide.querySelector("svg"));
    return {
      step: document.getElementById("capture-step")?.textContent || "",
      angle: document.getElementById("capture-angle-name")?.textContent || "",
      videoHidden: !!video?.hidden,
      paused: !!video?.paused,
      readyState: video?.readyState ?? 0,
      hasStream: !!(video && video.srcObject),
      freezeHidden,
      reviewHidden: !review || review.hidden,
      ghost: !!(ghost && !ghost.hidden),
      guide: !!(guide && !guide.hidden),
      overlay,
      live: !!(
        video &&
        !video.hidden &&
        video.srcObject &&
        !video.paused &&
        video.readyState >= 2
      ),
    };
  });
}

async function assertLivePreview(page, pass, label) {
  try {
    await page.waitForFunction(() => {
      const video = document.getElementById("camera");
      const freeze = document.getElementById("freeze-canvas");
      const review = document.getElementById("review-bar");
      const ghost = document.getElementById("ghost");
      const guide = document.getElementById("guide");
      const videoLive =
        video && !video.hidden && video.srcObject && !video.paused && video.readyState >= 2;
      const freezeGone = !freeze || freeze.hidden || freeze.getClientRects().length === 0;
      const reviewGone = !review || review.hidden;
      const overlay =
        (ghost && !ghost.hidden && ghost.naturalWidth > 0) ||
        (guide && !guide.hidden && !!guide.querySelector("svg"));
      return videoLive && freezeGone && reviewGone && overlay;
    }, { timeout: 10000 });
    const info = await previewState(page);
    pass(
      `live preview at ${label}`,
      true,
      `${info.step} ${info.angle}; ghost=${info.ghost} guide=${info.guide}`
    );
    return info;
  } catch (err) {
    const info = await previewState(page).catch(() => ({}));
    pass(`live preview at ${label}`, false, JSON.stringify(info));
    return info;
  }
}

async function main() {
  fs.mkdirSync(SCREENSHOTS, { recursive: true });
  const server = await startServer();
  const errors = [];
  const warnings = [];
  const chrome =
    process.env.CHROME_PATH ||
    ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) =>
      fs.existsSync(p)
    );

  const browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-gpu",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 412, height: 892 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    colorScheme: "dark",
  });

  await context.addInitScript(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 720;
    canvas.height = 1280;
    const ctx = canvas.getContext("2d");
    const draw = () => {
      ctx.fillStyle = "#241c18";
      ctx.fillRect(0, 0, 720, 1280);
      const t = Date.now() / 700;
      ctx.fillStyle = "#4a342c";
      ctx.beginPath();
      ctx.ellipse(360, 620 + Math.sin(t) * 4, 170, 230, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#c4a080";
      ctx.beginPath();
      ctx.ellipse(360, 470, 175, 90, 0, Math.PI, Math.PI * 2, true);
      ctx.fill();
      ctx.fillStyle = "#2a1c18";
      ctx.beginPath();
      ctx.ellipse(310, 600, 16, 10, 0, 0, Math.PI * 2);
      ctx.ellipse(410, 600, 16, 10, 0, 0, Math.PI * 2);
      ctx.fill();
    };
    draw();
    const timer = setInterval(draw, 80);
    const stream = canvas.captureStream(12);
    if (navigator.mediaDevices) {
      navigator.mediaDevices.getUserMedia = async () => stream;
      navigator.mediaDevices.enumerateDevices = async () => [
        { deviceId: "front", kind: "videoinput", label: "Fake Front Camera", groupId: "cam" },
        { deviceId: "back", kind: "videoinput", label: "Fake Rear Camera", groupId: "cam" },
      ];
    }
    window.__fakeCamTimer = timer;
  });

  const page = await context.newPage();
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error") errors.push(`console.error: ${text}`);
    if (msg.type() === "warning") warnings.push(text);
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));

  const failures = [];
  const pass = (name, ok, detail) => {
    const line = `${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`;
    console.log(line);
    if (!ok) failures.push(line);
  };

  try {
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.documentElement.dataset.ready === "1", { timeout: 15000 });
    pass("app boots", true);

    const manifest = await page.evaluate(async () => {
      const link = document.querySelector('link[rel="manifest"]');
      if (!link) return null;
      const res = await fetch(link.href);
      if (!res.ok) return { ok: false, status: res.status };
      const json = await res.json();
      return { ok: true, json };
    });
    pass("manifest link + fetch", !!(manifest && manifest.ok), manifest?.json?.name);
    pass(
      "manifest is installable",
      !!(manifest?.json?.icons?.length && manifest.json.display === "standalone" && manifest.json.start_url),
      `display=${manifest?.json?.display}`
    );

    const sw = await page.evaluate(async () => {
      if (!("serviceWorker" in navigator)) return { supported: false };
      const reg = await navigator.serviceWorker.register(new URL("sw.js", location.href).href);
      const ready = await navigator.serviceWorker.ready;
      return {
        supported: true,
        registered: !!reg,
        active: !!ready.active,
        scope: ready.scope,
      };
    });
    pass("service worker registers", !!(sw.supported && sw.registered && sw.active), sw.scope);

    const fixtures = loadFixtures();
    await seed(page, fixtures);
    await page.evaluate(() => location.hash = "#/home");
    await page.waitForTimeout(200);
    await page.waitForFunction(() => document.querySelector("#home-reminder .days")?.textContent?.trim(), {
      timeout: 8000,
    });

    const homeCopy = await page.textContent("#home-reminder");
    pass("home shows days since last session", /days since/i.test(homeCopy || ""), (homeCopy || "").replace(/\s+/g, " ").slice(0, 80));

    const dismiss = page.locator("#btn-install-dismiss");
    if (await dismiss.isVisible()) await dismiss.click();
    await page.waitForFunction(() => {
      const imgs = [...document.querySelectorAll("#home-last-session img")];
      return imgs.length >= 6 && imgs.every((i) => i.naturalWidth > 0);
    }, { timeout: 8000 });
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(SCREENSHOTS, "home.png"), fullPage: false });
    pass("screenshot home", fs.existsSync(path.join(SCREENSHOTS, "home.png")));

    // Start today's session — first angle (front) should show Nov 8 ghost overlay
    await page.click("#btn-start-session");
    await page.waitForSelector("#view-capture:not([hidden])", { timeout: 8000 });
    await page.waitForFunction(() => {
      const ghost = document.getElementById("ghost");
      const video = document.getElementById("camera");
      return ghost && !ghost.hidden && ghost.naturalWidth > 0 && video && (video.readyState >= 2 || video.srcObject);
    }, { timeout: 10000 });
    // Let the overlay settle
    await page.waitForTimeout(400);
    const ghostVisible = await page.evaluate(() => {
      const g = document.getElementById("ghost");
      const cs = getComputedStyle(g);
      return !g.hidden && Number(cs.opacity) > 0 && g.getBoundingClientRect().height > 100;
    });
    pass("ghost overlay visible on capture", ghostVisible);

    await page.screenshot({ path: path.join(SCREENSHOTS, "capture-ghost.png"), fullPage: false });
    pass("screenshot capture", fs.existsSync(path.join(SCREENSHOTS, "capture-ghost.png")));

    // Walk the first three angles: each must show a live playing video plus
    // ghost/guide, not the previous still. Also verify Retake resumes live preview.
    await assertLivePreview(page, pass, "angle 1");
    await page.click("#btn-shutter");
    await page.waitForSelector("#review-bar:not([hidden])", { timeout: 8000 });
    await page.click("#btn-retake");
    await assertLivePreview(page, pass, "angle 1 after retake");
    await page.click("#btn-shutter");
    await page.waitForSelector("#review-bar:not([hidden])", { timeout: 8000 });
    await page.click("#btn-keep");
    await page.waitForFunction(() => (document.getElementById("capture-step")?.textContent || "").startsWith("2 of"), { timeout: 8000 });
    await assertLivePreview(page, pass, "angle 2");
    await page.click("#btn-shutter");
    await page.waitForSelector("#review-bar:not([hidden])", { timeout: 8000 });
    await page.click("#btn-keep");
    await page.waitForFunction(() => (document.getElementById("capture-step")?.textContent || "").startsWith("3 of"), { timeout: 8000 });
    await assertLivePreview(page, pass, "angle 3");

    const saved = await page.evaluate(async () => {
      const HT = window.HairTrack;
      const sessions = await HT.getAllSessions();
      const today = HT.todayISO();
      const todays = sessions.find((s) => s.date === today);
      if (!todays) return { today: false };
      const photos = await HT.getPhotosForSession(todays.id);
      return { today: true, sessionId: todays.id, count: photos.length, angles: photos.map((p) => p.angleId) };
    });
    pass("saving a captured photo works", !!(saved.today && saved.count >= 2 && saved.angles.includes("front")), JSON.stringify(saved));

    // Compare view
    await page.evaluate(() => (location.hash = "#/compare"));
    await page.waitForSelector("#view-compare:not([hidden])", { timeout: 8000 });
    await page.waitForTimeout(300);
    // Prefer crown — density change is obvious — then slider mode
    await page.selectOption("#compare-angle", "crown");
    await page.waitForTimeout(200);
    await page.click("#mode-slider");
    await page.waitForSelector("#slider-wrap", { timeout: 8000 });
    await page.waitForFunction(() => {
      const imgs = [...document.querySelectorAll("#compare-stage img")];
      return imgs.length >= 2 && imgs.every((i) => i.naturalWidth > 0);
    }, { timeout: 8000 });
    await page.waitForFunction(() => {
      const t = document.getElementById("toast");
      return !t || t.hidden;
    }, { timeout: 5000 });
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(SCREENSHOTS, "compare.png"), fullPage: false });
    pass("screenshot compare", fs.existsSync(path.join(SCREENSHOTS, "compare.png")));
    const compareOk = await page.evaluate(() => !!document.getElementById("slider-wrap"));
    pass("compare slider renders first vs latest", compareOk);

    // Viewing from timeline
    await page.evaluate(() => (location.hash = "#/timeline"));
    await page.waitForSelector("#view-timeline:not([hidden])");
    const cardCount = await page.$$eval("#timeline-list .session-card", (els) => els.length);
    pass("timeline lists sessions", cardCount >= 3, `${cardCount} cards`);
    // Newest card may be today's incomplete session; open a completed one.
    await page.locator("#timeline-list .session-card").nth(1).click();
    await page.waitForSelector("#view-session:not([hidden])");
    const cells = await page.$$eval("#session-grid .cell img", (els) => els.length);
    pass("session detail shows photos", cells >= 6, `${cells} images`);

    const unexpected = errors.filter((e) => {
      // Benign: some Chrome installs log about service worker cache or DevTools
      if (/Deprecated/i.test(e)) return false;
      return true;
    });
    pass("no console/page errors", unexpected.length === 0, unexpected.join(" | ") || "clean");

    if (warnings.length) {
      console.log("warnings:", warnings.slice(0, 8).join(" | "));
    }
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }

  console.log("");
  if (failures.length) {
    console.error(`${failures.length} check(s) failed.`);
    process.exit(1);
  }
  console.log("All checks passed.");
  console.log("Screenshots:");
  for (const name of ["home.png", "capture-ghost.png", "compare.png"]) {
    const p = path.join(SCREENSHOTS, name);
    const st = fs.statSync(p);
    console.log(`  ${p}  (${st.size} bytes)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
