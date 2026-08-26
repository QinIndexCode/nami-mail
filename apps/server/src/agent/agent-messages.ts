/**
 * Agent message catalog with multi-locale support.
 *
 * All user-facing messages emitted by the Agent service are defined here with
 * translations for each supported locale. New locales can be added by
 * extending the `AgentMessages` type and the `agentMessageCatalog` object.
 *
 * Message keys use dot notation (e.g. `status.preparing_context`) and support
 * `{placeholder}` interpolation.
 */

import type { SupportedLocale } from "../localization.js";

/** Agent message keys — each maps to a set of locale-specific translations. */
export const agentMessageCatalog = {
  "status.preparing_context": {
    "zh-CN": "正在准备对话上下文…",
    "en-US": "Preparing conversation context…",
  },
  "status.cloud_not_authorized": {
    "zh-CN": "当前云端模型未获邮件内容授权，本次不会发送任何邮件上下文。",
    "en-US": "The cloud model is not authorized to access mail content; no mail context will be sent.",
  },
  "status.tool_call_limit": {
    "zh-CN": "邮件助理连续请求了过多操作，已停止本次处理。",
    "en-US": "The mail assistant requested too many operations in a row; processing has been stopped.",
  },
  "status.desktop_confirm_failed": {
    "zh-CN": "桌面确认无法完成，操作未执行。",
    "en-US": "Desktop confirmation could not be completed; the operation was not executed.",
  },
  "status.desktop_confirm_expired": {
    "zh-CN": "桌面确认已过期，操作未执行。",
    "en-US": "Desktop confirmation expired; the operation was not executed.",
  },
  "status.desktop_confirm_rejected": {
    "zh-CN": "桌面确认未获批准，操作未执行。",
    "en-US": "Desktop confirmation was not approved; the operation was not executed.",
  },
  "status.desktop_confirm_waiting": {
    "zh-CN": "正在等待桌面确认。",
    "en-US": "Waiting for desktop confirmation.",
  },
  "status.operation_completed": {
    "zh-CN": "操作已完成。",
    "en-US": "Operation completed.",
  },
  "status.rag_found": {
    "zh-CN": "找到 {count} 条相关邮件内容。",
    "en-US": "Found {count} relevant mail message(s).",
  },
  "status.rag_empty": {
    "zh-CN": "未找到可引用的相关邮件内容。",
    "en-US": "No relevant mail content found to cite.",
  },
  "context.rag_retrieved_label": {
    "zh-CN": "以下邮件是你（Agent）从用户本地邮箱中检索到的候选内容，仅供回答时参考。它们不是用户发送给你的消息，用户并未引用或提供这些邮件。只有在与用户问题相关时才可引用；不要在回答中声称用户发送或提到了这些邮件。",
    "en-US": "The messages below are candidates you (the Agent) retrieved from the user's local mailbox for reference only. They are NOT messages the user sent you, and the user did not quote or provide them. Only cite them when directly relevant to the user's question; never claim the user sent or mentioned these messages.",
  },
  "status.empty_mailbox_hint": {
    "zh-CN": "当前邮箱中没有邮件",
    "en-US": "There are no emails in the current mailbox",
  },
  "status.empty_mailbox_alt": {
    "zh-CN": "该账户暂无邮件",
    "en-US": "This account has no emails yet",
  },
  "status.mcp_tools_loaded": {
    "zh-CN": "已接入 {count} 个外部 MCP 工具。",
    "en-US": "Connected {count} external MCP tool(s).",
  },
  "status.mcp_server_unavailable": {
    "zh-CN": "MCP 服务器 {label} 连接失败，本次未使用其工具。",
    "en-US": "MCP server {label} could not be reached; its tools are not available this run.",
  },
  "status.model_retry": {
    "zh-CN": "网络波动，正在自动重试模型请求（{attempt}/{max}）…",
    "en-US": "Network hiccup; retrying the model request ({attempt}/{max})…",
  },

  "permission.system_prompt_intro": {
    "zh-CN": "以下是你当前生效的权限档位。用户可能在任意时刻在界面上切换档位；每一轮本提示词都会按最新档位重新生成。回答与权限相关的问题时，只依据本节内容，不要仅凭工具列表推断。",
    "en-US": "This is your currently active permission level. The user can switch levels in the UI at any time; this prompt is regenerated every turn with the latest level. When answering permission-related questions, rely only on this section, not on the tool list alone.",
  },
  "permission.level.read_only": {
    "zh-CN": "只读",
    "en-US": "Read only",
  },
  "permission.level.send_confirmed": {
    "zh-CN": "确认",
    "en-US": "Confirm",
  },
  "permission.level.full_access": {
    "zh-CN": "全部",
    "en-US": "Full access",
  },
  "permission.policy.read_only": {
    "zh-CN": "你只能阅读和搜索邮件，不能创建、编辑或删除草稿，不能发送、移动或标记邮件。任何写操作都会因权限不足被拒绝。",
    "en-US": "You can only read and search mail. You cannot create, edit, or delete drafts, and you cannot send, move, or flag mail. Any write operation will be denied for insufficient permission.",
  },
  "permission.policy.send_confirmed": {
    "zh-CN": "所有写操作（包括发送）执行前都会弹出可见的桌面确认，等待用户批准后才执行；读操作无需确认。",
    "en-US": "Every write operation (including sending) shows a visible desktop confirmation and only executes after the user approves it; read operations need no confirmation.",
  },
  "permission.policy.full_access": {
    "zh-CN": "已授权范围内的全部操作（包括发送邮件与固有高风险操作）都会自动执行，不再逐项弹出确认；此档位须在开启前明确知悉风险。",
    "en-US": "Every operation in the authorized scope, including sending mail and inherently high-risk work, runs automatically without per-step confirmations; you must acknowledge the risks before enabling this level.",
  },
  "permission.denied_hint": {
    "zh-CN": "若某个工具请求超出当前档位，它会被拒绝并返回权限不足错误；不要声称已执行被拒绝的操作。",
    "en-US": "If a tool request exceeds this level, it will be denied with a permission error; do not claim to have performed an action that was denied.",
  },
  "permission.available_tools_intro": {
    "zh-CN": "以下是本轮可调用的工具（已按当前权限档位过滤，只列出实际可用的工具）：",
    "en-US": "These are the tools you can call this turn (already filtered by your current permission level, so only usable tools are listed):",
  },
  "permission.available_tools_empty": {
    "zh-CN": "（当前档位下本轮没有可用工具）",
    "en-US": "(No tools are available at the current permission level this turn.)",
  },
  "attachment.guidance": {
    "zh-CN": "以下用户上传的文件已作为邮件附件就绪。若要在邮件中附带它们，请把对应 token 填入 mail.draft.create、mail.draft.update、messages.send 或 mail.reply 的 attachmentTokens 参数；每个附件绑定在其所列账户下，仅当发送账户与之相同时才可使用：",
    "en-US": "The following files uploaded by the user are ready as mail attachments. To attach them, pass the matching tokens in the attachmentTokens field of mail.draft.create, mail.draft.update, messages.send, or mail.reply. Each attachment is bound to the account listed next to it and can only be used when that account is the sender:",
  },

  "confirmation.title.create_draft": {
    "zh-CN": "创建邮件草稿",
    "en-US": "Create mail draft",
  },
  "confirmation.title.update_draft": {
    "zh-CN": "更新邮件草稿",
    "en-US": "Update mail draft",
  },
  "confirmation.title.delete_draft": {
    "zh-CN": "删除邮件草稿",
    "en-US": "Delete mail draft",
  },
  "confirmation.title.move_mail": {
    "zh-CN": "移动邮件",
    "en-US": "Move mail message",
  },
  "confirmation.title.set_flag": {
    "zh-CN": "设置邮件标记",
    "en-US": "Set mail message flag",
  },
  "confirmation.title.clear_flag": {
    "zh-CN": "清除邮件标记",
    "en-US": "Clear mail message flag",
  },
  "confirmation.title.send_mail": {
    "zh-CN": "发送邮件",
    "en-US": "Send mail message",
  },
  "confirmation.title.reply_mail": {
    "zh-CN": "创建回复草稿",
    "en-US": "Create reply draft",
  },
  "confirmation.title.create_calendar_event": {
    "zh-CN": "创建日历事件",
    "en-US": "Create calendar event",
  },
  "confirmation.title.update_calendar_event": {
    "zh-CN": "更新日历事件",
    "en-US": "Update calendar event",
  },
  "confirmation.title.delete_calendar_event": {
    "zh-CN": "删除日历事件",
    "en-US": "Delete calendar event",
  },
  "confirmation.title.mcp_write": {
    "zh-CN": "调用外部 MCP 工具 {name}",
    "en-US": "Run external MCP tool {name}",
  },
  "confirmation.title.delete_account": {
    "zh-CN": "删除邮箱账户",
    "en-US": "Delete mail account",
  },
  "confirmation.summary.create_draft": {
    "zh-CN": "保存草稿前请核对收件人、主题与正文内容。草稿将保存到所选邮箱。",
    "en-US": "Review the recipients, subject, and message before saving this draft to the selected mailbox.",
  },
  "confirmation.summary.update_draft": {
    "zh-CN": "更新草稿前请核对新的正文内容。草稿将保存到所选邮箱。",
    "en-US": "Review the replacement content before updating this draft in the selected mailbox.",
  },
  "confirmation.summary.delete_draft": {
    "zh-CN": "永久删除草稿前请核对账户与草稿标识。删除后不可恢复。",
    "en-US": "Review the account and draft identifier before permanently removing this draft from the selected mailbox.",
  },
  "confirmation.summary.move_mail": {
    "zh-CN": "移动到 {target} 前请核对邮件标识。该操作会修改服务器上的邮件状态。",
    "en-US": "Review the message identifier before moving it to {target}. This action affects mail state on the server.",
  },
  "confirmation.summary.set_flag": {
    "zh-CN": "设置 {flag} 标记前请核对邮件标识。该操作会修改服务器上的邮件状态。",
    "en-US": "Review the message identifier before setting the {flag} flag. This action affects mail state on the server.",
  },
  "confirmation.summary.clear_flag": {
    "zh-CN": "清除 {flag} 标记前请核对邮件标识。该操作会修改服务器上的邮件状态。",
    "en-US": "Review the message identifier before clearing the {flag} flag. This action affects mail state on the server.",
  },
  "confirmation.summary.send_mail": {
    "zh-CN": "发送前请核对收件人与正文内容。邮件发送后无法撤回。",
    "en-US": "Review the recipients and content before sending this message. The message cannot be recalled after it is sent.",
  },
  "confirmation.summary.reply_mail": {
    "zh-CN": "保存回复草稿前请核对收件人与正文内容。草稿将保存到所选邮箱。",
    "en-US": "Review the recipients and content before saving this reply as a draft to the selected mailbox.",
  },
  "confirmation.summary.create_calendar_event": {
    "zh-CN": "创建日历事件前请核对标题、起止时间与说明。事件仅保存在本机。",
    "en-US": "Review the title, start/end time, and details before adding this event to the local calendar.",
  },
  "confirmation.summary.update_calendar_event": {
    "zh-CN": "更新日历事件前请核对新的标题、起止时间与说明。事件仅保存在本机。",
    "en-US": "Review the replacement title, start/end time, and details before updating this local calendar event.",
  },
  "confirmation.summary.delete_calendar_event": {
    "zh-CN": "删除日历事件前请核对事件标识与标题。删除后不可恢复。",
    "en-US": "Review the event identifier and title before permanently removing this local calendar event.",
  },
  "confirmation.summary.mcp_write": {
    "zh-CN": "{server} 是你配置的外部 MCP 服务器。该写操作可能修改文件、数据或远程服务，请核对参数后再继续。",
    "en-US": "{server} is an external MCP server you configured. This write operation may change files, data, or remote services. Review the arguments before continuing.",
  },
  "confirmation.summary.delete_account": {
    "zh-CN": "删除账户前请核对账户标识。该操作会移除本地配置、凭据与同步邮件，且无法撤销；服务器上的邮箱内容不受影响。",
    "en-US": "Review the account identifier before permanently removing this account. Local configuration, credentials, and synced mail are deleted and cannot be recovered; the mailbox on the server is unaffected.",
  },
  "confirmation.field.account": {
    "zh-CN": "账户",
    "en-US": "Account",
  },
  "confirmation.field.draft_id": {
    "zh-CN": "草稿 ID",
    "en-US": "Draft ID",
  },
  "confirmation.field.to": {
    "zh-CN": "收件人",
    "en-US": "To",
  },
  "confirmation.field.cc": {
    "zh-CN": "抄送",
    "en-US": "Cc",
  },
  "confirmation.field.subject": {
    "zh-CN": "主题",
    "en-US": "Subject",
  },
  "confirmation.field.message_id": {
    "zh-CN": "邮件 ID",
    "en-US": "Message ID",
  },
  "confirmation.field.target": {
    "zh-CN": "目标文件夹",
    "en-US": "Target",
  },
  "confirmation.field.flag": {
    "zh-CN": "标记",
    "en-US": "Flag",
  },
  "confirmation.field.value": {
    "zh-CN": "值",
    "en-US": "Value",
  },
  "confirmation.value.set": {
    "zh-CN": "设置",
    "en-US": "set",
  },
  "confirmation.value.cleared": {
    "zh-CN": "清除",
    "en-US": "cleared",
  },
  "confirmation.field.replying_to": {
    "zh-CN": "回复的邮件",
    "en-US": "Replying to message",
  },
  "confirmation.field.event_id": {
    "zh-CN": "事件 ID",
    "en-US": "Event ID",
  },
  "confirmation.field.event_title": {
    "zh-CN": "事件标题",
    "en-US": "Event title",
  },
  "confirmation.field.starts_at": {
    "zh-CN": "开始时间",
    "en-US": "Starts at",
  },
  "confirmation.field.ends_at": {
    "zh-CN": "结束时间",
    "en-US": "Ends at",
  },
  "confirmation.field.event_location": {
    "zh-CN": "地点",
    "en-US": "Location",
  },
  "confirmation.field.event_description": {
    "zh-CN": "事件说明",
    "en-US": "Details",
  },
  "confirmation.field.body_preview": {
    "zh-CN": "正文预览（{count} 字符）",
    "en-US": "Body preview ({count} characters)",
  },
  "confirmation.field.attachments": {
    "zh-CN": "附件",
    "en-US": "Attachments",
  },
  "confirmation.value.attachments_count": {
    "zh-CN": "{count} 个附件",
    "en-US": "{count} attachment(s)",
  },
  "confirmation.value.no_subject": {
    "zh-CN": "（无主题）",
    "en-US": "(no subject)",
  },
  "confirmation.value.derived_subject": {
    "zh-CN": "（沿用原主题）",
    "en-US": "(derived from original subject)",
  },
  "confirmation.value.none": {
    "zh-CN": "无",
    "en-US": "None",
  },
  "confirmation.value.empty": {
    "zh-CN": "（空）",
    "en-US": "(empty)",
  },

  "error.conversation_conflict": {
    "zh-CN": "该会话正在生成回复，请先停止当前回复。",
    "en-US": "This conversation is already generating a reply; please stop the current reply first.",
  },
  "error.agent_mode_invalid": {
    "zh-CN": "Agent 模式无效。",
    "en-US": "Invalid Agent mode.",
  },
  "error.command_requires_agent_mode": {
    "zh-CN": "指令 /{command} 需要使用邮件工具，请先切换到邮件助手模式。",
    "en-US": "Command /{command} needs the mail tools. Switch to the mail assistant mode first.",
  },
  "error.command_param_required": {
    "zh-CN": "指令 /{command} 缺少参数。用法：/{command} <参数>",
    "en-US": "Command /{command} is missing an argument. Usage: /{command} <argument>",
  },
  "error.command_no_param": {
    "zh-CN": "指令 /{command} 不需要参数。",
    "en-US": "Command /{command} does not take arguments.",
  },
  "error.provider_not_found": {
    "zh-CN": "选择的模型配置不存在。",
    "en-US": "The selected model configuration does not exist.",
  },
  "error.provider_incomplete": {
    "zh-CN": "模型配置尚未完成。请检查地址、模型名称和 API Key。",
    "en-US": "Model configuration is incomplete. Please check the endpoint, model name, and API key.",
  },
  "error.scope_invalid": {
    "zh-CN": "邮件上下文范围无效。",
    "en-US": "Invalid mail context scope.",
  },
  "error.scope_empty": {
    "zh-CN": "当前邮件上下文为空。",
    "en-US": "The current mail context is empty.",
  },
  "error.messages_not_found": {
    "zh-CN": "部分邮件已不存在。",
    "en-US": "Some messages no longer exist.",
  },
  "error.account_unavailable": {
    "zh-CN": "请先添加至少一个可用邮箱。",
    "en-US": "Please add at least one available mail account first.",
  },
  "error.account_unavailable_selected": {
    "zh-CN": "选择的邮箱已不可用。",
    "en-US": "The selected mail account is no longer available.",
  },
  "error.account_stale_read": {
    "zh-CN": "会话关联的邮箱状态已变化，无法继续读取。",
    "en-US": "The mail account linked to this conversation has changed; cannot continue reading.",
  },
  "error.account_stale_stopped": {
    "zh-CN": "会话关联的邮箱状态已变化，已停止 Agent 处理。",
    "en-US": "The mail account linked to this conversation has changed; Agent processing has been stopped.",
  },
  "error.scope_fixed": {
    "zh-CN": "会话的邮件范围已固定。请新建会话以使用新的上下文范围。",
    "en-US": "The conversation's mail scope is fixed. Please create a new conversation to use a different context scope.",
  },
  "error.agent_cancelled": {
    "zh-CN": "Agent 生成已停止。",
    "en-US": "Agent generation has been stopped.",
  },
  "error.desktop_confirm_cancelled": {
    "zh-CN": "桌面确认已取消，Agent 处理已停止。",
    "en-US": "Desktop confirmation was cancelled; Agent processing has been stopped.",
  },
  "error.conversation_not_found": {
    "zh-CN": "会话不存在或关联邮箱已不可用。",
    "en-US": "The conversation does not exist or its linked mail account is unavailable.",
  },
  "error.agent_internal": {
    "zh-CN": "Agent 本地服务未能完成请求。",
    "en-US": "The Agent local service failed to complete the request.",
  },
  "error.agent_request_failed": {
    "zh-CN": "Agent 请求未能完成，请稍后重试。",
    "en-US": "The Agent request could not be completed; please try again later.",
  },
  "error.health_check_cancelled": {
    "zh-CN": "模型连接检查已取消。",
    "en-US": "Model connection check was cancelled.",
  },
  "error.provider_changed": {
    "zh-CN": "模型配置在连接检查期间已更新，请重新检查。",
    "en-US": "Model configuration was updated during the connection check; please re-check.",
  },
  "error.config_not_found": {
    "zh-CN": "模型配置不存在。",
    "en-US": "Model configuration does not exist.",
  },
  "error.config_unreadable": {
    "zh-CN": "模型配置无法读取。",
    "en-US": "Model configuration could not be read.",
  },
  "error.config_format_invalid": {
    "zh-CN": "模型配置格式无效。",
    "en-US": "Model configuration format is invalid.",
  },
  "error.config_version_unsupported": {
    "zh-CN": "模型配置版本不受支持。",
    "en-US": "Model configuration version is not supported.",
  },
  "error.default_config_unreadable": {
    "zh-CN": "默认模型配置无法读取。",
    "en-US": "Default model configuration could not be read.",
  },
  "error.timeout_range": {
    "zh-CN": "模型超时时间必须介于 1 秒和 120 秒之间。",
    "en-US": "Model timeout must be between 1 and 120 seconds.",
  },
  "error.endpoint_not_url": {
    "zh-CN": "模型服务地址不是有效 URL。",
    "en-US": "The model endpoint is not a valid URL.",
  },
  "error.endpoint_https_required": {
    "zh-CN": "模型服务地址必须使用 HTTPS，或指向本机回环 HTTP 服务。",
    "en-US": "The model endpoint must use HTTPS, or point to a local loopback HTTP service.",
  },
  "error.endpoint_no_extras": {
    "zh-CN": "模型服务地址不能包含账号、查询参数或片段。",
    "en-US": "The model endpoint must not contain credentials, query parameters, or fragments.",
  },
  "error.metadata_unreadable": {
    "zh-CN": "会话元数据无法读取。",
    "en-US": "Conversation metadata could not be read.",
  },
  "error.scope_unreadable": {
    "zh-CN": "会话范围无法读取。",
    "en-US": "Conversation scope could not be read.",
  },

  "hint.add_provider": {
    "zh-CN": "请先在模型设置中添加一个 OpenAI 兼容服务或本地 Ollama。",
    "en-US": "Please add an OpenAI-compatible service or local Ollama in model settings first.",
  },
  "hint.add_account": {
    "zh-CN": "添加邮箱后即可在 Agent 中使用邮件上下文。",
    "en-US": "Add a mail account to use mail context in Agent.",
  },

  "label.new_conversation": {
    "zh-CN": "新对话",
    "en-US": "New conversation",
  },
} as const;

/** Agent message key type, derived from the catalog. */
export type AgentMessageKey = keyof typeof agentMessageCatalog;

/**
 * Translate an Agent message key to the specified locale, interpolating
 * `{placeholder}` values from the optional params object.
 *
 * Falls back to zh-CN if the locale is not in the catalog for a given key,
 * and to the key itself if the key is not found at all.
 */
export function agentT(
  locale: SupportedLocale,
  key: AgentMessageKey,
  params?: Record<string, string | number>,
): string {
  const entry = agentMessageCatalog[key];
  if (!entry) return key;
  const template: string = (entry as Record<string, string>)[locale] ?? entry["zh-CN"] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_match: string, name: string) => {
    const value = params[name];
    return value !== undefined ? String(value) : `{${name}}`;
  });
}
