# Render deployment (demo profile)

This repository includes `render.yaml` and `media-studio/Dockerfile.render`. They run the UI, FastAPI API, RQ worker, Redis, and FFmpeg inside one Docker web service. This is deliberately a small-demo setup; it avoids the shared-filesystem problem that appears when the API and worker are separate Render services.

## Deploy

1. Put the contents of this package at the root of a **separate** GitHub repository. Do not replace or merge it into BuildLab Egypt.
2. In Render, choose **New → Blueprint**, connect that repository, and apply the Blueprint from `render.yaml`.
3. Wait for the service to finish deploying. Its health endpoint is `/api/health`; `ok`, `queue`, and `ffmpeg` should be `true`.
4. In the Render dashboard, open the service's Environment settings and reveal/copy `API_ACCESS_TOKEN`. Open the live site, go to **إعدادات الوصول**, paste the token, and save it in that browser.
5. Test with a small media file first. Confirm a completed job downloads correctly before using larger files.

## Free-demo limitations

- Render's free web service can spin down after inactivity; the first request after that can be slow.
- The filesystem and this bundled Redis instance are ephemeral. Deploys, restarts, or spin-downs can remove uploads/results or lose queued jobs. Treat this as a demo, not durable storage.
- The 100 MB upload limit is intentionally conservative for the free compute tier. FFmpeg jobs can still hit memory/CPU limits on large or complex media.
- Direct-file URL import is disabled unless an operator explicitly configures `ALLOWED_DIRECT_HOSTS`.
- The UI's `enhance` operation is conventional FFmpeg/Pillow sharpening and scaling, not AI restoration.

For reliable public use, use the standard `Dockerfile` + `docker-compose.yml` on a server with persistent storage, HTTPS, request rate limiting, and appropriate capacity. Configure R2 or another supported storage target if result files need to survive local cleanup. Never commit `.env` or storage credentials.
