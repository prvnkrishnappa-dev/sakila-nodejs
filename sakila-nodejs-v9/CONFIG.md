# Sakila REST API — Configuration Reference (v6)

## Environment Variables

Copy `.env.example` to `.env` and set values for your environment.

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | `development` | `development` \| `production` \| `test` |
| `PORT` | `8080` | TCP port (1–65535) |
| `DB_HOST` | `localhost` | MySQL hostname |
| `DB_PORT` | `3306` | MySQL port |
| `DB_NAME` | `sakila` | Database name |
| `DB_USER` | `root` | Database user |
| `DB_PASSWORD` | _(empty)_ | Required in production (min 8 chars) |
| `DB_SSL` | `false` | Enable TLS for DB connections (`true`/`false`) |
| `DB_POOL_MAX` | `10` | Max pool connections (1–100) |
| `DB_POOL_MIN` | `2` | Min idle connections (0–DB_POOL_MAX) |
| `DB_POOL_ACQUIRE_MS` | `30000` | Pool acquire timeout (ms) |
| `DB_POOL_IDLE_MS` | `10000` | Idle connection release timeout (ms) |
| `DB_CONNECT_RETRIES` | `5` | Startup retry attempts |
| `DB_CONNECT_RETRY_MS` | `2000` | Base retry delay (ms, exponential backoff + jitter) |
| `CORS_ORIGIN` | _(empty)_ | Allowed origin(s), comma-separated http/https URLs |
| `RATE_LIMIT_READ_WINDOW_MS` | `60000` | Read rate-limit window (ms, min 1) |
| `RATE_LIMIT_READ_MAX` | `300` | Max read requests per window per IP |
| `RATE_LIMIT_WRITE_WINDOW_MS` | `60000` | Write rate-limit window (ms, min 1) |
| `RATE_LIMIT_WRITE_MAX` | `60` | Max write requests per window per IP |
| `LOG_LEVEL` | `http` | Winston log level |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Graceful shutdown timeout (ms, min 1) |

## v6 Changelog Summary

- **A7** Rate-limit and timeout env vars now reject 0 and negative values at startup.
- **A8** `parseOrigins()` re-validates each origin at config-build time (double-fence).
- **A9** Cross-field constraint: `DB_POOL_MIN ≤ DB_POOL_MAX`.
- **A10** Local-DB hostname detection uses a `Set` for O(1) lookup.
- **B1** `findByFilmTitle()` replaced N+1 nested include with a single subquery.
- **B2** `findAll()` clamps `limit` to `[1, 200]` — prevents full-table scans.
- **D1** Exponential backoff now includes ±10 % jitter (thundering herd prevention).
- **D2** `DB_SSL=true` enables TLS for database connections.
- **D3** `closeSequelize()` is idempotent under concurrent callers.
- **E4** `SequelizeTimeoutError` (pool exhaustion) → 503 `DB_UNAVAILABLE`.
- **E5** `SequelizeDatabaseError` (query error) → 500 `INTERNAL_ERROR`.
- **M1** `X-Request-Id` header sanitised: CRLF injection and oversized values rejected.
- **R5** `pagination.pages` is `0` (not `Infinity`) when `total = 0`.
- **R6** `PATCH /api/v1/actors/:id` endpoint added (partial update).
- **R7** `withLinks()` uses `Object.assign` to prevent `_links` field clobbering.
- **AP1** `app.set('trust proxy', 1)` in production so rate limiters use real client IP.
- **SV1** Service methods validate `actorId` is a positive integer at the service boundary.
- **SV2** `getAllActors({ page: NaN })` falls back to defaults instead of propagating NaN.
