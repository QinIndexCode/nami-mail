import { z } from "zod";
import type { AgentTool, ToolExecutionOutcome } from "@nami/agent-core";
import { createAgentError } from "@nami/agent-contracts";

const timeInputSchema = z.object({}).strict();

const timeOutputSchema = z.object({
  /** The exact wall-clock instant as an ISO-8601 string including the local UTC offset. */
  iso: z.string(),
  /** A locale-aware human string (date + time, minute/second precision). */
  local: z.string(),
  /** IANA-style offset label, e.g. "+08:00"/"−05:00". */
  timezone: z.string(),
  /** The current UTC offset in minutes (e.g. 480 for UTC+8). */
  offsetMinutes: z.number(),
}).strict();

type TimeOutput = z.infer<typeof timeOutputSchema>;

/**
 * A read-only `time.now` tool. The system prompt only anchors the model to a
 * coarse hour so the conversation prefix stays cacheable; when a request needs
 * an exact current time (scheduling, "at exactly 14:30", building a precise
 * `after`/`before` offset), the model calls this to fetch the precise wall clock.
 */
export function createTimeTools(): AgentTool<any, any>[] {
  return [
    {
      descriptor: {
        name: "time.now",
        title: "Current date and time",
        description: "Returns the exact current local date and time, including the UTC offset. Use it when a request needs a precise timestamp (e.g. the exact clock time, scheduling, or computing an exact `after`/`before` offset). The clock value in the system prompt is only hour-precision and is not exact.",
        category: "system",
        executionMode: "read",
        requiredScopes: ["time:read"],
        accountAccess: "none",
        confirmationPolicy: "never",
        availableToExternal: true,
        timeoutMs: 5_000,
      },
      inputSchema: timeInputSchema,
      outputSchema: timeOutputSchema,
      execute: async (): Promise<ToolExecutionOutcome<TimeOutput>> => {
        const now = new Date();
        const offsetMinutes = -now.getTimezoneOffset();
        const sign = offsetMinutes < 0 ? "-" : "+";
        const abs = Math.abs(offsetMinutes);
        const timezone = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
        try {
          return {
            ok: true,
            value: {
              iso: now.toISOString(),
              local: new Intl.DateTimeFormat(undefined, {
                dateStyle: "medium",
                timeStyle: "medium",
              }).format(now),
              timezone,
              offsetMinutes,
            },
          };
        } catch {
          return {
            ok: false,
            error: createAgentError({
              code: "TOOL_EXECUTION_FAILED",
              message: "Could not read the current time.",
              retryable: false,
            }),
          };
        }
      },
    },
  ];
}