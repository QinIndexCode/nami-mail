import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentMessageRow, AgentToolList, applyConfirmationDecision, dedupeCitations, expireConfirmation, interruptAssistantMessage, lastMessageIsStreaming, lastMessageIsUnanswered, mergeRevokedMarks } from "./AgentWorkspace";
import { I18nProvider, translate } from "./i18n";
import type { AgentCitation, AgentConfirmation, AgentConversation, AgentMessage, AgentToolActivity } from "./agentTypes";

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

describe("interruptAssistantMessage", () => {
  const label = "已中断";

  it("flags the message interrupted and completes its state", () => {
    const input: AgentMessage = { ...message(pendingConfirmation(), []), state: "streaming", content: "partial answer" };
    const result = interruptAssistantMessage(input, label);
    expect(result.interrupted).toBe(true);
    expect(result.state).toBe("complete");
    expect(result.content).toBe("partial answer");
  });

  it("fails running and awaiting-confirmation tools so none are left spinning", () => {
    const input = { ...message(pendingConfirmation(), ["running", "awaiting_confirmation", "completed"]), state: "streaming" as const };
    const result = interruptAssistantMessage(input, label);
    expect(result.toolActivities.map((tool) => tool.state)).toEqual(["failed", "failed", "completed"]);
    expect(result.toolActivities[0]?.error).toEqual({ code: "INTERRUPTED", message: label, retryable: false });
  });

  it("expires a pending confirmation so it can no longer be acted on", () => {
    const result = interruptAssistantMessage(message(pendingConfirmation(), ["awaiting_confirmation"]), label);
    expect(result.confirmation?.state).toBe("expired");
  });

  it("preserves an already-failed message state instead of overwriting it", () => {
    const input: AgentMessage = {
      ...message(pendingConfirmation(), ["failed"]),
      state: "error",
      error: { code: "agent_stream_invalid", message: "stream broke", retryable: true },
    };
    const result = interruptAssistantMessage(input, label);
    expect(result.state).toBe("error");
    expect(result.interrupted).toBe(true);
    expect(result.error?.code).toBe("agent_stream_invalid");
  });
});

describe("dedupeCitations", () => {
  const cite = (id: string, messageId: string, sender = ""): AgentCitation => ({
    id,
    messageId,
    accountId: "account-1",
    subject: `subject-${id}`,
    sender,
    sentAt: "2026-08-08T00:00:00.000Z",
    excerpt: `excerpt-${id}`,
  });

  it("keeps only the first citation per source message", () => {
    const result = dedupeCitations([
      cite("a", "mail-1"),
      cite("b", "mail-1"), // same mail as "a" — dropped
      cite("c", "mail-2"),
    ]);
    expect(result.map((citation) => citation.id)).toEqual(["a", "c"]);
  });

  it("falls back to the citation id when messageId is absent", () => {
    const noMessageId = cite("a", ""); // messageId is empty string here
    const result = dedupeCitations([noMessageId, { ...noMessageId, id: "a" }]);
    expect(result.map((citation) => citation.id)).toEqual(["a"]);
  });

  it("returns an empty array unchanged", () => {
    expect(dedupeCitations([])).toEqual([]);
  });
});

describe("AgentToolList warning folding", () => {
  const zh = (key: string, values?: Record<string, string | number>) => translate("zh-CN", key, values);
  const failedTool = (id: string): AgentToolActivity => ({
    id,
    toolName: "messages.send",
    title: "messages.send",
    state: "failed",
    error: { code: "HOST_UNAVAILABLE", message: "SMTP host unreachable", retryable: true },
  });
  const completedTool = (id: string): AgentToolActivity => ({
    id,
    toolName: "rag.search",
    title: "rag.search",
    state: "completed",
    summary: "找到 3 封相关邮件",
  });

  function renderToolList(activities: AgentToolActivity[], superseded?: boolean): string {
    return renderToStaticMarkup(
      <I18nProvider>
        <AgentToolList activities={activities} superseded={superseded} />
      </I18nProvider>,
    );
  }

  it("expands a failure in the latest turn so the error stays visible", () => {
    const markup = renderToolList([failedTool("tool-fail")]);

    expect(markup).toContain("agent-tool-card failed");
    expect(markup).toContain(zh("agent.tool.failed"));
    expect(markup).toContain("agent-tool-list open");
  });

  it("lets the user fold a final-failure list back down, keeping the failed count visible", () => {
    const markup = renderToolList([completedTool("tool-ok"), failedTool("tool-fail")]);

    expect(markup).toContain("agent-tool-toggle");
    expect(markup).toContain("agent-tool-list open");
  });

  it("does not pin the list open when an earlier tool fails and a later one recovers", () => {
    const markup = renderToolList([failedTool("tool-fail"), completedTool("tool-ok")]);

    expect(markup).toContain("agent-tool-summary");
    expect(markup).not.toContain("agent-tool-collapse open");
  });

  it("shows a failed count on the summary once a failed list folds back", () => {
    const markup = renderToolList([failedTool("tool-fail"), completedTool("tool-ok")], true);

    expect(markup).toContain("agent-tool-summary-failed");
    expect(markup).toContain(zh("agent.tool.failedCount", { count: 1 }));
  });

  it("folds a failed tool list back to its summary once a new turn supersedes it", () => {
    const markup = renderToolList([failedTool("tool-fail")], true);

    expect(markup).toContain("agent-tool-summary");
    expect(markup).toContain(zh("agent.tool.summary", { count: 1 }));
    expect(markup).not.toContain("agent-tool-collapse open");
  });

  it("keeps successful turns collapsed regardless of supersession", () => {
    const markup = renderToolList([completedTool("tool-ok")], true);

    expect(markup).toContain("agent-tool-summary");
    expect(markup).not.toContain("agent-tool-collapse open");
  });
});

describe("AgentMessageRow streaming status", () => {
  const noop = () => undefined;
  const streamingMessage = (): AgentMessage => ({
    id: "msg-stream",
    role: "assistant",
    content: "",
    createdAt: "2026-08-08T00:00:00.000Z",
    state: "streaming",
    citations: [],
    toolActivities: [],
  });

  function renderRow(message: AgentMessage, statusMessage?: string | null): string {
    return renderToStaticMarkup(
      <I18nProvider>
        <AgentMessageRow
          message={message}
          superseded={false}
          statusMessage={statusMessage}
          locale="zh-CN"
          t={(key, values) => translate("zh-CN", key, values)}
          onOpenAttachment={noop}
          onRevoke={noop}
          onRetry={noop}
          onUserMessageRef={noop}
        />
      </I18nProvider>,
    );
  }

  it("shows the live provider status text in the thinking line when present", () => {
    const markup = renderRow(streamingMessage(), "网络波动，正在自动重试模型请求（2/5）…");

    expect(markup).toContain("agent-thinking");
    expect(markup).toContain("网络波动，正在自动重试模型请求（2/5）…");
    expect(markup).not.toContain(translate("zh-CN", "agent.message.thinking"));
  });

  it("falls back to the default thinking label without a status message", () => {
    const markup = renderRow(streamingMessage(), null);

    expect(markup).toContain("agent-thinking");
    expect(markup).toContain(translate("zh-CN", "agent.message.thinking"));
  });
});

describe("lastMessageIsUnanswered", () => {
  const conversation = (message: AgentMessage): AgentConversation => ({
    id: "conversation-1",
    title: "测试",
    preview: "",
    updatedAt: "2026-08-10T00:00:00.000Z",
    providerId: "provider-1",
    scope: { mode: "all_accounts", accountIds: [], messageIds: [] },
    messages: [message],
  });

  it("flags a transcript whose newest turn has no assistant reply yet", () => {
    expect(lastMessageIsUnanswered(conversation({
      id: "user-1",
      role: "user",
      content: "继续",
      createdAt: "2026-08-10T00:00:00.000Z",
      state: "complete",
      citations: [],
      toolActivities: [],
    }))).toBe(true);
  });

  it("does not flag transcripts that end with an assistant reply", () => {
    expect(lastMessageIsUnanswered(conversation({
      id: "assistant-1",
      role: "assistant",
      content: "完成",
      createdAt: "2026-08-10T00:00:00.000Z",
      state: "complete",
      citations: [],
      toolActivities: [],
    }))).toBe(false);
  });

  it("does not flag an empty transcript", () => {
    expect(lastMessageIsUnanswered({ ...conversation({} as AgentMessage), messages: [] })).toBe(false);
  });
});

describe("lastMessageIsStreaming", () => {
  const conversation = (message: AgentMessage): AgentConversation => ({
    id: "conversation-1",
    title: "测试",
    preview: "",
    updatedAt: "2026-08-10T00:00:00.000Z",
    providerId: "provider-1",
    scope: { mode: "all_accounts", accountIds: [], messageIds: [] },
    messages: [message],
  });

  it("flags an assistant reply that is still streaming (reopened mid-run snapshot)", () => {
    expect(lastMessageIsStreaming(conversation({
      id: "assistant-1",
      role: "assistant",
      content: "部分内容",
      createdAt: "2026-08-10T00:00:00.000Z",
      state: "streaming",
      citations: [],
      toolActivities: [{ id: "tool-1", toolName: "rag.search", title: "Search", state: "running" }],
    }))).toBe(true);
  });

  it("does not flag a completed assistant reply or a pending user message", () => {
    expect(lastMessageIsStreaming(conversation({
      id: "assistant-1", role: "assistant", content: "完成", createdAt: "2026-08-10T00:00:00.000Z",
      state: "complete", citations: [], toolActivities: [],
    }))).toBe(false);
    expect(lastMessageIsStreaming(conversation({
      id: "user-1", role: "user", content: "继续", createdAt: "2026-08-10T00:00:00.000Z",
      state: "complete", citations: [], toolActivities: [],
    }))).toBe(false);
  });
});

describe("mergeRevokedMarks", () => {
  const turn = (id: string, role: "user" | "assistant", content: string): AgentMessage => ({
    id,
    role,
    content,
    createdAt: "2026-08-10T00:00:00.000Z",
    state: "complete",
    citations: [],
    toolActivities: [],
  });

  const conversation = (messages: AgentMessage[]): AgentConversation => ({
    id: "conversation-1",
    title: "测试",
    preview: "",
    updatedAt: "2026-08-10T00:00:00.000Z",
    providerId: "provider-1",
    scope: { mode: "all_accounts", accountIds: [], messageIds: [] },
    messages,
  });

  it("keeps the server's revoked marks even when the local cache is empty", () => {
    const input = conversation([{ ...turn("user-1", "user", "hi"), revoked: true }, turn("assistant-1", "assistant", "reply")]);
    const result = mergeRevokedMarks(input, new Set());
    expect(result.messages[0]?.revoked).toBe(true);
    expect(result.messages[1]?.revoked).toBeUndefined();
  });

  it("applies local cache marks when the server snapshot predates the revoke", () => {
    const input = conversation([turn("user-1", "user", "hi"), turn("assistant-1", "assistant", "reply")]);
    const result = mergeRevokedMarks(input, new Set(["assistant-1"]));
    expect(result.messages[0]?.revoked).toBeUndefined();
    expect(result.messages[1]?.revoked).toBe(true);
  });

  it("leaves the conversation untouched when nothing is revoked", () => {
    const input = conversation([turn("user-1", "user", "hi")]);
    expect(mergeRevokedMarks(input, new Set())).toBe(input);
  });
});
