import type { RunEvent } from './orchestrate.js';

/** A successful grade is provisional until the pool verifies lease cleanup. */
export async function publishAfterRelease(
  release: () => Promise<void>,
  execute: (emit: (event: RunEvent) => void) => Promise<void>,
  publish: (event: RunEvent) => void,
): Promise<void> {
  let terminal: RunEvent[] = [];
  let executionFailed = false;
  try {
    await execute(event => {
      if (event.kind === 'outcome' || event.kind === 'done') terminal.push(event);
      else publish(event);
    });
  } catch (error) {
    executionFailed = true;
    throw error;
  } finally {
    try { await release(); }
    catch {
      terminal = [{ kind: 'outcome', outcome: { state: 'unknown', reason: 'clone_reset_failed', evidenceRefs: [] } }];
    }
    if (!executionFailed) for (const event of terminal) publish(event);
  }
}
