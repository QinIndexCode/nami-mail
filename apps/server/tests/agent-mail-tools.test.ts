import { describe, expect, it, vi } from "vitest";
import { createToolRegistry, type AgentToolExecutionContext } from "@nami/agent-core";
import type { MailApplicationService } from "../src/agent/mail-application-service.js";
import { createMailTools } from "../src/agent/mail-tools.js";

const timestamp = "2026-07-27T12:00:00.000Z";

function caller() {
  return {
    callerId: "test-user",
    kind: "test" as const,
    entryPoint: "test" as const,
    accessLevel: "full-access" as const,
    scopes: ["read:accounts", "read:folders", "read:messages", "read:attachments", "write:drafts"] as const,
    accountScope: { mode: "selected" as const, accountIds: ["account-1"] },
    interactive: true,
    canRequestConfirmation: true,
  };
}

function context(
  accountIds: readonly string[] = ["account-1"],
  allowedMessageIds?: readonly string[],
): AgentToolExecutionContext {
  return {
    requestId: "9d65af5e-b4d2-4b31-9131-f1e3c3b93d20",
    caller: caller(),
    accountIds,
    ...(allowedMessageIds === undefined ? {} : { allowedMessageIds }),
  };
}

function call(toolName: string, input: unknown) {
  return {
    id: "call-1",
    toolName,
    input,
    requestedAt: timestamp,
  };
}

function mailMessage(id: string, accountId = "account-1", subject = "Private subject") {
  return {
    id,
    accountId,
    mailbox: "INBOX",
    threadId: "thread-1",
    subject,
    from: { name: "Sender", address: "sender@example.test" },
    sentAt: timestamp,
    snippet: "Preview text",
    flags: ["\\Seen"],
    hasAttachments: false,
  };
}

function mailDetail(id: string, accountId = "account-1", subject = "Private subject") {
  return {
    ...mailMessage(id, accountId, subject),
    to: [{ name: "Recipient", address: "recipient@example.test" }],
    cc: [],
    textBody: "PRIVATE_MESSAGE_BODY",
    htmlBody: "<p>PRIVATE_MESSAGE_HTML</p>",
    citations: [],
  };
}

function fakeMailApplication() {
  const listAccounts = vi.fn(async () => []);
  const listFolders = vi.fn(async () => []);
  const listMessages = vi.fn(async () => ({ items: [] }));
  const getMessage = vi.fn(async () => undefined);
  const getThread = vi.fn(async () => []);
  const listAttachments = vi.fn(async () => []);
  const syncAccount = vi.fn(async () => ({ synced: 0, failedFolders: 0 }));
  const createDraft = vi.fn(async () => ({
    id: "<draft-1@example.test>",
    accountId: "account-1",
    subject: "Draft subject",
    recipients: [{ name: "Recipient", address: "recipient@example.test" }],
    updatedAt: timestamp,
  }));
  const updateDraft = vi.fn(async () => ({
    id: "<draft-1@example.test>",
    accountId: "account-1",
    subject: "Draft subject",
    recipients: [{ name: "Recipient", address: "recipient@example.test" }],
    updatedAt: timestamp,
  }));
  const deleteDraft = vi.fn(async () => undefined);
  const updateMessageFlags = vi.fn(async () => undefined);
  const moveMessage = vi.fn(async () => undefined);
  const prepareSubmission = vi.fn(async () => ({
    submissionId: "submission-1",
    idempotencyKey: "key-1",
    accountId: "account-1",
    status: "pending" as const,
  }));
  const submitPreparedMail = vi.fn(async () => ({
    submissionId: "submission-1",
    idempotencyKey: "key-1",
    accountId: "account-1",
    status: "pending" as const,
  }));

  const service: MailApplicationService = {
    listAccounts,
    listFolders,
    listMessages,
    getMessage,
    getThread,
    listAttachments,
    syncAccount,
    createDraft,
    updateDraft,
    deleteDraft,
    updateMessageFlags,
    moveMessage,
    prepareSubmission,
    submitPreparedMail,
  };
  return { service, listFolders, listMessages, getMessage, getThread, listAttachments, createDraft, updateDraft, deleteDraft };
}

describe("Agent mail tools", () => {
  it("rejects strict invalid input before any mail facade method runs", () => {
    const fake = fakeMailApplication();
    const registry = createToolRegistry(createMailTools(fake.service));

    const resolution = registry.resolve(call("messages.list", { limit: 10, unexpected: true }));

    expect(resolution).toMatchObject({ ok: false, error: { code: "TOOL_INPUT_INVALID" } });
    expect(fake.listMessages).not.toHaveBeenCalled();
  });

  it("denies an explicit account outside the execution context before calling the facade", async () => {
    const fake = fakeMailApplication();
    const registry = createToolRegistry(createMailTools(fake.service));
    const draftTool = registry.get("mail.draft.create");
    expect(draftTool).toBeDefined();

    const outcome = await draftTool!.execute(context(), {
      accountId: "account-2",
      to: [{ address: "recipient@example.test" }],
      subject: "Scope check",
      text: "Private draft body",
    });

    expect(outcome).toMatchObject({ ok: false, error: { code: "SCOPE_DENIED" } });
    expect(fake.createDraft).not.toHaveBeenCalled();
  });

  it("creates a scoped draft and returns only safe draft metadata", async () => {
    const fake = fakeMailApplication();
    const registry = createToolRegistry(createMailTools(fake.service));
    const draftTool = registry.get("mail.draft.create");
    expect(draftTool).toBeDefined();

    const outcome = await draftTool!.execute(context(), {
      accountId: "account-1",
      to: [{ name: "Recipient", address: "recipient@example.test" }],
      cc: [{ address: "copy@example.test" }],
      subject: "Draft subject",
      text: "PRIVATE_DRAFT_BODY",
    });

    expect(outcome).toMatchObject({
      ok: true,
      value: {
        draft: {
          id: "<draft-1@example.test>",
          accountId: "account-1",
          subject: "Draft subject",
        },
      },
    });
    if (outcome.ok) expect(JSON.stringify(outcome.value)).not.toContain("PRIVATE_DRAFT_BODY");
    expect(fake.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({ accountIds: ["account-1"] }),
      expect.objectContaining({
        accountId: "account-1",
        text: "PRIVATE_DRAFT_BODY",
        to: [{ name: "Recipient", address: "recipient@example.test" }],
      }),
    );
    expect(draftTool!.descriptor).toMatchObject({
      executionMode: "draft",
      requiredScopes: ["write:drafts"],
      availableToExternal: false,
      confirmationPolicy: "required",
      confirmationAction: "create-draft",
    });
    expect(draftTool!.confirmationPreview?.({
      accountId: "account-1",
      to: [{ address: "recipient@example.test" }],
      subject: "Draft subject",
      text: "PRIVATE_DRAFT_BODY",
    })).toMatchObject({
      title: "Create mail draft",
      fields: expect.arrayContaining([
        expect.objectContaining({ label: "Body preview (18 characters)", value: "PRIVATE_DRAFT_BODY" }),
      ]),
    });
  });

  it("updates and deletes only scoped drafts after the Runtime has authorized their confirmation", async () => {
    const fake = fakeMailApplication();
    const registry = createToolRegistry(createMailTools(fake.service));
    const updateTool = registry.get("mail.draft.update");
    const deleteTool = registry.get("mail.draft.delete");
    expect(updateTool).toBeDefined();
    expect(deleteTool).toBeDefined();

    const update = await updateTool!.execute(context(["account-1"], ["draft-1"]), {
      draftId: "draft-1",
      accountId: "account-1",
      to: [{ address: "recipient@example.test" }],
      subject: "Updated subject",
      text: "PRIVATE_UPDATED_DRAFT_BODY",
    });
    const deletion = await deleteTool!.execute(context(["account-1"], ["draft-1"]), { accountId: "account-1", draftId: "draft-1" });

    expect(update).toMatchObject({ ok: true, value: { draft: { accountId: "account-1", subject: "Draft subject" } } });
    expect(JSON.stringify(update)).not.toContain("PRIVATE_UPDATED_DRAFT_BODY");
    expect(deletion).toEqual({ ok: true, value: { accountId: "account-1", draftId: "draft-1", deleted: true } });
    expect(fake.updateDraft).toHaveBeenCalledWith(
      expect.objectContaining({ accountIds: ["account-1"] }),
      expect.objectContaining({ draftId: "draft-1", text: "PRIVATE_UPDATED_DRAFT_BODY" }),
    );
    expect(fake.deleteDraft).toHaveBeenCalledWith(expect.objectContaining({ accountIds: ["account-1"] }), "account-1", "draft-1");
    expect(updateTool!.descriptor).toMatchObject({ confirmationPolicy: "required", confirmationAction: "update-draft" });
    expect(deleteTool!.descriptor).toMatchObject({ confirmationPolicy: "required", confirmationAction: "delete-draft" });
    expect(deleteTool!.confirmationPreview?.({ accountId: "account-1", draftId: "draft-1" })).toMatchObject({
      fields: [
        { label: "Account", value: "account-1" },
        { label: "Draft ID", value: "draft-1" },
      ],
    });
  });

  it("does not present an in-flight draft cancellation as a safe retry", async () => {
    const fake = fakeMailApplication();
    fake.createDraft.mockRejectedValueOnce(Object.assign(
      new Error("The remote IMAP APPEND outcome is unknown."),
      { code: "draft_operation_outcome_unknown" },
    ));
    const registry = createToolRegistry(createMailTools(fake.service));
    const draftTool = registry.get("mail.draft.create");
    expect(draftTool).toBeDefined();

    const outcome = await draftTool!.execute(context(), {
      accountId: "account-1",
      to: [{ address: "recipient@example.test" }],
      subject: "Draft subject",
      text: "PRIVATE_DRAFT_BODY",
    });

    expect(outcome).toMatchObject({
      ok: false,
      error: {
        code: "CONFLICT",
        retryable: false,
        suggestion: expect.stringContaining("Check Drafts"),
      },
    });
  });

  it("rejects draft updates and deletions outside the exact message scope before calling the facade", async () => {
    const fake = fakeMailApplication();
    const registry = createToolRegistry(createMailTools(fake.service));
    const updateTool = registry.get("mail.draft.update");
    const deleteTool = registry.get("mail.draft.delete");
    expect(updateTool).toBeDefined();
    expect(deleteTool).toBeDefined();

    const scopedContext = context(["account-1"], ["draft-in-scope"]);
    const update = await updateTool!.execute(scopedContext, {
      draftId: "draft-outside-scope",
      accountId: "account-1",
      to: [{ address: "recipient@example.test" }],
      subject: "Updated subject",
      text: "PRIVATE_UPDATED_DRAFT_BODY",
    });
    const deletion = await deleteTool!.execute(scopedContext, {
      accountId: "account-1",
      draftId: "draft-outside-scope",
    });

    expect(update).toMatchObject({ ok: false, error: { code: "SCOPE_DENIED" } });
    expect(deletion).toMatchObject({ ok: false, error: { code: "SCOPE_DENIED" } });
    expect(fake.updateDraft).not.toHaveBeenCalled();
    expect(fake.deleteDraft).not.toHaveBeenCalled();
  });

  it("returns message metadata only from lists and forwards only the context account scope", async () => {
    const fake = fakeMailApplication();
    fake.listMessages.mockResolvedValue({
      items: [{
        id: "message-1",
        accountId: "account-1",
        mailbox: "INBOX",
        threadId: "thread-1",
        subject: "Private subject",
        from: { name: "Sender", address: "sender@example.test" },
        sentAt: timestamp,
        snippet: "Preview text",
        flags: ["\\Seen"],
        hasAttachments: false,
        textBody: "PRIVATE_LIST_BODY",
        htmlBody: "<p>PRIVATE_LIST_HTML</p>",
      }],
      nextCursor: "1",
    });
    const registry = createToolRegistry(createMailTools(fake.service));
    const messagesTool = registry.get("messages.list");
    expect(messagesTool).toBeDefined();

    const outcome = await messagesTool!.execute(context(["account-1"], ["message-1"]), { limit: 10 });

    expect(outcome).toMatchObject({
      ok: true,
      value: {
        messages: [{ id: "message-1", subject: "Private subject" }],
        nextCursor: "1",
      },
    });
    if (outcome.ok) {
      const serialized = JSON.stringify(outcome.value);
      expect(serialized).not.toContain("PRIVATE_LIST_BODY");
      expect(serialized).not.toContain("PRIVATE_LIST_HTML");
    }
    expect(fake.listMessages).toHaveBeenCalledWith(
      expect.objectContaining({ accountIds: ["account-1"], allowedMessageIds: ["message-1"] }),
      expect.objectContaining({ accountIds: ["account-1"], limit: 10 }),
    );
  });

  it("rejects direct reads outside an exact message scope before calling the facade", async () => {
    const fake = fakeMailApplication();
    const registry = createToolRegistry(createMailTools(fake.service));
    const messageTool = registry.get("messages.get");
    const attachmentsTool = registry.get("attachments.list");
    expect(messageTool).toBeDefined();
    expect(attachmentsTool).toBeDefined();

    const scoped = context(["account-1"], ["message-1"]);
    const messageOutcome = await messageTool!.execute(scoped, { messageId: "message-2" });
    const attachmentsOutcome = await attachmentsTool!.execute(scoped, { messageId: "message-2" });

    expect(messageOutcome).toMatchObject({ ok: false, error: { code: "SCOPE_DENIED" } });
    expect(attachmentsOutcome).toMatchObject({ ok: false, error: { code: "SCOPE_DENIED" } });
    expect(fake.getMessage).not.toHaveBeenCalled();
    expect(fake.listAttachments).not.toHaveBeenCalled();
  });

  it("fails closed when a mail facade returns messages outside the exact scope", async () => {
    const fake = fakeMailApplication();
    const registry = createToolRegistry(createMailTools(fake.service));
    const messagesTool = registry.get("messages.list");
    const messageTool = registry.get("messages.get");
    const threadTool = registry.get("threads.get");
    const attachmentsTool = registry.get("attachments.list");
    expect(messagesTool).toBeDefined();
    expect(messageTool).toBeDefined();
    expect(threadTool).toBeDefined();
    expect(attachmentsTool).toBeDefined();

    fake.listMessages.mockResolvedValue({
      items: [mailMessage("message-1"), mailMessage("message-2", "account-1", "SCOPE_ESCAPE_CANARY")],
    });
    fake.getMessage.mockResolvedValue(mailDetail("message-2", "account-1", "SCOPE_ESCAPE_CANARY"));
    fake.getThread.mockResolvedValue([
      mailDetail("message-1"),
      mailDetail("message-2", "account-1", "SCOPE_ESCAPE_CANARY"),
    ]);
    const scoped = context(["account-1"], ["message-1"]);

    const listOutcome = await messagesTool!.execute(scoped, { limit: 10 });
    const getOutcome = await messageTool!.execute(scoped, { messageId: "message-1" });
    const threadOutcome = await threadTool!.execute(scoped, { threadId: "thread-1" });
    const attachmentsOutcome = await attachmentsTool!.execute(scoped, { messageId: "message-1" });

    for (const outcome of [listOutcome, getOutcome, threadOutcome, attachmentsOutcome]) {
      expect(outcome).toMatchObject({ ok: false, error: { code: "SCOPE_DENIED" } });
      expect(JSON.stringify(outcome)).not.toContain("SCOPE_ESCAPE_CANARY");
    }
    expect(fake.listAttachments).not.toHaveBeenCalled();
  });
});
