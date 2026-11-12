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
  ".wasm": "application/wasm",
  ".task": "application/octet-stream",
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
      navigator.mediaDevices.getUserMedia = async () => { const canvas = document.createElement('canvas'); canvas.width=720; canvas.height=1280; const ctx=canvas.getContext('2d'); const draw=()=>{ctx.fillStyle='#241c18';ctx.fillRect(0,0,720,1280);ctx.fillStyle='#4a342c';ctx.beginPath();ctx.ellipse(360,620,170,230,0,0,Math.PI*2);ctx.fill();ctx.fillStyle='#c4a080';ctx.beginPath();ctx.ellipse(360,470,175,90,0,Math.PI,Math.PI*2,true);ctx.fill();ctx.fillStyle='#2a1c18';ctx.beginPath();ctx.ellipse(310,600,16,10,0,0,Math.PI*2);ctx.ellipse(410,600,16,10,0,0,Math.PI*2);ctx.fill();}; draw(); setInterval(draw,80); return canvas.captureStream(12); };
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

    // Layout + per-angle guides at a Pixel-with-nav-bar viewport, then a short one.
    const layoutPage = await (async () => {
      const ctx = await browser.newContext({
        viewport: { width: 412, height: 780 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        userAgent:
          "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
        colorScheme: "dark",
      });
      await ctx.addInitScript(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 720;
        canvas.height = 1280;
        const c = canvas.getContext("2d");
        const draw = () => {
          c.fillStyle = "#241c18";
          c.fillRect(0, 0, 720, 1280);
          c.fillStyle = "#4a342c";
          c.beginPath();
          c.ellipse(360, 620, 170, 230, 0, 0, Math.PI * 2);
          c.fill();
          c.fillStyle = "#c4a080";
          c.beginPath();
          c.ellipse(360, 470, 175, 90, 0, Math.PI, Math.PI * 2, true);
          c.fill();
        };
        draw();
        const stream = canvas.captureStream(12);
        setInterval(draw, 80);
        if (navigator.mediaDevices) {
          navigator.mediaDevices.getUserMedia = async () => { const canvas = document.createElement('canvas'); canvas.width=720; canvas.height=1280; const ctx=canvas.getContext('2d'); const draw=()=>{ctx.fillStyle='#241c18';ctx.fillRect(0,0,720,1280);ctx.fillStyle='#4a342c';ctx.beginPath();ctx.ellipse(360,620,170,230,0,0,Math.PI*2);ctx.fill();ctx.fillStyle='#c4a080';ctx.beginPath();ctx.ellipse(360,470,175,90,0,Math.PI,Math.PI*2,true);ctx.fill();ctx.fillStyle='#2a1c18';ctx.beginPath();ctx.ellipse(310,600,16,10,0,0,Math.PI*2);ctx.ellipse(410,600,16,10,0,0,Math.PI*2);ctx.fill();}; draw(); setInterval(draw,80); return canvas.captureStream(12); };
        }
      });
      const p2 = await ctx.newPage();
      p2.on("pageerror", (err) => errors.push(`layout pageerror: ${err.message}`));
      return p2;
    })();

    await layoutPage.goto(BASE + "/", { waitUntil: "networkidle" });
    await layoutPage.waitForFunction(() => document.documentElement.dataset.ready === "1", { timeout: 15000 });
    await seed(layoutPage, fixtures);
    await layoutPage.evaluate(() => {
      sessionStorage.setItem("showGuide", "1");
      location.hash = "#/home";
    });
    await layoutPage.waitForTimeout(200);
    await layoutPage.click("#btn-start-session");
    await layoutPage.waitForSelector("#view-capture:not([hidden])", { timeout: 8000 });
    await layoutPage.waitForFunction(() => document.querySelector("#guide svg[data-angle]"), { timeout: 8000 });

    const controlsVisible = async (label) => {
      const info = await layoutPage.evaluate(() => {
        const vh = window.innerHeight;
        const vw = window.innerWidth;
        return ["btn-flip", "btn-shutter", "btn-timer", "btn-choose-file", "btn-guide"].map((id) => {
          const el = document.getElementById(id);
          if (!el) return { id, missing: true };
          const r = el.getBoundingClientRect();
          const visible =
            r.width > 0 &&
            r.height > 0 &&
            r.top >= 0 &&
            r.left >= 0 &&
            r.bottom <= vh + 0.5 &&
            r.right <= vw + 0.5;
          return { id, visible, bottom: Math.round(r.bottom), top: Math.round(r.top), vh, vw };
        });
      });
      const hidden = info.filter((i) => i.missing || !i.visible);
      const shutter = info.find((i) => i.id === "btn-shutter");
      pass(
        `capture controls visible at ${label}`,
        hidden.length === 0,
        hidden.length ? JSON.stringify(hidden) : `${shutter?.vw}x${shutter?.vh}, shutter bottom ${shutter?.bottom}`
      );
    };

    await controlsVisible("412x780");

    const shotGuide = async (name, angleId, file) => {
      await layoutPage.waitForFunction(
        (id) => document.querySelector(`#guide svg[data-angle="${id}"]`) && !document.getElementById("guide")?.hidden,
        angleId,
        { timeout: 8000 }
      );
      await layoutPage.waitForTimeout(200);
      await layoutPage.screenshot({ path: path.join(SCREENSHOTS, file), fullPage: false });
      pass(`screenshot ${file}`, fs.existsSync(path.join(SCREENSHOTS, file)));
    };

    await shotGuide("Front", "front", "guide-front.png");
    await layoutPage.click("#btn-skip");
    await shotGuide("Left temple", "left-temple", "guide-left.png");
    await layoutPage.click("#btn-skip"); // right
    await layoutPage.waitForFunction(() => document.querySelector('#guide svg[data-angle="right-temple"]'), { timeout: 8000 });
    await layoutPage.click("#btn-skip"); // top
    await layoutPage.waitForFunction(() => document.querySelector('#guide svg[data-angle="top"]'), { timeout: 8000 });
    await layoutPage.click("#btn-skip"); // crown
    await shotGuide("Crown", "crown", "guide-crown.png");

    // Unique SVG per angle: reset to the first angle, then skip through all six.
    const angleOrder = ["front", "left-temple", "right-temple", "top", "crown", "back"];
    await layoutPage.evaluate(() => {
      const HT = window.HairTrack;
      HT.state.captureIndex = 0;
      if (location.hash !== "#/capture") location.hash = "#/capture";
      else HT.navigate("#/capture");
    });
    await layoutPage.waitForSelector("#view-capture:not([hidden])", { timeout: 8000 });
    await layoutPage.waitForFunction(
      () => document.querySelector('#guide svg[data-angle="front"]'),
      { timeout: 8000 }
    );
    const guideMarks = [];
    for (let i = 0; i < angleOrder.length; i++) {
      await layoutPage.waitForFunction(
        (id) => document.querySelector(`#guide svg[data-angle="${id}"]`),
        angleOrder[i],
        { timeout: 8000 }
      );
      const mark = await layoutPage.evaluate(() => {
        const svg = document.querySelector("#guide svg");
        const ghost = document.getElementById("ghost");
        const guide = document.getElementById("guide");
        return {
          angle: svg?.getAttribute("data-angle") || "",
          markup: svg ? svg.innerHTML : "",
          guideVisible: !!(guide && !guide.hidden && svg),
          ghostVisible: !!(ghost && !ghost.hidden),
          align: document.getElementById("capture-align")?.textContent || "",
        };
      });
      guideMarks.push(mark);
      if (i < 5) await layoutPage.click("#btn-skip");
    }
    const uniqueAngles = new Set(guideMarks.map((m) => m.angle));
    const uniqueSvg = new Set(guideMarks.map((m) => m.markup));
    pass(
      "guide svg unique per angle",
      uniqueAngles.size === 6 && uniqueSvg.size === 6,
      guideMarks.map((m) => m.angle).join(", ")
    );
    pass(
      "guide visible together with ghost",
      guideMarks.every((m) => m.guideVisible && m.ghostVisible),
      guideMarks.map((m) => `${m.angle}:guide=${m.guideVisible},ghost=${m.ghostVisible}`).join("; ")
    );
    pass(
      "alignment instruction per angle",
      guideMarks.every((m) => m.align.length > 10) && new Set(guideMarks.map((m) => m.align)).size >= 5,
      guideMarks.map((m) => m.align.slice(0, 40)).join(" | ")
    );

    // Guide toggle hides the overlay
    await layoutPage.click("#btn-guide");
    const hiddenAfterToggle = await layoutPage.evaluate(() => document.getElementById("guide")?.hidden);
    pass("guide toggle hides overlay", hiddenAfterToggle === true);
    await layoutPage.click("#btn-guide");
    const shownAgain = await layoutPage.evaluate(() => document.getElementById("guide")?.hidden === false);
    pass("guide toggle shows overlay", shownAgain);

    await layoutPage.setViewportSize({ width: 412, height: 700 });
    await layoutPage.waitForTimeout(200);
    await controlsVisible("412x700");

    // --- Video sweep (hands-free) ---
    const assetChecks = await layoutPage.evaluate(async () => {
      const urls = window.HairTrack.SWEEP_ASSET_URLS;
      const paths = [
        new URL("../vendor/mediapipe/vision_bundle.mjs", document.baseURI).href.replace(/\/index\.html$/, "/"),
      ];
      const list = [
        urls.BUNDLE_URL,
        urls.MODEL_URL,
        urls.WASM_DIR.endsWith("/") ? urls.WASM_DIR + "vision_wasm_internal.wasm" : urls.WASM_DIR + "/vision_wasm_internal.wasm",
        urls.WASM_DIR.endsWith("/") ? urls.WASM_DIR + "vision_wasm_internal.js" : urls.WASM_DIR + "/vision_wasm_internal.js",
      ];
      const results = [];
      for (const u of list) {
        const res = await fetch(u);
        results.push({ url: u.split("/").slice(-2).join("/"), status: res.status, type: res.headers.get("content-type") || "", size: (await res.arrayBuffer()).byteLength });
      }
      return results;
    });
    const assetsOk = assetChecks.every((a) => a.status === 200 && a.size > 1000);
    pass("MediaPipe assets load from local paths", assetsOk, JSON.stringify(assetChecks.map((a) => `${a.url}:${a.status}:${a.size}`)));

    await layoutPage.setViewportSize({ width: 412, height: 780 });
    await layoutPage.evaluate(() => (location.hash = "#/home"));
    await layoutPage.waitForSelector("#view-home:not([hidden])", { timeout: 8000 });
    await layoutPage.evaluate(() => { window.HairTrack.state.sweepTestMode = true; });
    await layoutPage.click("#btn-start-sweep");
    await layoutPage.waitForSelector("#view-sweep-setup:not([hidden])", { timeout: 8000 });
    await layoutPage.click("#btn-sweep-go");
    await layoutPage.waitForSelector("#view-sweep:not([hidden])", { timeout: 8000 });
    await layoutPage.waitForFunction(() => {
      const v = document.getElementById("sweep-camera");
      return v && v.videoWidth > 0 && v.readyState >= 2 && !v.paused;
    }, { timeout: 10000 }).catch(() => {});
    await layoutPage.waitForTimeout(300);
    await layoutPage.screenshot({ path: path.join(SCREENSHOTS, "sweep.png"), fullPage: false });
    pass("screenshot sweep.png", fs.existsSync(path.join(SCREENSHOTS, "sweep.png")));

    await layoutPage.waitForSelector("#view-sweep-review:not([hidden])", { timeout: 30000 });
    const review = await layoutPage.evaluate(() => {
      const rows = window.HairTrack.sweep && window.HairTrack.sweep.candidates
        ? Object.fromEntries(Object.entries(window.HairTrack.sweep.candidates).map(([k, v]) => [k, v.length]))
        : {};
      const cards = document.querySelectorAll("#sweep-review-list .sweep-card").length;
      const imgs = document.querySelectorAll("#sweep-review-list img").length;
      return { cards, imgs, rows, mediaPipe: window.HairTrack.sweep.mediaPipe };
    });
    pass(
      "sweep review has 6 angle picks",
      review.cards === 6 && review.imgs >= 6,
      JSON.stringify(review)
    );

    // Swap a candidate if more than one exists, then save.
    const swapped = await layoutPage.evaluate(() => {
      const next = document.querySelector("#sweep-review-list [data-cand][data-dir='1']");
      if (!next) return { skipped: true };
      const before = next.closest(".sweep-card").querySelector(".count")?.textContent;
      next.click();
      return { skipped: false, before };
    });
    if (!swapped.skipped) {
      await layoutPage.waitForTimeout(150);
      const after = await layoutPage.evaluate(() =>
        [...document.querySelectorAll("#sweep-review-list .count")].map((el) => el.textContent)
      );
      pass("sweep review swap candidate", after.some((s) => /pick 2 of/i.test(s || "")), after.join(" | "));
    } else {
      pass("sweep review swap candidate", true, "only one candidate (swap control hidden)");
    }

    await layoutPage.screenshot({ path: path.join(SCREENSHOTS, "sweep-review.png"), fullPage: false });
    pass("screenshot sweep-review.png", fs.existsSync(path.join(SCREENSHOTS, "sweep-review.png")));

    await layoutPage.click("#btn-sweep-save");
    await layoutPage.waitForSelector("#view-complete:not([hidden])", { timeout: 10000 });
    const savedSweep = await layoutPage.evaluate(async () => {
      const HT = window.HairTrack;
      const sessions = await HT.getAllSessions();
      const today = HT.todayISO();
      const todays = sessions.find((s) => s.date === today);
      if (!todays) return { ok: false };
      const photos = await HT.getPhotosForSession(todays.id);
      return { ok: true, count: photos.length, angles: photos.map((p) => p.angleId) };
    });
    pass(
      "sweep save writes a full session",
      !!(savedSweep.ok && savedSweep.count >= 6 && ["front", "left-temple", "right-temple", "top", "crown", "back"].every((a) => savedSweep.angles.includes(a))),
      JSON.stringify(savedSweep)
    );

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
  for (const name of ["home.png", "capture-ghost.png", "compare.png", "guide-front.png", "guide-left.png", "guide-crown.png", "sweep.png", "sweep-review.png"]) {
    const p = path.join(SCREENSHOTS, name);
    const st = fs.statSync(p);
    console.log(`  ${p}  (${st.size} bytes)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
