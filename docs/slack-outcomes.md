# Slack message outcome grading

This patch wires independent grading into the scenario execution path. It does
not supply the closed clone's journal/reset implementation or prove clone
acceptance. The development LocalClonePool has no reset and cannot pass an
outcome-graded run. TEN-267's Connect transition is included unchanged.

## Operator setup

1. Supply a trusted pool module via `ASYM_CLONE_POOL_MODULE` (absolute local JS
   module exporting `createPool(): ClonePool`). It must lease an isolated
   workspace/run, apply the exact fixture below, verify reset before returning,
   and reject `release()` if teardown/reset cannot be verified. The server holds
   terminal outcomes until release succeeds. Do not point this at live Slack.
2. On each lease, supply `outcomeSource: OutcomeSource` from
   `src/scenario/outcome.ts`. `capture()` runs after verified setup and before
   agent execution. `finish()` returns initial/final record evidence plus a
   complete append-only message-write journal, with channel audience/state at
   each action. Read this from the clone's independent record/audit store, never
   from agent calls, replies or self-reported success. Capture all workspace
   channels, including private/DM/fallback destinations, all message mutations
   and subsequently deleted posts. If coverage, attribution or timing cannot be
   proved, return incomplete evidence. Do not fabricate missing fields.
3. Load reviewed `ApprovedIntent[]` from `ASYM_APPROVED_INTENTS_FILE`. Each entry
   needs a named approver, source reference/revision, org/workspace/actor scope,
   `scenarioDigest(spec)`, exact destination/thread/content, delivery audience,
   expected post-setup channel state and `write` or `refuse` expectation. Request
   JSON supplies only `intentId`; it cannot approve intent or supply observations.
   Bind every necessary fixture channel in `setupChannels`, including name reuse.
4. Run the corresponding entry from `fixtures/slack-outcomes/scenarios.json`.
   These are synthetic fixture specifications, not proof of backend support.

## Exact fixture requirements

Create fresh `T_HOME`, `U_BOT`, `U_ADMIN` principals for each isolated run;
substitute the observer's actual stable IDs into scenario and approval together
before computing the digest. Never share customer identities between runs.
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

The observer boundary is code, not an acceptance claim. A maintainer must supply
and validate the runtime adapter before any scenario can pass on a real clone.
No clone adapter is bundled because its backend and audit schema were unavailable
in this checkout. Do not replace action-time audience with the final channel
state or record counts. The existing Tensile business-outcome engine remains the
cloud contract for broader persisted assessments; this companion harness reports
a bounded scenario verdict and does not write cloud assessments.
