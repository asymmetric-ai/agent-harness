# Hosting the playground — deployment plan (playground.getasym.dev)

Status: **scoping** (2026-07-09). The playground is not a static site — the
run-service orchestrates live clones (provision → setup RPCs → spawn the clone's
**stdio** MCP server → run the agent). Hosting it means hosting the whole stack.
This plan makes the work + cost + risks explicit before any infra or DNS changes.

## Target topology (Railway project `asym-playground`)

```
                         playground.getasym.dev (CNAME → Railway)
                                     │
                          ┌──────────▼───────────┐
                          │  run-service (bun)   │  serves web/ + /run SSE
                          │  bundles the clone    │  spawns slack/linear MCP
                          │  MCP servers (stdio)  │  (SLACK_MCP_CWD/LINEAR_MCP_CWD)
                          └───┬───────────┬───────┘
             SLACK_CLONE_URL  │           │  LINEAR_CLONE_URL
                DATABASE_URL  │           │
                    ┌─────────▼──┐   ┌────▼────────┐
                    │ slack-clone│   │ linear-clone│   (GHCR backend images)
                    │  backend   │   │   backend   │
                    └────┬───┬───┘   └──────┬──────┘
                         │   │              │
                   Postgres  Redis      Postgres        (Railway plugins)
```

Services: **run-service**, **slack-clone-backend**, **linear-clone-backend**,
**Postgres** (shared or per-clone), **Redis**. All on Railway's private network.

## The three real problems (and resolutions)

### 1. Packaging the clone MCP servers into the run-service image
The run-service spawns `bun src/index.ts` inside the monorepo dirs
`apps/{slack,linear}-clone/mcp-server` — they are NOT in this repo, and MCP is
stdio-only (no network transport), so the run-service must **co-locate and spawn
them**. Resolution: a **Dockerfile** in the harness repo that, at build time,
copies both `mcp-server` dirs (source + installed deps) into the image alongside
the run-service, and sets `SLACK_MCP_CWD`/`LINEAR_MCP_CWD` to those paths. Because
they live in the monorepo, the build needs both repos in context — either a
Railway build from the monorepo with the harness vendored in, or a CI step that
assembles a build context. **This cross-repo image is the main new build artifact.**
(The Slack MCP also talks to Postgres directly, so the run-service container needs
`DATABASE_URL` + private-network access to the Slack clone's Postgres.)

### 2. Run isolation on a public, multi-user surface (the crux)
`LocalClonePool` has **no recycle** and, for Slack, provisions against **one shared
workspace** (`admin/provision` reprovisions it). Two concurrent public runs would
corrupt each other (a reprovision resetting state mid-run). Linear is naturally
isolated (each run signs up a fresh user+org+team). Options:
- **(A) Single-flight queue (recommended MVP):** one run executes at a time; others
  queue behind it (with the existing per-IP rate limit + per-run timeout). Correct
  regardless of clone isolation, trivial to add, fine for a low-traffic marketing
  toy. Downside: throughput of 1; a slow run makes others wait (bounded by the
  timeout). Reset Slack state per run via the existing reprovision.
- **(B) Per-run fresh clone (the real fix):** spin/recycle a clone container per run
  — the unbuilt "warm pool + recycle-per-run." Correct + concurrent, but needs
  Docker-in-Railway (awkward) or a real pool service. Multi-day; defer.
- **Decision needed:** ship (A) now, treat (B) as the follow-on. (A) is the only
  thing that makes a public URL safe without building the pool.

### 3. Budget + abuse on the public key
Mostly already built: file-backed **budget circuit-breaker**, per-IP rate limit,
per-run token cap, per-run wall-clock timeout, abort-on-disconnect. To harden:
put `ASYM_PLAYGROUND_KEY` (OpenRouter) in Railway secrets, set a conservative
`ASYM_PLAYGROUND_BUDGET_TOKENS`, and mount the budget-ledger file on a Railway
volume so the breaker survives restarts. Consider BYO-key-only if we don't want any
shared spend on day one.

## Env matrix (run-service)
`PORT`, `SLACK_CLONE_URL`, `SLACK_MCP_CWD`, `DATABASE_URL` (slack clone PG),
`LINEAR_CLONE_URL`, `LINEAR_MCP_CWD`, `ASYM_PLAYGROUND_KEY`,
`ASYM_PLAYGROUND_MODEL`/`_BASE_URL`, `ASYM_PLAYGROUND_BUDGET_TOKENS`/`_FILE`,
`ASYM_PLAYGROUND_MAX_RUN_TOKENS`, `ASYM_PLAYGROUND_RUN_TIMEOUT_MS`,
`ASYM_PLAYGROUND_RATE_MAX`/`_RATE_WINDOW_MS`. Clone backends: their own
`DATABASE_URL`/`REDIS_URL` + seed on boot (Slack `acme-corp`).

## DNS cutover (LAST — held until verified)
1. Deploy everything; verify on the **Railway-provided URL** (all 7 scenarios,
   both apps, budget breaker, rate limit).
2. Add custom domain `playground.getasym.dev` in Railway → it prints a CNAME target.
3. In the `getasym.dev` DNS (Vercel), add a `playground` CNAME → the Railway target.
   Only touches a **subdomain**; the apex marketing site is untouched.
4. Verify TLS + the live subdomain.

## Cost (order of magnitude)
~5 always-on Railway services (run-service + 2 backends + Postgres + Redis).
Railway usage-based; roughly a low-tens-of-dollars/month floor for small instances,
plus OpenRouter spend capped by the budget breaker. Confirm before provisioning.

## Phase 0 finding (2026-07-09): the clone lifecycle is CLI+Docker orchestrated

The backend GHCR images **do not self-migrate** — entrypoint is
`docker-entrypoint.sh → bun dist/main.js` (runs the app only). Everything else is
done **externally by the `asymmetric` CLI**: create DB → extract the image's baked
`/clone/migrations` and apply each `.sql` via psql → apply seeds → start backend →
`admin/provision` → reset (DROP+re-migrate or TRUNCATE+re-seed) per run. Railway's
per-service model can't run that flow (no sibling-container spin/migrate/seed). So:

- **Path A — Docker VM (recommended, faithful):** one Docker-capable host (Fly
  Machines / Hetzner / DO — **not** Railway's build-a-container model) running the
  existing `asymmetric` CLI **and** the run-service container. The CLI spins,
  migrates, seeds, provisions, and resets clones exactly as it does locally; the
  run-service points at them. This is the local setup, hosted — least new code,
  matches the architecture, and gives us real per-run reset for free.
- **Path B — Railway, reimplement the lifecycle:** Postgres + Redis + backend
  images as Railway services, PLUS a bespoke init job that extracts each image's
  `/clone` assets and applies migrations/seeds/provision, PLUS a reset mechanism.
  More code, more fragile, and duplicates CLI logic that already exists. Only worth
  it if Railway is a hard requirement.

Vercel still owns DNS (`playground` CNAME) in either path. The run-service
Dockerfile (bundling the clone MCP servers) is needed either way.

## Phased execution
- **Phase 0 — verify assumptions:** does the Slack clone support isolated
  per-workspace provisioning, or is it single-workspace? (Decides whether (A) truly
  needs single-flight.) Confirm the GHCR images boot on Railway with external PG.
- **Phase 1 — build artifacts (no infra):** Dockerfile (run-service + bundled MCP
  servers), single-flight queue in the run-service, budget/volume config, a
  `railway.json`. Reviewable, reversible.
- **Phase 2 — provision Railway + deploy:** create the project + services + PG/Redis,
  wire env, deploy, verify on the Railway URL.
- **Phase 3 — DNS cutover** on `getasym.dev` (Vercel), then verify live.

Checkpoints: approval before Phase 2 (first billing), and again before Phase 3
(DNS on the brand domain).

## VM runbook (EC2 Ubuntu + Docker) — mirrors the verified local setup

Host decided: **AWS EC2** (aws CLI is authed: acct 730335287527). Single-flight is
built + verified, so one modest instance is enough. Credentials the VM needs: a
**GHCR token** (pull clone images), a **monorepo deploy key/token** (the run-service
spawns the private `apps/*/mcp-server`), and the **OpenRouter key** (budgeted).

1. **Launch:** t3.large (2 vCPU / 8 GB — clones + Postgres + run-service), 30 GB gp3,
   security group open 22/80/443. (Elastic IP so DNS is stable.)
2. **Base:** install docker + compose plugin (add user to `docker`), bun, node 20,
   pnpm; `npm i -g @asymmetric-ai/cli`; `docker login ghcr.io`.
3. **Clones (CLI does the whole lifecycle):**
   `asym spin slack --mode api --seed acme-corp --json` and
   `asym spin linear --mode api --json` → note each api port.
4. **Private MCP servers:** checkout the monorepo (deploy key), `pnpm install` in
   `apps/slack-clone/mcp-server` and `apps/linear-clone/mcp-server`.
5. **PG reachability:** the Slack MCP reads Postgres directly — publish the shared
   PG or run the same socat forward we use locally (a forwarder container on the
   `asym-shared` network publishing 5432) → `DATABASE_URL` for the run-service.
6. **Run-service:** checkout the harness (public, `feat/cross-app-scenarios`),
   `bun install`, run `bun run serve` under pm2/systemd with `PORT=8080`, the
   `SLACK_*`/`LINEAR_*` env, `ASYM_PLAYGROUND_KEY`, a conservative
   `ASYM_PLAYGROUND_BUDGET_TOKENS`, and the budget-ledger file on disk.
7. **TLS + proxy:** Caddy reverse-proxy `:443 → :8080` with automatic Let's Encrypt
   for `playground.getasym.dev`.
8. **DNS (Vercel):** point `playground.getasym.dev` at the Elastic IP; verify TLS +
   all 7 scenarios live. (Apex marketing site untouched.)
