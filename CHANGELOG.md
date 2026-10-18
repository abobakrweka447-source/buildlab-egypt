# Changelog

## 0.2.2 — 2026-10-18
- Added a Render Blueprint and single-container Docker profile for demo deployment.
- Added process supervision for local Redis, the RQ worker, and FastAPI in the demo container.
- Extended GitHub Actions to build both Docker profiles.
- Added root project README and explicit free-tier storage/resource caveats.

## 0.2.1 — 2026-10-18
- Started the temporary-file cleanup loop during application startup and stopped it cleanly on shutdown.
- Made the health `ok` flag account for the required API key being configured.
- Updated the Compose API healthcheck to verify the health JSON instead of treating any HTTP 200 as healthy.
- Added tests for lifecycle cleanup and fail-closed direct-URL import validation.
- Kept the root preview HTML synchronized with the served `static/index.html`.
