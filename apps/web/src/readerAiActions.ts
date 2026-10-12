export type ReaderAiAction = "summary" | "draft";

export interface ReaderAiLaunchIntent {
  action: ReaderAiAction;
  prompt: string;
  autoSend: boolean;
}

/**
 * Resolves reading-pane AI actions into launch intents for AgentWorkspace:
 * - "summary": Uses the parameterless slash command `/summary` and auto-sends
 *   immediately with the referenced mail context.
 * - "draft": Uses `/draft ` (with trailing space) to pre-fill the composer and
 *   focus the cursor at the end, requiring user review before sending.
 */
export function resolveReaderAiIntent(action: ReaderAiAction): ReaderAiLaunchIntent {
  switch (action) {
    case "summary":
      return {
        action: "summary",
        prompt: "/summary",
        autoSend: true,
      };
    case "draft":
      return {
        action: "draft",
        prompt: "/draft ",
        autoSend: false,
      };
  }
}
