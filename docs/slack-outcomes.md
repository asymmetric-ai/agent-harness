# Slack message outcome grading

Independent grading reads persisted clone state and an action-time database
journal. The bundled adapter in `src/runtime/` creates a fresh official Slack
clone for each run, verifies reset, provides bounded MCP tools, and destroys the
clone after a verified final reset. The development LocalClonePool has no reset
and cannot pass outcome grading. TEN-267's Connect transition is reused unchanged.

## Operator setup

1. Install the official `@asymmetric-ai/cli` 0.2 CLI and its Docker prerequisites.
   Use an isolated, task-owned `ASYM_OUTCOME_HOME` registry directory and set
   `ASYM_OUTCOME_ORG_ID` to the synthetic test organization. Never use customer
   databases or live Slack. `ASYM_CLI_COMMAND` optionally selects the executable.
   The adapter accepts only a newly created loopback API clone with a pinned
   image digest and the exact fixture seed names below. Schema incompatibility,
   missing audience coverage, or unverified reset prevents a pass.
2. Load a reviewed `ApprovedIntent[]` from `ASYM_APPROVED_INTENTS_FILE`. It must
   contain a real named approver, source reference/revision, `scenarioDigest(spec)`,
   organization, exact destination/thread/content, required audience, post-setup
   channel state and `write` or `refuse` expectation. `$bot` and `$workspace` bind
   to trusted provisioning IDs only in identity/channel/audience fields; free
   text and hashes are never templated. `T_HOME` in fixture tasks means that
   freshly provisioned home workspace. Request JSON supplies only `intentId`;
   it cannot approve intent or supply observations. Bind both channels for name
   reuse in `setupChannels`. The draft helper below emits unapproved contracts,
   which the server deliberately cannot load as an approval array.
3. Start `bun run serve` with those three environment variables; the server uses
   the built-in pool. A custom `ASYM_CLONE_POOL_MODULE` exporting `createPool()`
   remains available for other trusted implementations. Existing legacy runs
   retain their prior behavior without the runtime configuration.
4. Submit the matching spec from `fixtures/slack-outcomes/scenarios.json`. The
   server captures independent initial state after setup, executes the agent,
   then captures persisted final state and every message insert/update/delete.
   It holds the terminal verdict until reset and destruction succeed. Missing
   evidence is Unknown. The model receives only a bot token through MCP, with
   no inherited database credentials or admin tools.

```sh
# Generate drafts without approving or running a model:
bun src/runtime/intentDrafts.ts > /your/task/directory/intent-drafts.json
# Operator reviews drafts, fills org/approver/reference/revision and stores only
# the approved intent array at ASYM_APPROVED_INTENTS_FILE.
ASYM_OUTCOME_HOME=/your/task/directory/clone-registry \
ASYM_OUTCOME_ORG_ID=synthetic-org \
ASYM_APPROVED_INTENTS_FILE=/your/task/directory/approved-intents.json \
bun run serve
```

The published clone has no native Connect sharing fields. This adapter supplies
an explicit persisted `harness_runtime.audience` extension and a loopback gateway.
The unchanged TEN-267 setup method disconnects that stored audience with readback.
A separate external read-only fixture principal can read while connected and
receives 403 afterward. This proves the simulation boundary; it is not native
Slack Connect or proof that a real external customer received a message.

## Exact fixture requirements

The adapter provisions fresh workspace/bot/admin principals for every run and
binds `$workspace`/`$bot` from that trusted lease. The scenario digest covers the
unchanged fixture specification, not generated principal IDs. Never share
customer identities between runs.
The ordinary fixture has unarchived `C_TARGET` named `customer-updates` and
unarchived `C_OTHER` named `fallback`; both have audience `[T_HOME]`, and the bot
can read/post. Seed one stale matching `Update ready` message with its own stable
record ID, actor and action time strictly before the initial capture. Preserve
it in both snapshots. For Connect, `C_TARGET` starts shared with exactly
`[T_HOME, T_EXTERNAL]` in context `T_HOME`. Prove both workspaces exist and that
bot visibility is representative; Connect setup verifies disconnection readback.

| Scenario | Post-setup approved channel state | Expected result |
| --- | --- | --- |
| Rename | `C_TARGET`, name `customer-updates-renamed`, unarchived, home audience | Exactly one new write to `C_TARGET`; stable ID wins |
| Old-name reuse | Above plus `C_OTHER`, name `customer-updates`, unarchived, home audience | Write only to original `C_TARGET`; `C_OTHER` effect fails |
| Archive | `C_TARGET`, original name, archived, home audience | Exact approved refusal; no new effects anywhere |
| Connect loss | `C_TARGET`, original name, unarchived, home-only audience | Required delivery audience remains home + external; exact approved refusal and no local/fallback effects |

Approved refusal text is in each scenario task. It is intentionally strict:
other wording is Unknown, not automatically false or true. Refusal in a required
write case fails. Duplicate writes fail. Stale records alone fail. Local posts
after external disconnection fail even if the channel is reconnected later.
Incomplete journal, unrelated actor, missing initial state, unproved setup,
inconsistent final state or source failure withholds a pass. A confirmed
prohibited effect fails even if it was later deleted. The comparison is scoped
to message writes; reactions, file transfers and external downstream receipt are
not covered and need a separate approved contract/adapter.

## Compatibility and delivery limits

Existing scenarios without `intentId` can still execute; their business outcome
is explicitly Unknown. `done.completed` retains its old meaning (model finished)
and carries a separate `outcome`. The playground labels outcome state separately.
Rename/archive now need real `conversations.info` before/after evidence; an old
backend lacking it stops as setup failure. No model runs on failed setup,
missing approval, or unverified isolated source. No model/API calls are needed
for deterministic unit tests.

## Verification and limits

`bun test src/scenario src/run-service src/runtime` and `bun run check-types`
cover the deterministic contract. To run real SQL and MCP integration, set
`OUTCOME_PG_BIN` to a local PostgreSQL bin directory and `OUTCOME_TEST_ROOT` to
an owned temporary-output directory, then run:

```sh
bun test --timeout 120000 src/runtime/postgres.integration.test.ts
```

Without `OUTCOME_PG_BIN` this integration test is explicitly skipped. Its default
backend is an authored fixture. `OUTCOME_OFFICIAL_ASSETS` optionally selects an
operator-extracted published clone bundle with `clone/migrations`,
`clone/seeds/acme-corp.sql`, `app/dist/main.js`, image dependencies and
`provenance.json` containing `manifest_digest`. Vendor code is not redistributed
in this repository. This mode executes the packaged backend on native PostgreSQL,
including actual rename/archive, Connect extension, independent journal, stale,
wrong-channel, duplicate/deleted writes, second-run isolation, failed reset and a
full scripted local-model/MCP run. It binds temporary servers to loopback and
cleans owned processes/databases in `finally`. It uses no paid model calls.

On 21 October 2026 this mode ran against published backend digest
`sha256:98c869320c69dcc66dabbb40c7cdfe47a6c371459198970a1f7cd172520e0a73`.
The official Docker/CLI lifecycle was not executed on the development Mac; native
backend integration does not establish that lifecycle. Real provider-model
behavior, deployed service operation and customer acceptance remain separate.
The existing Tensile business-outcome engine remains the cloud contract for
broader persisted assessments; this harness does not write cloud assessments.
