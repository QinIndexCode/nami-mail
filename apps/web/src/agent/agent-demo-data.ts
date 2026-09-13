/**
 * Builds a fully populated sample conversation for demo mode so the transcript
 * styling (tool cards, citations, confirmations, quotes, attachments, errors,
 * streaming state) can be reviewed without a backend.
 *
 * Extracted from AgentWorkspace.tsx — zero functional changes.
 *
 * The sample is written in the interface language: an English first run used to
 * show a Chinese transcript because the copy was hard-coded here while every
 * other piece of demo data follows the locale.
 */
import type {
  AgentCitation,
  AgentConversation,
  AgentToolActivity,
} from "../agentTypes";

export function createDemoConversation(locale: string): AgentConversation {
  // Only two interface languages exist; anything else falls back to Chinese,
  // matching the fallback the i18n layer uses.
  const english = locale.toLowerCase().startsWith("en");
  const tr = (zh: string, en: string): string => (english ? en : zh);

  const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();
  const tool = (id: string, toolName: string, title: string, state: AgentToolActivity["state"], extra?: Partial<AgentToolActivity>): AgentToolActivity => ({
    id,
    toolName,
    title,
    state,
    ...extra,
  });
  const citation = (id: string, subject: string, sender: string, sentAt: string, excerpt: string, messageId = "demo-mail-1"): AgentCitation => ({
    id,
    messageId,
    accountId: "account-1",
    subject,
    sender,
    sentAt,
    excerpt,
    confidence: 0.97,
  });

  return {
    id: "demo-conversation-1",
    title: tr("季度回顾会议准备", "Quarterly review preparation"),
    preview: tr("明天上午还有什么安排吗？", "Anything on for tomorrow morning?"),
    updatedAt: minutesAgo(1),
    scope: { mode: "all_accounts", accountIds: ["account-1"], messageIds: [] },
    providerId: "demo-ollama",
    messages: [
      {
        id: "demo-msg-0",
        role: "system",
        content: tr(
          "已恢复会话记忆：与星辰科技的合作往来、本周 3 封待办邮件、2 个待确认日程。",
          "Session memory restored: the Xingchen Tech thread, 3 mails pending this week, 2 calendar items awaiting confirmation.",
        ),
        createdAt: minutesAgo(59),
        state: "complete",
        citations: [],
        toolActivities: [],
      },
      {
        id: "demo-msg-1",
        role: "user",
        content: tr("早上好，帮我看看今天有哪些需要关注的邮件？", "Good morning — which mails need my attention today?"),
        createdAt: minutesAgo(58),
        state: "complete",
        citations: [],
        toolActivities: [],
      },
      {
        id: "demo-msg-2",
        role: "assistant",
        content: english
          ? "Three mails are worth your attention today:\n\n1. **Xingchen Tech** confirmed the quarterly review and moved it to Tuesday 16:00;\n2. the **supplier invoice** arrived with an attachment and is waiting on your payment approval;\n3. a **security notice** says some account passwords rotate this week.\n\nWhich one should I open?"
          : "今天有 3 封值得关注的邮件：\n\n1. **星辰科技**确认了季度回顾会议，并把时间改到了周二下午 4 点；\n2. **供应商发票**已上传附件，等待你确认付款；\n3. **安全通知**提醒本周将轮换部分账户密码。\n\n需要我展开哪一封？",
        createdAt: minutesAgo(56),
        state: "complete",
        citations: [
          citation(
            "demo-cite-1",
            tr("季度回顾会议时间调整", "Quarterly review time changed"),
            tr("星辰科技 <meeting@xingchen.example>", "Xingchen Tech <meeting@xingchen.example>"),
            minutesAgo(120),
            tr(
              "季度回顾会议调整至周二 16:00，届时请提前准备供应商报价对比表。",
              "The quarterly review moved to Tuesday 16:00; please bring the supplier quote comparison table.",
            ),
          ),
          citation(
            "demo-cite-2",
            tr("6 月供应商发票", "June supplier invoice"),
            tr("财务部 <finance@nami.example>", "Finance <finance@nami.example>"),
            minutesAgo(300),
            tr("附上 6 月供应商发票，请在月底前完成确认。", "Attached is the June supplier invoice; please confirm it before month end."),
          ),
        ],
        toolActivities: [
          tool("demo-tool-1", "accounts.list", "accounts.list", "completed"),
          tool("demo-tool-2", "messages.list", "messages.list", "completed"),
          tool("demo-tool-3", "messages.get", "messages.get", "completed", { summary: tr("3 封邮件详情", "3 mail details") }),
        ],
      },
      {
        id: "demo-msg-3",
        role: "user",
        content: tr(
          "那封星辰科技的邮件说要提前讨论供应商报价，附件里是我整理的数据，帮我对一下。",
          "The Xingchen mail wants the supplier quote discussed up front — my numbers are in the attachment, please cross-check them.",
        ),
        createdAt: minutesAgo(40),
        state: "complete",
        citations: [],
        toolActivities: [],
        quote: tr(
          "季度回顾会议调整至周二 16:00，届时请提前准备供应商报价对比。",
          "The quarterly review moved to Tuesday 16:00; please have the supplier quote comparison ready.",
        ),
        attachments: [
          {
            name: tr("季度数据.xlsx", "Quarterly-data.xlsx"),
            type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            path: tr("C:\\Users\\demo\\Downloads\\季度数据.xlsx", "C:\\Users\\demo\\Downloads\\Quarterly-data.xlsx"),
            token: "out_demo_quarterly",
          },
        ],
      },
      {
        id: "demo-msg-4",
        role: "assistant",
        content: english
          ? "Cross-checked your data against the mail history:\n\n- the supplier quote Xingchen cited in June was **128,000**, which matches your sheet;\n- this mail moves the discussion from 14:00 to **16:00** because procurement has an audit in the morning;\n- bring: the quote comparison plus the first-half purchase volume summary."
          : "已结合你上传的数据与历史邮件核对：\n\n- 星辰科技在 6 月邮件中提及的供应商报价为 **12.8 万**，与你的数据表一致；\n- 本次邮件把讨论时间从 14:00 改到 **16:00**，原因是采购团队上午有评审会；\n- 建议准备：报价对比表 + 上半年采购量统计表。",
        createdAt: minutesAgo(38),
        state: "complete",
        citations: [
          citation(
            "demo-cite-3",
            tr("6 月供应商报价沟通", "June supplier quote discussion"),
            tr("星辰科技 <purchase@xingchen.example>", "Xingchen Tech <purchase@xingchen.example>"),
            minutesAgo(3000),
            tr("供应商报价 12.8 万，待月度会议确认。", "Supplier quote 128,000, pending confirmation at the monthly meeting."),
            "demo-mail-2",
          ),
        ],
        toolActivities: [
          tool("demo-tool-4", "rag.search", "rag.search", "completed", { summary: tr("匹配到 3 条历史记录", "Matched 3 history records") }),
          tool("demo-tool-5", "messages.get", "messages.get", "completed"),
        ],
      },
      {
        id: "demo-msg-5",
        role: "user",
        content: tr(
          "帮我起草一封回复，确认我们周二下午 4 点会参加，并询问需要准备什么材料。",
          "Draft a reply confirming we will join at 16:00 on Tuesday, and ask what we should prepare.",
        ),
        createdAt: minutesAgo(30),
        state: "complete",
        citations: [],
        toolActivities: [],
      },
      {
        id: "demo-msg-6",
        role: "assistant",
        content: tr(
          "草稿已创建，等你确认后就可以发送。需要修改措辞或收件人时告诉我即可。",
          "The draft is ready and waits for your approval. Tell me if the wording or the recipients should change.",
        ),
        createdAt: minutesAgo(28),
        state: "complete",
        citations: [],
        toolActivities: [
          tool("demo-tool-6", "mail.draft.create", "mail.draft.create", "completed"),
        ],
        confirmation: {
          id: "demo-confirm-1",
          title: tr("创建邮件草稿", "Create mail draft"),
          summary: tr("助手请求创建一封新草稿", "The assistant wants to create a new draft"),
          fields: [
            { label: tr("账户", "Account"), value: "hello@nami.example" },
            { label: tr("收件人", "To"), value: "meeting@xingchen.example" },
            { label: tr("主题", "Subject"), value: tr("确认参加季度回顾会议", "Confirming attendance at the quarterly review") },
            {
              label: tr("正文", "Body"),
              value: tr(
                "确认参加周二 16:00 的季度回顾会议，请告知需要提前准备的材料。",
                "Confirming we will join the quarterly review at 16:00 on Tuesday — please tell us what to prepare in advance.",
              ),
            },
          ],
          expiresAt: minutesAgo(28),
          state: "approved",
        },
      },
      {
        id: "demo-msg-7",
        role: "user",
        content: tr(
          "在日历上创建一个提醒：周二 15:30 提前准备会议材料。",
          "Add a calendar reminder: Tuesday 15:30, prepare the meeting material early.",
        ),
        createdAt: minutesAgo(20),
        state: "complete",
        citations: [],
        toolActivities: [],
      },
      {
        id: "demo-msg-8",
        role: "assistant",
        content: tr(
          "已添加日程「准备季度回顾材料」，周二 15:30–16:00。",
          "Added “Prepare quarterly review material”, Tuesday 15:30–16:00.",
        ),
        createdAt: minutesAgo(18),
        state: "complete",
        citations: [],
        toolActivities: [
          tool("demo-tool-7", "calendar.create", "calendar.create", "awaiting_confirmation"),
        ],
        confirmation: {
          id: "demo-confirm-3",
          title: tr("创建日历日程", "Create calendar event"),
          summary: tr("助手请求在日历中添加新日程", "The assistant wants to add a calendar event"),
          fields: [
            { label: tr("日程", "Event"), value: tr("准备季度回顾材料", "Prepare quarterly review material") },
            { label: tr("时间", "Time"), value: tr("周二 15:30–16:00", "Tuesday 15:30–16:00") },
          ],
          expiresAt: minutesAgo(-42),
          state: "pending",
        },
      },
      {
        id: "demo-msg-9",
        role: "user",
        content: tr("另外把之前那个「产品评审」日程删掉吧。", "Also delete that “Product review” calendar event."),
        createdAt: minutesAgo(15),
        state: "complete",
        citations: [],
        toolActivities: [],
      },
      {
        id: "demo-msg-10",
        role: "assistant",
        content: tr(
          "好的，已取消删除「产品评审」，该日程保持不变。",
          "Understood — the deletion of “Product review” was cancelled and the event stays as it is.",
        ),
        createdAt: minutesAgo(13),
        state: "complete",
        citations: [],
        toolActivities: [
          tool("demo-tool-8", "calendar.delete", "calendar.delete", "completed"),
        ],
        confirmation: {
          id: "demo-confirm-2",
          title: tr("删除日历日程", "Delete calendar event"),
          summary: tr("助手请求删除日程「产品评审」", "The assistant wants to delete the “Product review” event"),
          fields: [
            { label: tr("日程", "Event"), value: tr("产品评审", "Product review") },
            { label: tr("时间", "Time"), value: tr("周三 10:00–11:00", "Wednesday 10:00–11:00") },
          ],
          expiresAt: minutesAgo(13),
          state: "rejected",
        },
      },
      {
        id: "demo-msg-11",
        role: "user",
        content: tr("好的，那直接把这封确认邮件发出去。", "Good — go ahead and send the confirmation mail."),
        createdAt: minutesAgo(10),
        state: "complete",
        citations: [],
        toolActivities: [],
      },
      {
        id: "demo-msg-12",
        role: "assistant",
        content: tr(
          "发送遇到问题：SMTP 服务器暂时不可用，草稿仍安全保存在草稿箱，可以稍后重试。",
          "Sending failed: the SMTP server is temporarily unavailable. The draft is safe in your drafts folder and you can retry later.",
        ),
        createdAt: minutesAgo(8),
        state: "error",
        citations: [],
        toolActivities: [
          tool("demo-tool-9", "messages.send", "messages.send", "failed", {
            error: {
              code: "HOST_UNAVAILABLE",
              message: tr("SMTP 服务器暂时不可用（网络中断）", "SMTP server temporarily unavailable (network interruption)"),
              retryable: true,
            },
          }),
        ],
        error: {
          code: "HOST_UNAVAILABLE",
          message: tr("SMTP 服务器暂时不可用（网络中断）", "SMTP server temporarily unavailable (network interruption)"),
          suggestion: tr("检查网络连接后重试，或稍后再发送", "Check your connection and retry, or try again later"),
          retryable: true,
        },
      },
      {
        id: "demo-msg-13",
        role: "user",
        content: tr("重试发送。", "Retry sending."),
        createdAt: minutesAgo(6),
        state: "complete",
        citations: [],
        toolActivities: [],
      },
      {
        id: "demo-msg-14",
        role: "assistant",
        content: tr(
          "已发送：确认参加季度回顾会议（收件人 meeting@xingchen.example）。",
          "Sent: confirming attendance at the quarterly review (to meeting@xingchen.example).",
        ),
        createdAt: minutesAgo(5),
        state: "complete",
        citations: [],
        toolActivities: [
          tool("demo-tool-10", "messages.send", "messages.send", "completed"),
        ],
      },
      {
        id: "demo-msg-15",
        role: "user",
        content: tr("明天上午还有什么安排吗？", "Anything else booked for tomorrow morning?"),
        createdAt: minutesAgo(2),
        state: "complete",
        citations: [],
        toolActivities: [],
      },
      {
        id: "demo-msg-16",
        role: "assistant",
        content: "",
        createdAt: minutesAgo(1),
        state: "streaming",
        citations: [],
        toolActivities: [],
      },
    ],
  };
}
