# Deployment

The server is a single Node >= 20 process with **no npm dependencies**. It serves the client, the engine modules (the same files the server uses for replay) and a small JSON API.

## Run

```bash
npm run build                       # optional: self-contained dist/ + BUILD.json
PORT=8080 DATA_DIR=/var/lib/tbl API_TOKEN=<long random string> node src/server/server.js
```

| Variable | Default | Meaning |
|---|---|---|
| `PORT`, `HOST` | 8080, 0.0.0.0 | Listen address |
| `DATA_DIR` | `./data` | Session store (atomic JSON files). Mount a persistent volume |
| `API_TOKEN` | unset | Enables instructor endpoints (`GET /api/sessions`, `?log=1`) with `Authorization: Bearer <token>`. Unset = those endpoints return 403 |
| `TRUST_PROXY` | unset | Set to `1` behind a reverse proxy you control: the first `X-Forwarded-For` entry becomes the client address for rate limiting. Leave unset when the server is directly exposed (the header is client-controlled) |
| `WEB_DIR` | `src/web` | Serve a different client directory |
| `LOG_LEVEL` | info | `debug` logs each request |

## Docker

```bash
docker build -t tidal-bedside-lab .
docker run -d --name tbl -p 8080:8080 -v tbl-data:/data -e API_TOKEN=... tidal-bedside-lab
```
The image runs as the unprivileged `node` user and has a `/api/health` health check. **The Dockerfile was written but not build-tested in the authoring environment** (no Docker daemon/network); run `bash scripts/docker-smoke.sh` once on a machine with Docker (the `docker` job in `.github/workflows/ci.yml` does the same on every push) before relying on it. The script builds the image, starts it, and checks the health endpoint, the `Cache-Control: no-cache` header, the token-gated instructor API, session creation and the container health status.

## Reverse proxy and TLS

Terminate TLS (and, for exams, authentication/SSO) in a reverse proxy such as nginx, Caddy or your hospital gateway. Set `TRUST_PROXY=1` and forward `X-Forwarded-For`; otherwise every learner behind the proxy shares one socket address and the built-in limit (120 API requests/minute per client address) would throttle the whole class. Example nginx location:

```nginx
location / { proxy_pass http://127.0.0.1:8080; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; client_max_body_size 2m; }
```
The app sets a strict CSP (`script-src 'self'`), `X-Frame-Options: DENY`, `nosniff`, no-referrer and a restrictive Permissions-Policy. Static files use `Cache-Control: no-cache` with ETags, so a new release is picked up immediately and the client and engine can never be a stale mix.

## Capacity

Interactive play runs entirely in the browser; the server only creates sessions and verifies submissions. Verification replays the log in a worker thread (default 2 concurrent, queue 20, 120 s timeout; a 15-minute session replays in well under a second on a laptop). One small VM serves a class of several hundred.

## Operations

- **Backups**: copy `DATA_DIR`. **Retention**: delete old session files according to your policy; they contain pseudonymous learner IDs, scores and event logs.
- **Upgrades**: replace the container/folder, restart. In-flight sessions whose engine changed mid-session will report *unverified* on submit; schedule upgrades outside exam windows.
- **Monitoring**: `GET /api/health` returns status, version, uptime. Logs are JSON lines on stdout.
- **Browser requirements**: evergreen Chrome/Edge/Firefox/Safari with WebGL2 for the 3D view; without it the 3D view is disabled and everything else works.
