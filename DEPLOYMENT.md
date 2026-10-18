# Deployment checklist — EVEL LumaGlass Studio

1. Add the `media-studio/` directory from this bundle to the root of your GitHub repository. Keep the existing application and files; do not replace the repository.
2. Copy `media-studio/.env.example` to `media-studio/.env`, and replace `API_ACCESS_TOKEN` with a long random secret. Do not commit `.env`.
3. Install Docker Engine and Docker Compose on your server. From the repository root, run `docker compose -f media-studio/docker-compose.yml up --build -d`.
4. Put the service behind HTTPS if it is public. The Compose file publishes the API/UI port on 8000; Redis remains private inside the Compose network.
5. Open `/api/health`. Confirm the `queue` and `ffmpeg` flags are true. R2 is optional; when configured the `r2_enabled` flag becomes true.
6. Open the LumaGlass website and go to **إعدادات الوصول** at the bottom. Paste the exact `API_ACCESS_TOKEN` value and save it in that browser.
7. Do not turn on direct URL import for arbitrary domains. Set `ALLOWED_DIRECT_HOSTS` only to exact domains you own or have permission to fetch from.

The `.github/workflows/lumaglass-checks.yml` file in this bundle is meant to be copied to the repository-level `.github/workflows/` directory. It validates the source and builds the container image on GitHub Actions.

R2 secrets must stay in the server's environment file or secret manager, never in the frontend. Use a bucket lifecycle rule to expire temporary outputs.
