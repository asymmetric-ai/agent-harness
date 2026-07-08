# Cross-app scenarios — scoping

Status: **scoping** (2026-07-08). Written after wiring richer Slack drift and
probing the Linear clone live. The goal: understand what "scenarios across apps"
actually costs, and stage it so each phase ships value on its own.

## TL;DR

The scenario contract (`spec.ts` → `cloneClient.ts` → per-clone allow-list) is
shaped exactly around the **Slack Web API**: every setup step is
`POST {baseUrl}/{method}` with a Bearer token and a `{ ok, error }` response
envelope, and provisioning is a single `admin/provision` call that mints a
bot + admin token.

Neither "add Linear as a second app" nor "one scenario spanning Slack + Linear"
is a config change. **Both need the same generalization** of that contract. So
they are not two projects — they are Phase 1/2 (Linear single-app) and Phase 3
(the multi-clone engine) of one line of work.

Only **Slack** and **Linear** have MCP servers today, so they are the only two
apps an MCP-driven agent can act in at all. Stripe / Notion / HubSpot / GitHub
clones exist but expose no MCP surface — driving them means building MCP servers
first, out of scope here.

## What we shipped alongside this (done, verified)

Richer **within-Slack** drift, because the Slack clone already supports the
mutating RPCs:

- allow-list widened with `conversations.archive`, `conversations.rename`,
  `chat.delete` (`src/scenario/slack.ts`).
- New curated scenario **"Message deleted"** — admin posts a message, deletes it,
  the agent is asked to react to that `ts`; it hits `message_not_found`, checks
  history, and reports honestly. Verified end-to-end.
- Dropped a **"Channel archived"** scenario: the clone's `chat.postMessage` does
  **not** enforce `is_archived`, so the post succeeds — it isn't real drift.
  → **Clone-fidelity gap** worth filing: archived channels should reject writes
    (`is_archived`), matching real Slack. Candidate for the asymmetric `TODOS.md`.

## Why Linear doesn't drop in (measured, not assumed)

Probed `linear` clone (`asymmetric spin linear`, api on :3003):

| Dimension | Slack clone (built for) | Linear clone (reality) |
|---|---|---|
| Transport | flat `POST /{method}` | REST: verbs + resource paths (`POST /issues`, `PATCH /issues/:id`, `POST /issues/:id/assign`) |
| Response | `{ ok, error }` envelope | plain REST bodies + HTTP status; no `ok` field |
| Auth | `admin/provision` → bot+user tokens | `POST /auth/signup` + `/auth/login` → JWT; **no bot concept** |
| Seed | named fixtures (`acme-corp`) | `seed: null` — empty; a fresh user has **no organization** |
| Ready state | workspace + channels exist | must bootstrap **org → team → workflow-states** before an issue can exist |
| MCP → clone | via `DATABASE_URL` (needs a PG host port) | via `LINEAR_API_URL` + `LINEAR_API_KEY` over HTTP (simpler) |

The MCP/agent side of Linear is fine (7 real tools: `list_teams`, `list_issues`,
`get_issue`, `create_issue`, `update_issue`, `create_comment`, `list_projects`,
over HTTP with a bearer). The mismatch is entirely on the **setup/drift** side.

## Phase 1 — generalize the scenario transport (unblocks everything)

Make the contract carry *how* to call a method, not assume Slack's shape.

1. **`MethodSpec` gains transport** in `spec.ts`:
   ```ts
   interface MethodSpec {
     verb?: 'POST' | 'GET' | 'PATCH' | 'DELETE'; // default POST
     path?: string;   // template, e.g. 'issues/:id/assign'; default '/{method}'
     args: Record<string, ArgSchema>;
   }
   ```
   Path params (`:id`) resolve from `args` (which may themselves be interpolation
   tokens), so the existing `$N.dotted.path` grammar still drives them.
2. **`cloneClient.ts`** becomes verb + templated-path aware, and takes a per-clone
   **response adapter** so "did it succeed / what id came back" is normalized
   (`{ok}` for Slack; `2xx` + body for Linear). Keep the "HTTP 200 can still be a
   failure" rule for Slack via the adapter.
3. **Provisioning becomes per-clone** in the pool (`clone.ts`): a `provision(clone)`
   strategy. Slack = today's `admin/provision`. Linear = signup + create org +
   create team + ensure workflow-states, returning a ready lease whose
   interpolable context includes `$team` (and `$admin`), analogous to `$bot`.
   Bootstrap lives in the pool, **not** in scenario steps, so it doesn't eat the
   `MAX_STEPS` budget or leak into the public spec.
4. **Validator** extends to path-param methods; per-clone allow-list still the sole
   gate. New interpolation anchor `$team` (clone-scoped provisioned ids).

Risk: this is a real change to the *public* contract (paste-your-own authors see
`verb`/`path`). Keep Slack specs byte-identical (defaults preserve them) so nothing
regresses.

## Phase 2 — Linear as a second selectable app

Once Phase 1 lands, Linear is additive:

- `LINEAR_ALLOWLIST` in `src/scenario/linear.ts`: `issues.create` (`POST /issues`),
  `issues.update` (`PATCH /issues/:id`), `issues.delete` (`DELETE /issues/:id`),
  `issues.assign` (`POST /issues/:id/assign`), `comments.create`
  (`POST /issues/:issueId/comments`) — register under `ALLOWLISTS.linear`.
- Pool `acquire('linear')`: bootstrap + launch the Linear MCP with
  `LINEAR_API_URL` + `LINEAR_API_KEY` (the signed-up JWT). No DB forwarder needed.
- Run-service env: `LINEAR_CLONE_URL`, `LINEAR_MCP_CWD`.
- UI: an **app switcher** (Slack | Linear) above the scenario chips; each app has
  its own scenario catalog. Curated Linear drift, e.g.:
  - **Issue deleted before comment** — admin creates + assigns an issue, deletes
    it; the agent is told to comment on that issue id → `not_found`.
  - **Reassigned out from under it** — issue reassigned away; the agent's update is
    rejected / no longer its work.

## Phase 3 — the multi-clone engine (the moat)

One scenario, an *environment* of clones with **shared identity**. This is the
genuinely new system (see the `scope-multiclone-engine` planning pass).

- **Spec**: `clone: string` → `clones: Record<name, {template, seed}>`; steps and
  the task address a named clone. Interpolation crosses clones
  (`$github.pr.number` used in a `slack.chat.postMessage`).
- **Shared identity**: the same actor is one principal across clones (the moat) —
  provisioning must mint linked identities, not independent ones.
- **Run-service**: lease *N* clones per run; the harness multiplexes several MCP
  servers and **namespaces** their tools so the agent sees `slack_*` and
  `linear_*` together. Abort/lease/budget accounting fans out to all of them.
- **Drift across apps**: the payoff — "the Linear issue the Slack workflow depends
  on was closed," a failure no single-app mock can produce.

Open questions: identity-linking semantics across heterogeneous auth (JWT vs app
tokens); MCP tool-name collisions + namespacing; per-clone allow-list + budget in
one run; whether drift becomes a first-class mid-run step kind (already flagged as
unresolved in the eng plan) rather than setup-only.

## Recommended order

1. **(done)** richer Slack drift.
2. **(done)** Phase 1 + 2 — transport generalization + Linear single-app. See below.
3. **Phase 3** — the multi-clone engine, via the dedicated scoping pass. This is
   the vision demo and the moat; treat as its own project.

## Built (2026-07-08) — Phase 1 + 2

- **Transport generalized.** `MethodSpec` now carries `verb` + `path` (default
  `POST /{method}` keeps Slack byte-identical); `cloneClient` fills `:param` path
  segments from args and normalizes success as `2xx && no ok:false/error` (works
  for Slack's envelope and Linear's REST bodies alike); `$team` added as a
  provisioned interpolation ref. Slack specs and the 13 scenario unit tests are
  unchanged; verified a live Slack eviction still breaks (`not_in_channel`).
- **Linear provisioning** (`clone.ts`): signup → create org → **re-login** (a fresh
  signup JWT carries no org) → create team; exposes `$team`. Agent acts as the
  admin principal (Linear has no bot). MCP over HTTP (`LINEAR_API_URL` +
  `LINEAR_API_KEY`), no DB forwarder.
- **Linear allow-list** (`linear.ts`): `issues.create/update/delete/assign`,
  `comments.create`, `teams.delete`. Note `issues.update` is **PUT** (the clone's
  update route), not PATCH.
- **UI**: app switcher (Slack | Linear) over per-app scenario catalogs.
- **Linear drift shipped — "Team disbanded"**: file an issue in a team, delete the
  team; the delete **cascades** and removes the issue, so the agent's
  `update_issue` hits `Issue not found` (verified: 1 tool error, honest give-up).
  Plus a Linear "Happy path" control (comment on an open issue → succeeds).
- **Fidelity gap found (like Slack's archive):** a bare Linear `DELETE /issues/:id`
  is soft — the row stays readable *and writable* (GET 200, PUT 200, comment 201),
  so "delete an issue" is not drift on its own. Only team-deletion cascade is.
  Candidate for the linear-clone TODOs: deleted/archived issues should reject
  writes. (`PATCH /issues/:id` also 404s as a bare route-not-found — the update
  verb is PUT — noted so paste-your-own authors don't trip on it.)
