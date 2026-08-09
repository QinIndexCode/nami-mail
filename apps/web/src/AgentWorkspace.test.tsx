import { describe, expect, it } from "vitest";
import { applyConfirmationDecision, expireConfirmation } from "./AgentWorkspace";
import type { AgentConfirmation, AgentMessage, AgentToolActivity } from "./agentTypes";

const message = (
  confirmation: AgentConfirmation,
  toolStates: AgentToolActivity["state"][],
): AgentMessage => ({
  id: "msg-1",
  role: "assistant",
  content: "done",
  createdAt: "2026-08-08T00:00:00.000Z",
  state: "complete",
  citations: [],
  toolActivities: toolStates.map((state, index) => ({
    id: `tool-${index}`,
    toolName: "calendar.create",
    title: "calendar.create",
    state,
  })),
  ...(confirmation ? { confirmation } : {}),
});

const pendingConfirmation = (): AgentConfirmation => ({
  id: "confirm-1",
  title: "Create calendar event",
  summary: "The assistant requests a new calendar event.",
  fields: [],
  expiresAt: "2026-08-08T01:00:00.000Z",
  state: "pending",
});

describe("applyConfirmationDecision", () => {
  const labels = { approved: "已批准", rejected: "已拒绝" };

  it("approves the confirmation and completes the waiting tool with the approval label", () => {
    const result = applyConfirmationDecision(
      message(pendingConfirmation(), ["awaiting_confirmation", "completed"]),
      "confirm-1",
      "approve",
      labels,
    );
    expect(result.confirmation?.state).toBe("approved");
    expect(result.toolActivities.map((tool) => tool.state)).toEqual(["completed", "completed"]);
    expect(result.toolActivities[0]?.summary).toBe("已批准");
    expect(result.toolActivities[1]?.summary).toBeUndefined();
  });

  it("rejects the confirmation and fails the waiting tool with a rejection error", () => {
    const result = applyConfirmationDecision(
      message(pendingConfirmation(), ["awaiting_confirmation"]),
      "confirm-1",
      "reject",
      labels,
    );
    expect(result.confirmation?.state).toBe("rejected");
    expect(result.toolActivities[0]?.state).toBe("failed");
    expect(result.toolActivities[0]?.error).toEqual({
      code: "CONFIRMATION_REJECTED",
      message: "已拒绝",
      retryable: false,
    });
  });

  it("leaves messages with a different confirmation untouched", () => {
    const input = message(pendingConfirmation(), ["awaiting_confirmation"]);
    const result = applyConfirmationDecision(input, "confirm-other", "approve", labels);
    expect(result).toBe(input);
  });

  it("leaves non-waiting tools untouched", () => {
    const input = message(pendingConfirmation(), ["running"]);
    const result = applyConfirmationDecision(input, "confirm-1", "approve", labels);
    expect(result.toolActivities[0]?.state).toBe("running");
  });
});

describe("expireConfirmation", () => {
  it("marks the confirmation expired and fails the waiting tool", () => {
    const result = expireConfirmation(message(pendingConfirmation(), ["awaiting_confirmation"]), "confirm-1", "已过期");
    expect(result.confirmation?.state).toBe("expired");
    expect(result.toolActivities[0]?.state).toBe("failed");
    expect(result.toolActivities[0]?.error).toEqual({
      code: "CONFIRMATION_EXPIRED",
      message: "已过期",
      retryable: false,
    });
  });

  it("leaves messages with a different confirmation untouched", () => {
    const input = message(pendingConfirmation(), ["awaiting_confirmation"]);
    expect(expireConfirmation(input, "confirm-other", "已过期")).toBe(input);
  });
});
