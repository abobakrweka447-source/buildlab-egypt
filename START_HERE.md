# EVEL LumaGlass Studio — package guide

This package contains a separate media-processing website under `media-studio/`, a GitHub Actions test workflow under `.github/workflows/`, and a Render Blueprint at `render.yaml`.

## Recommended first deployment

- Read `RENDER_DEPLOYMENT.md` for the one-service demo deployment. It runs the site, API, worker, Redis, and FFmpeg together in a Docker container.
- Read `media-studio/DEPLOYMENT.md` for the more robust Docker Compose deployment on a server you control.

## Important

- This is **not** BuildLab Egypt. Keep it in a separate repository; do not overwrite the existing `buildlab-egypt` application.
- The project is not a static-only Vercel app: media processing requires Python, FFmpeg, Redis/RQ, and writable temporary storage.
- The Render free-demo profile uses ephemeral storage. Uploads, results, and queued jobs can be lost on restarts, deploys, or idle spin-down.
- Before exposing the service, keep `REQUIRE_API_KEY=true`, use an unpredictable `API_ACCESS_TOKEN`, and test with small files first.
- The optional `enhance` mode uses conventional sharpening/scaling; it is not AI restoration.

See `media-studio/README.md`, `media-studio/DEPLOYMENT.md`, `RENDER_DEPLOYMENT.md`, and `media-studio/COPYRIGHT.md` for full details.

© 2026 EVEL. All rights reserved for original EVEL project code and design, subject to third-party licenses.
