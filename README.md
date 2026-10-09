# Tally v1

Tally is a single-instance, self-hosted finance tracker. Personal ledgers and assistant histories are owner-scoped; goal sharing exposes goal progress and contribution history only. The host operator can access the SQLite file and backups.

## Local development

Requirements: Node.js 20.9+ and npm. This project uses Next.js App Router, SQLite (`better-sqlite3`), and a persistent local `data/` directory.

```sh
npm ci
npm run dev
```

Open `http://localhost:3000`, register the first user (who becomes the admin), then add a financial account. In local development, sessions use a development-only signing secret. Never use that fallback in a deployed instance.

Run checks:

```sh
npm test
npm run typecheck
npm run lint
npm run build
```

## Docker home-server deployment

1. Copy `.env.example` to `.env`, generate a private session secret with `openssl rand -base64 48`, and set `SESSION_SECRET`. Protect `.env` from other host users.
2. Before the first start, create the bind-mount directory and assign it to the image's unprivileged UID: `mkdir -p data && sudo chown 1001:1001 data && sudo chmod 700 data`. If using rootless Docker or user-namespace remapping, use the corresponding host-mapped UID. For an existing data directory, verify ownership and write access for UID 1001 before restarting; avoid changing unrelated host files.
3. If enabling the assistant, configure `CODEX_LB_BASE_URL`, `CODEX_LB_MODEL`, and `CODEX_LB_API_KEY` on the server. Use an OpenAI-compatible Codex-LB base URL (for example, `https://lb.example.com/v1`); Tally sends Chat Completions requests to `/chat/completions`. Keep the key on the server.
   When Codex-LB runs on the same Docker host, use `http://host.docker.internal:2455/v1` and set `CODEX_LB_ALLOW_HTTP=true`. This exception applies only to that Docker host name; use HTTPS for remote providers.
4. Before collecting consent, verify the actual upstream path and its retention/logging behavior. Write an accurate, user-facing summary in `CODEX_LB_PRIVACY_DISCLOSURE`. Tally refuses opt-in unless all provider fields and this disclosure are configured. A changed provider URL, model, or disclosure invalidates existing consent and requires users to opt in again.
5. Run `docker compose up -d --build`. Configure HTTPS and network exposure yourself; do not expose the instance without transport security. Registration is open to anyone who can reach the instance.

For direct HTTP access on a trusted local network, set `TALLY_COOKIE_SECURE=false` in `.env` before starting Docker, then open `http://localhost:43871`. Use `true` when serving Tally over HTTPS; HTTP exposes session cookies to anyone able to observe that traffic.

Login, registration, and reset throttles use `X-Forwarded-For` only when `TALLY_TRUST_PROXY=true`. Behind a trusted reverse proxy, this setting also lets same-origin validation use `X-Forwarded-Host` and `X-Forwarded-Proto`, which is required when the proxy terminates HTTPS. Set it only when the proxy **replaces** incoming `X-Forwarded-For`, `X-Forwarded-Host`, and `X-Forwarded-Proto` with one verified value each (not appended chains), and firewall the app port so clients cannot bypass that proxy. Leave it `false` for direct access; forwarded headers are ignored and direct clients share a conservative server-wide throttle bucket.

SQLite lives at `./data/tally.sqlite`, mounted into the app container. Backups are created safely from the running database at 02:00 Asia/Manila in `./data/backups/`; the scheduler keeps the latest 30 valid snapshots. The app and backup scheduler share the same mounted directory. Do not run multiple app instances against this SQLite file.

### Restore

Restoring a snapshot replaces the live database and can reintroduce private data deleted after that snapshot. Confirm the chosen snapshot and warn affected users before proceeding. Stop both services, remove the live SQLite WAL/SHM sidecars, then restore the snapshot. A stale WAL can contain writes newer than the snapshot and SQLite may replay them into the restored database. Tally runs as UID 1001, so the rootful-Docker commands below use `sudo`; adjust ownership for rootless Docker or user-namespace remapping.

```sh
docker compose stop app backup
sudo cp ./data/tally.sqlite ./data/tally.pre-restore.sqlite # optional rollback copy
sudo rm -f ./data/tally.sqlite-wal ./data/tally.sqlite-shm
sudo cp ./data/backups/<snapshot-name>.sqlite ./data/tally.sqlite
sudo chown 1001:1001 ./data/tally.sqlite
docker compose up -d
```

The app recreates WAL/SHM sidecars on startup. Verify the restored date, users, accounts, goals, and transaction totals before reopening network access.

## Product references

- [Domain context](./CONTEXT.md)
- [Product specification](./spec.md)
- Architectural decisions are recorded in `docs/adr/`.

## Current boundaries

PHP only; money is stored as integer minor units. Dates use Asia/Manila. The assistant is optional and uses typed tool calls; Tally validates ownership and computes any financial facts itself. CLI/Hermes messaging integrations, OCR, budgets, credit cards, multiple currencies, local AI, bank sync, and automatic recommendations are not part of v1.
