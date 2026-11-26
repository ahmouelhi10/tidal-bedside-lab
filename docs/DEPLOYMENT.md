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
The image runs as the unprivileged `node` user and has a `/api/health` health check. The `docker` job in `.github/workflows/ci.yml` builds the image and runs `bash scripts/docker-smoke.sh` against it on every push (green since 25 November 2026); run the script yourself on a machine with Docker to check a local build. The script builds the image, starts it, and checks the health endpoint, the `Cache-Control: no-cache` header, the token-gated instructor API, session creation and the container health status.

## Reverse proxy and TLS

Terminate TLS (and, for exams, authentication/SSO) in a reverse proxy such as nginx, Caddy or your hospital gateway. Set `TRUST_PROXY=1` and forward `X-Forwarded-For`; otherwise every learner behind the proxy shares one socket address and the built-in limit (120 API requests/minute per client address) would throttle the whole class. Example nginx location:

```nginx
location / { proxy_pass http://127.0.0.1:8080; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; client_max_body_size 2m; }
```
The app sets a strict CSP (`script-src 'self'`), `X-Frame-Options: DENY`, `nosniff`, no-referrer and a restrictive Permissions-Policy. Static files use `Cache-Control: no-cache` with ETags, so a new release is picked up immediately and the client and engine can never be a stale mix.

## Capacity

Interactive play runs entirely in the browser; the server only creates sessions and verifies submissions. Verification replays the log in a worker thread (`LIMITS` in `src/server/server.js`: 2 at a time, 100 more waiting, 120 s timeout, 120 API requests a minute per address). When the queue is full the server answers `503` with `Retry-After`, and the browser sends the case again after 2, 4, 8, 16 and 16 s (`src/web/retry.js`; a refused submit leaves the session open, so this is safe), while the learner fills in the self-assessment.

Measured with `npm run load-test` (25 November 2026; 20-CPU workstation, Node 24; realistic sessions played to the end by the scripted experts, 10-45 minutes of patient time; each burst from distinct addresses, sent through the browser's retry):

| Simultaneous submits | Final answers | Verified | Wait p50 / p95 / max | All done | Throughput | Had to retry |
|---|---|---|---|---|---|---|
| 1 | 1 × 200 | 1 | 0.19 / 0.19 / 0.19 s | 0.19 s | ~310 / min | 0 |
| 8 | 8 × 200 | 8 | 0.89 / 2.41 / 2.41 s | 2.41 s | ~200 / min | 0 |
| 30 | 30 × 200 | 30 | 3.33 / 6.66 / 6.67 s | 6.67 s | ~270 / min | 0 |
| 60 | 60 × 200 | 60 | 6.79 / 13.32 / 13.64 s | 13.64 s | ~265 / min | 0 |
| 102 | 102 × 200 | 102 | 11.47 / 22.06 / 22.98 s | 22.98 s | ~265 / min | 0 |
| 130 | 130 × 200 | 130 | 14.90 / 27.92 / 29.36 s | 29.36 s | ~265 / min | 28 |

- A replay costs about 0.3-0.4 s per hour of patient time here (the longest allowed session, 4 h, 1.3 s), far under the 120 s timeout.
- The queue, not speed, bounds a burst: up to 102 submits at the same moment are all queued; beyond that the extra learners are refused once and get through on a retry. Before this change (queue 20, no retry) a burst of 30 left 8 learners with an error.
- The wait grows with the burst (about 0.23 s per learner ahead in the queue here). The retries cover a minute; a class far larger than the table, on a slow host, could still run out of them and see the error.
- A queued submit holds its log in memory (at most 1 MB each, typically a few kB): 100 waiting is at most ~100 MB.
- A smaller host is slower in proportion to its CPU (a fraction of a core on a small cloud instance: expect several times the waits above); throughput scales with `replayConcurrency` up to the number of cores.
- Not measured: the live instructor channel (Server-Sent Events) under many viewers, and the production host itself (no load was sent to it).

## Operations

- **Backups**: copy `DATA_DIR`. **Retention**: delete old session files according to your policy; they contain pseudonymous learner IDs, scores and event logs.
- **Upgrades**: replace the container/folder, restart. In-flight sessions whose engine changed mid-session will report *unverified* on submit; schedule upgrades outside exam windows.
- **Monitoring**: `GET /api/health` returns status, version, uptime. Logs are JSON lines on stdout.
- **Browser requirements**: evergreen Chrome/Edge/Firefox/Safari with WebGL2 for the 3D view; without it the 3D view is disabled and everything else works.
