# TEN-270 final targeted CLI review — 2026-10-21

Reviewer: Codex, gpt-6.1-sol, medium reasoning. Review session/task: `/root/ten270_cli_final_review`. One blind consolidated static pass; no prior author/reviewer verdict was used. No tests, paid calls, Docker mutations, implementation edits or pushes were performed by this reviewer.

Reviewed source: `/Users/raizada/Developer/TEN-270-harness`, HEAD `94f1ca16ae5ebd5454741b44920f8f113ccb0919`, compared with published draft `9c9bcda68062df393dea9502e12e8eb8da5a3e17`. Scope: changed CLI transport/lifecycle boundary and integration opt-in modes; not a repeat broad review of outcome semantics.

## Verdict

One P2 finding in the Docker integration failure-cleanup bookkeeping. No additional actionable production-boundary finding identified in this scoped pass. Final source execution remains pending; this is not release approval or a claim that physical cleanup observations executed.

### [P2] Retain Docker ownership until physical destruction is verified

`src/runtime/postgres.integration.test.ts:79` deletes the test's owned clone ID immediately after `cli.destroy()` succeeds. The published CLI's `LocalProvider.destroy` ignores failed Compose-down/database-drop results and removes the registry entry anyway. Therefore this exact failure mode makes the new `cli.exists()` return true or throw during `lease.release()`, but the test's outer finally sees an empty `control.owned` and removes the task folder at line 199. It neither retains ownership for recovery nor preserves the task registry directory, despite physical clone resources potentially remaining. The new production check correctly withholds success, but the integration harness loses its recovery bookkeeping in the failure that check is intended to expose.

Keep the ID tracked until `cli.exists(id)` independently returns false. On true or inconclusive observations, preserve the directory and an explicit owned-resource record (ID/database/container identity and failure) for recovery; do not treat another CLI destroy acknowledgement as absence. Ensure final cleanup does not abort before preserving this record. Verify this using a fake CLI/Docker fixture where destroy succeeds but physical resources remain or the absence probe fails. No shared-resource teardown is implied.

## Contract and boundary observations

- Inspected installed `@asymmetric-ai/cli` 0.2.0 `dist/index.js`: spin JSON is an array; status JSON is a version-2 registry object; query consumes stdin when inline SQL/file are absent; read JSON and write output contracts match the adapter.
- Inspected packaged Slack `docker-compose.yml`, `compose.shared.yml`, and CLI creation/destroy/registry/query paths. `asym.clone` is the actual backend label; shared Postgres uses Compose project `asym-shared` and service `postgres`. The new observation uses those labels and checks the exact database derived from the freshly returned clone ID. Shell interpolation is absent; the validated ID alphabet prevents SQL literal injection in the derived database query.
- Both CLI and independent Docker probes inherit operator process context; only CLI receives the operator-selected ASYM_HOME override. No request/model-selected Docker context or credentials were introduced by these changes. Missing/ambiguous Postgres selection, failed Docker/psql commands and unexpected query output fail closed.
- Inspected `src/runtime/pool.ts` and `src/run-service/publication.ts`: release checks reset/baseline, invokes destroy and absence observation, and terminal successful outcomes remain buffered until release succeeds. Cleanup failure yields Unknown rather than publishing the provisional pass.
- Unit fake now models the versioned registry and independent container/database presence and unavailable-probe branches. It does not itself prove that the actual Docker selectors/database probe executed.

## Execution evidence and unresolved gates

Inspected `docker-runtime-integration-full-20261021.log`, `docker-validation-metadata-full-20261021.json`, and the actual integration test assertions. The prior full run recorded 1 pass / 0 fail in about 370 seconds using Docker 29.8.1, official CLI 0.2.0, and backend `ghcr.io/asymmetric-ai/asymmetric-slack-backend@sha256:98c869320c69dcc66dabbb40c7cdfe47a6c371459198970a1f7cd172520e0a73`. Its source was `7af287c67c4a7bd7d01a9ebfbcc2d6eb6f88caf0`; inspecting that revision confirms absence verification was registry-only. Thus this run supports actual CLI/backend lifecycle, persisted grading, reset, stale/wrong/duplicate/deleted outcomes, rename/archive, scripted local-model MCP/publication flow and adapter-owned persisted Connect simulation, but does not execute the added independent physical checks at HEAD 94f1ca1.

Current focused two-fresh-lease actual Docker smoke plus updated unit/type checks are pending admission under the unchanged 30 GiB gate, as provided in the task handoff. Inspected waiter metadata identifying PID 17847 and the gated validation purpose; did not independently establish current liveness/capacity. No heavy command was launched by this review. The pressure exception does not waive disk admission. Complete missing checks when admitted and record their actual revision/results; resolve the P2 once without an automatic review loop.

Connect coverage is the adapter-owned persisted simulation, not native/live Slack Connect. The local scripted model fixture makes no provider call. This review and the old full integration run do not establish customer acceptance, external Slack delivery, hosted CI, deployment or current full-source execution.

## Author disposition — 21 October 2026

The P2 was resolved in ae852abdae2f6e7befe41e7bf025f55572e4ddbf and refined in 1d57f09: integration control now removes ownership only after independent physical absence, records clone ID/exact database/container label and cleanup error, retains the registry and recovery record after inconclusive/retained observations, and aggregates cleanup errors without masking the original execution failure. The focused smoke injects a successful destroy acknowledgement while actual backend/database resources remain, plus an unavailable absence probe, and asserts ownership/recovery persistence. Normal physical destruction is then restored and verified. This is the author's disposition, not another independent review. Execution on this final source is pending resource admission; the previous full run remains bound to 7af287c.
