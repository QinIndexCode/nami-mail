import { isTaskKind, type TaskKind, type TaskRegistry, type TaskRunner } from "./types.js";

/**
 * The kind -> executor table.
 *
 * Instance-level, never a module-global singleton. The legacy queue kept its
 * runner map inside `createOperationQueue`'s closure for the same reason this
 * one is created per app: two runtimes coexist routinely (every test that opens
 * its own database), and a module-level map would let them register over each
 * other and leave "which kinds exist" impossible to reason about per instance.
 */
export function createTaskRegistry(): TaskRegistry {
  const runners = new Map<TaskKind, TaskRunner<unknown>>();
  return {
    register<P>(kind: TaskKind, runner: TaskRunner<P>): void {
      if (!isTaskKind(kind)) throw new Error(`Unknown task kind "${kind}".`);
      runners.set(kind, runner as TaskRunner<unknown>);
    },
    get(kind: TaskKind): TaskRunner<unknown> | undefined {
      return runners.get(kind);
    },
  };
}