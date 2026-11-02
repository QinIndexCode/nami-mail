export type BuiltinToolDomain = "mail" | "calendar" | "contacts" | "system";

export type BuiltinToolType = "read" | "write";

export interface BuiltinAgentTool {
  name: string;
  domain: BuiltinToolDomain;
  type: BuiltinToolType;
  descKey: string;
}

export const BUILTIN_AGENT_TOOLS: readonly BuiltinAgentTool[] = [
  // Mail Tools (17)
  { name: "accounts.list", domain: "mail", type: "read", descKey: "accountsList" },
  { name: "folders.list", domain: "mail", type: "read", descKey: "foldersList" },
  { name: "messages.list", domain: "mail", type: "read", descKey: "messagesList" },
  { name: "messages.get", domain: "mail", type: "read", descKey: "messageGet" },
  { name: "messages.batch_get", domain: "mail", type: "read", descKey: "messagesBatchGet" },
  { name: "messages.search", domain: "mail", type: "read", descKey: "messagesSearch" },
  { name: "mail.summarize", domain: "mail", type: "read", descKey: "mailSummarize" },
  { name: "threads.get", domain: "mail", type: "read", descKey: "threadsGet" },
  { name: "attachments.list", domain: "mail", type: "read", descKey: "attachmentsList" },
  { name: "mail.draft.create", domain: "mail", type: "write", descKey: "draftCreate" },
  { name: "mail.draft.update", domain: "mail", type: "write", descKey: "draftUpdate" },
  { name: "mail.draft.delete", domain: "mail", type: "write", descKey: "draftDelete" },
  { name: "messages.move", domain: "mail", type: "write", descKey: "messagesMove" },
  { name: "messages.set-flag", domain: "mail", type: "write", descKey: "messagesSetFlag" },
  { name: "messages.send", domain: "mail", type: "write", descKey: "messagesSend" },
  { name: "mail.reply", domain: "mail", type: "write", descKey: "mailReply" },
  { name: "accounts.delete", domain: "mail", type: "write", descKey: "accountsDelete" },

  // Calendar Tools (4)
  { name: "calendar.list", domain: "calendar", type: "read", descKey: "calendarList" },
  { name: "calendar.create", domain: "calendar", type: "write", descKey: "calendarCreate" },
  { name: "calendar.update", domain: "calendar", type: "write", descKey: "calendarUpdate" },
  { name: "calendar.delete", domain: "calendar", type: "write", descKey: "calendarDelete" },

  // Contacts Tools (4)
  { name: "contacts.search", domain: "contacts", type: "read", descKey: "contactsSearch" },
  { name: "contacts.create", domain: "contacts", type: "write", descKey: "contactsCreate" },
  { name: "contacts.update", domain: "contacts", type: "write", descKey: "contactsUpdate" },
  { name: "contacts.delete", domain: "contacts", type: "write", descKey: "contactsDelete" },

  // System & Memory Tools (8)
  { name: "memory.list", domain: "system", type: "read", descKey: "memoryList" },
  { name: "memory.save", domain: "system", type: "write", descKey: "memorySave" },
  { name: "memory.update", domain: "system", type: "write", descKey: "memoryUpdate" },
  { name: "memory.delete", domain: "system", type: "write", descKey: "memoryDelete" },
  { name: "auto-reply.declined.search", domain: "system", type: "read", descKey: "autoReplyDeclinedSearch" },
  { name: "time.now", domain: "system", type: "read", descKey: "timeNow" },
  { name: "web.search", domain: "system", type: "read", descKey: "webSearch" },
  { name: "settings.update", domain: "system", type: "write", descKey: "settingsUpdate" },
] as const;

export const BUILTIN_TOOL_DOMAINS: readonly BuiltinToolDomain[] = [
  "mail",
  "calendar",
  "contacts",
  "system",
] as const;
