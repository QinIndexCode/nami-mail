import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider, translate } from "./i18n";
import AgentMemoryDialog, { AgentMemoryItemCard, memoryKindLabel } from "./AgentMemoryDialog";
import type { AgentMemoryRecord } from "./agentTypes";
import type { Account } from "./types";

const zh = (key: string, values?: Record<string, string | number>) => translate("zh-CN", key, values);

const account: Account = {
  id: "account-1",
  email: "hello@example.com",
  provider: "gmail",
  providerName: "Gmail",
  status: "connected",
  lastError: null,
  lastSyncedAt: "2026-07-22T08:00:00.000Z",
  signature: "",
  createdAt: "2026-07-20T08:00:00.000Z",
  folders: [],
};

const record: AgentMemoryRecord = {
  id: "memory-1",
  kind: "auto-reply-sent",
  accountId: account.id,
  summary: "已回复张三 2026-07-22 关于项目进度的邮件",
  detail: "自动回复已发送，内容为确认邮件收到。",
  occurredAt: "2026-07-22T08:00:00.000Z",
  createdAt: "2026-07-22T08:00:00.000Z",
};

function renderCard(editing: boolean, armedDelete: boolean): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <AgentMemoryItemCard
        record={record}
        accountEmail={account.email}
        editing={editing}
        editDraft={record.summary}
        busy={false}
        armedDelete={armedDelete}
        onStartEdit={() => undefined}
        onEditDraftChange={() => undefined}
        onSaveEdit={() => undefined}
        onCancelEdit={() => undefined}
        onArmDelete={() => undefined}
        onDisarmDelete={() => undefined}
        onDelete={() => undefined}
      />
    </I18nProvider>,
  );
}

describe("agent memory manager", () => {
  it("renders a record with its kind badge, summary, detail and account", () => {
    const markup = renderCard(false, false);

    expect(markup).toContain(memoryKindLabel(record.kind, (key) => zh(key)));
    expect(markup).toContain(record.summary);
    expect(markup).toContain(record.detail);
    expect(markup).toContain(account.email);
    expect(markup).toContain(zh("agentMemory.edit"));
    expect(markup).toContain(zh("agentMemory.delete"));
  });

  it("switches to an inline editor and a two-step delete when armed", () => {
    const editingMarkup = renderCard(true, false);
    expect(editingMarkup).toContain(zh("agentMemory.save"));
    expect(editingMarkup).toContain(zh("common.cancel"));
    expect(editingMarkup).toContain(zh("agentMemory.editPlaceholder"));

    const armedMarkup = renderCard(false, true);
    expect(armedMarkup).toContain(zh("agentMemory.confirmDelete"));
    expect(armedMarkup).not.toContain(zh("agentMemory.editPlaceholder"));
  });

  it("keeps the manager dialog accessible and avoids a non-functioning clear action", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <AgentMemoryDialog accounts={[account]} onClose={() => undefined} />
      </I18nProvider>,
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain(zh("agentMemory.title"));
    expect(markup).toContain(zh("agentMemory.searchPlaceholder"));
    expect(markup).toContain(zh("agentMemory.clearAll"));
  });
});