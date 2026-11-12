# Hair Track

A mobile-first Progressive Web App for photographing your face and scalp from the same six angles and watching hair growth over a few months. Every photo stays in IndexedDB on the phone. Nothing is uploaded.

## What’s included

- Hands-free **Video sweep**: spoken guidance and beeps while the phone stays propped up; on-device Face Landmarker picks the best still for each angle (or timing + sharpness if the model can’t load).
- Guided capture: Front / hairline, Left temple, Right temple, Top (overhead), Crown, Back
- Live camera via `getUserMedia`, with front/rear toggle and a file-picker fallback
- Ghost overlay of the previous photo for that angle (adjustable opacity), plus a simple head guide when you don’t have a prior shot
- Optional 3 / 5 / 10 second self-timer for awkward angles
- Photos compressed to ~1600px JPEG and stored locally, tagged by session date and angle
- Timeline of sessions, per-session notes, and a compare view (side-by-side, before/after slider, first vs latest)
- Export / import a zip backup (JSZip is vendored in `vendor/`)
- Home-screen reminder with a configurable check-in interval (default 7 days)
- Installable PWA: `manifest.json`, service worker for offline use, maskable icons

## Run it locally

Serve the folder over HTTP (the camera, service worker, and install prompt need a secure context — `localhost` counts):

```bash
cd hair-tracker
python3 -m http.server 4173
```

Then open [http://localhost:4173/](http://localhost:4173/). On a phone on the same network, use your computer’s LAN IP instead of localhost, still over HTTP only if it’s that machine’s localhost; **on a real phone you need HTTPS** (see below).

There is no build step. These are static files.

To run the Playwright smoke test:

```bash
npm install
npm test
```

## Put it on an Android phone

Chrome will only install a PWA from a **HTTPS** origin (or localhost). Easy options:

1. Push this folder to a GitHub repository and enable **GitHub Pages** (Settings → Pages → Deploy from branch, `/` root). If the site is served from a project subpath (`https://user.github.io/repo-name/`), this app already uses relative URLs, so it should work without a rebuild.
2. Any other static HTTPS host (Netlify, Cloudflare Pages, Firebase Hosting, etc.) also works. Upload the contents of this folder; do not put them behind a required login.

Then, on the Android phone:

1. Open the HTTPS URL in **Chrome**.
2. Tap the menu (⋮) → **Install app** or **Add to Home screen**.
3. Open Hair Track from the home screen. After the first visit, it works offline. Photos never leave the device unless you export a backup.

Grant the camera permission when asked. For crown and back shots, use the self-timer and flip to the rear camera, or use “Choose a photo instead” if it’s easier to shoot with the regular camera app.

**Back up occasionally.** Clearing Chrome’s site data, uninstalling the PWA, or switching browsers will delete IndexedDB photos. Use Settings → Export backup.

## Limitations

- There is no cloud sync or account. A backup zip is the only way to move data to a new phone.
- Headless browsers and some desktops have no camera; the file-picker fallback covers that.
- The ghost overlay lines up with `object-fit: cover`. If you change framing a lot between sessions, alignment won’t be perfect — that’s expected; try to stand the same distance from the camera.
- Front-camera preview is mirrored (like a mirror); the saved photo is not, so it compares cleanly with rear-camera angles.
- iOS Safari can install PWAs too, but this project was built and tested with Android in mind.

## File layout

```
index.html            App shell
manifest.json         PWA manifest
sw.js                 Offline service worker
css/styles.css
js/db.js              IndexedDB, compression, backup
js/app.js             UI, camera, compare, settings
js/sweep.js           Hands-free video sweep and frame scoring
vendor/mediapipe/     Face Landmarker wasm + model (loaded lazily, cached offline)
icons/                PNG icons (any + maskable)
fonts/                Vendored Plus Jakarta Sans
vendor/jszip.min.js   Backup zip library
screenshots/          Local test screenshots
scripts/test.mjs      Playwright smoke test
```
