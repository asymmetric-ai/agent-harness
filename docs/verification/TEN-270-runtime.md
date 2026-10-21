# TEN-270 runtime verification — 21 October 2026

The integration test used the published Slack backend JavaScript and its exact image dependencies, migrations and acme-corp seed on disposable native PostgreSQL. Image manifest: `sha256:98c869320c69dcc66dabbb40c7cdfe47a6c371459198970a1f7cd172520e0a73`. Packaged code remains outside this repository. A wrapper binds its temporary backend server to loopback. No customer database, live Slack, paid model call or production configuration was used.

Raw [integration output](TEN-270-official-runtime.txt) records fresh PostgreSQL and backend process IDs. The test checks a real MCP write through HTTP to persisted rows, independent database-trigger evidence, stale/wrong-channel/duplicate/deleted effects, verified rename and old-name reuse, archive refusal, persisted Connect disconnection and external read denial, lost action-time audience despite later restoration, disabled journal, failed reset cleanup and a fresh second lease. Its full run uses a scripted local OpenAI-compatible response fixture; this is execution-path evidence, not a real model evaluation. Every database/server is task-owned and cleaned in finally.

[Unit output](TEN-270-tests.txt): 45 passed, native integration explicitly skipped in the ordinary run. The separate integration invocation passed. TypeScript check passed. The Bun/node:test skip compatibility was corrected so missing PostgreSQL configuration actually skips the integration case. The deterministic CLI transport test uses an authored executable; the separate actual Docker run below uses the published official CLI.

Reproduction commands are in [the operator guide](../slack-outcomes.md). Missing adapter schema, audience, authority, reset or journal coverage must withhold a passing verdict. Approval drafts deliberately lack organization, named approver, source and revision and are not a loadable approval array.

## Actual official Docker/CLI run

The full actual Docker/CLI run passed at source `7af287c67c4a7bd7d01a9ebfbcc2d6eb6f88caf0`: one integration test, 0 failures, 370.26 seconds, twelve fresh clones. Docker 29.8.1, official `@asymmetric-ai/cli` 0.2.0 and the pinned backend above. Actual spin/query/write/reset/status/destroy commands exercised all the persisted-outcome and scripted model/MCP cases listed above. Ordinary tests passed (45 pass, 1 integration skip); typecheck passed before this run. The first actual run exposed and corrected the version-2 registry-envelope mismatch; it was not counted as passing.

- [Raw full Docker integration output](TEN-270-docker-full.txt)
- [Runtime/cleanup metadata](TEN-270-docker-full-metadata.json)
- [Exact source binding](TEN-270-docker-full-source.json)

Task-owned shared services, volumes/network and newly pulled image references were removed. Pre-existing Docker resources were preserved. The task-started Docker engine was returned to its original stopped state.

## Additional physical cleanup verification

Source `94f1ca16ae5ebd5454741b44920f8f113ccb0919` independently checks backend labels and the exact database catalog because official CLI 0.2 can erase its registry entry after an unsuccessful physical teardown. The [Codex review](TEN-270-cli-review.md), using gpt-6.1-sol with medium reasoning, found one P2 in integration cleanup bookkeeping. Source `ae852abdae2f6e7befe41e7bf025f55572e4ddbf` keeps ownership/recovery files until physical absence is verified and preserves cleanup errors. Updated unit/type checks and the actual focused Docker smoke are pending the unchanged 30 GiB resource-admission requirement. The older full run does not validate these later guards.

Limits: no real provider-model evaluation, rendered playground review, deployed harness service or customer acceptance. Connect uses the documented persisted simulation extension because this published clone has no native sharing fields. The completed Docker run establishes the tested local official CLI/backend combination; upstream deployment and customer use remain separate. This delivery is a draft PR. Greptile not run (draft exclusion); no paid review was dispatched. No automatic review/app settings were enabled.
