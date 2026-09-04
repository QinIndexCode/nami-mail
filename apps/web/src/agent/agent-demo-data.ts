/**
 * Builds a fully populated sample conversation for demo mode so the transcript
 * styling (tool cards, citations, confirmations, quotes, attachments, errors,
 * streaming state) can be reviewed without a backend.
 *
 * Extracted from AgentWorkspace.tsx — zero functional changes.
 */
import type {
  AgentCitation,
  AgentConversation,
  AgentToolActivity,
} from "../agentTypes";

export function createDemoConversation(): AgentConversation {
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
    title: "季度回顾会议准备",
    preview: "明天上午还有什么安排吗？",
    updatedAt: minutesAgo(1),
    scope: { mode: "all_accounts", accountIds: ["account-1"], messageIds: [] },
    providerId: "demo-ollama",
    messages: [
      {
        id: "demo-msg-0",
        role: "system",
        content: "已恢复会话记忆：与星辰科技的合作往来、本周 3 封待办邮件、2 个待确认日程。",
        createdAt: minutesAgo(59),
        state: "complete",
        citations: [],
        toolActivities: [],
      },
      {
        id: "demo-msg-1",
        role: "user",
        content: "早上好，帮我看看今天有哪些需要关注的邮件？",
        createdAt: minutesAgo(58),
        state: "complete",
        citations: [],
        toolActivities: [],
      },
      {
        id: "demo-msg-2",
        role: "assistant",
        content: "今天有 3 封值得关注的邮件：\n\n1. **星辰科技**确认了季度回顾会议，并把时间改到了周二下午 4 点；\n2. **供应商发票**已上传附件，等待你确认付款；\n3. **安全通知**提醒本周将轮换部分账户密码。\n\n需要我展开哪一封？",
        createdAt: minutesAgo(56),
        state: "complete",
        citations: [
          citation("demo-cite-1", "季度回顾会议时间调整", "星辰科技 <meeting@xingchen.example>", minutesAgo(120), "季度回顾会议调整至周二 16:00，届时请提前准备供应商报价对比表。"),
          citation("demo-cite-2", "6 月供应商发票", "财务部 <finance@nami.example>", minutesAgo(300), "附上 6 月供应商发票，请在月底前完成确认。"),
        ],
        toolActivities: [
          tool("demo-tool-1", "accounts.list", "accounts.list", "completed"),
          tool("demo-tool-2", "messages.list", "messages.list", "completed"),
          tool("demo-tool-3", "messages.get", "messages.get", "completed", { summary: "3 封邮件详情" }),
        ],
      },
      {
        id: "demo-msg-3",
        role: "user",
        content: "那封星辰科技的邮件说要提前讨论供应商报价，附件里是我整理的数据，帮我对一下。",
        createdAt: minutesAgo(40),
        state: "complete",
        citations: [],
        toolActivities: [],
        quote: "季度回顾会议调整至周二 16:00，届时请提前准备供应商报价对比。",
        attachments: [
          { name: "季度数据.xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", path: "C:\\Users\\demo\\Downloads\\季度数据.xlsx", token: "out_demo_quarterly" },
        ],
      },
      {
        id: "demo-msg-4",
        role: "assistant",
        content: "已结合你上传的数据与历史邮件核对：\n\n- 星辰科技在 6 月邮件中提及的供应商报价为 **12.8 万**，与你的数据表一致；\n- 本次邮件把讨论时间从 14:00 改到 **16:00**，原因是采购团队上午有评审会；\n- 建议准备：报价对比表 + 上半年采购量统计表。",
        createdAt: minutesAgo(38),
        state: "complete",
        citations: [
          citation("demo-cite-3", "6 月供应商报价沟通", "星辰科技 <purchase@xingchen.example>", minutesAgo(3000), "供应商报价 12.8 万，待月度会议确认。", "demo-mail-2"),
        ],
        toolActivities: [
          tool("demo-tool-4", "rag.search", "rag.search", "completed", { summary: "匹配到 3 条历史记录" }),
          tool("demo-tool-5", "messages.get", "messages.get", "completed"),
        ],
      },
      {
        id: "demo-msg-5",
        role: "user",
        content: "帮我起草一封回复，确认我们周二下午 4 点会参加，并询问需要准备什么材料。",
        createdAt: minutesAgo(30),
        state: "complete",
        citations: [],
        toolActivities: [],
      },
      {
        id: "demo-msg-6",
        role: "assistant",
        content: "草稿已创建，等你确认后就可以发送。需要修改措辞或收件人时告诉我即可。",
        createdAt: minutesAgo(28),
        state: "complete",
        citations: [],
        toolActivities: [
          tool("demo-tool-6", "mail.draft.create", "mail.draft.create", "completed"),
        ],
        confirmation: {
          id: "demo-confirm-1",
          title: "创建邮件草稿",
          summary: "助手请求创建一封新草稿",
          fields: [
            { label: "账户", value: "hello@nami.example" },
            { label: "收件人", value: "meeting@xingchen.example" },
            { label: "主题", value: "确认参加季度回顾会议" },
            { label: "正文", value: "确认参加周二 16:00 的季度回顾会议，请告知需要提前准备的材料。" },
          ],
          expiresAt: minutesAgo(28),
          state: "approved",
        },
      },
      {
        id: "demo-msg-7",
        role: "user",
        content: "在日历上创建一个提醒：周二 15:30 提前准备会议材料。",
        createdAt: minutesAgo(20),
        state: "complete",
        citations: [],
        toolActivities: [],
      },
      {
        id: "demo-msg-8",
        role: "assistant",
        content: "已添加日程「准备季度回顾材料」，周二 15:30–16:00。",
        createdAt: minutesAgo(18),
        state: "complete",
        citations: [],
        toolActivities: [
          tool("demo-tool-7", "calendar.create", "calendar.create", "awaiting_confirmation"),
        ],
        confirmation: {
          id: "demo-confirm-3",
          title: "创建日历日程",
          summary: "助手请求在日历中添加新日程",
          fields: [
            { label: "日程", value: "准备季度回顾材料" },
            { label: "时间", value: "周二 15:30–16:00" },
          ],
          expiresAt: minutesAgo(-42),
          state: "pending",
        },
      },
      {
        id: "demo-msg-9",
        role: "user",
        content: "另外把之前那个「产品评审」日程删掉吧。",
        createdAt: minutesAgo(15),
        state: "complete",
        citations: [],
        toolActivities: [],
      },
      {
        id: "demo-msg-10",
        role: "assistant",
        content: "好的，已取消删除「产品评审」，该日程保持不变。",
        createdAt: minutesAgo(13),
        state: "complete",
        citations: [],
        toolActivities: [
          tool("demo-tool-8", "calendar.delete", "calendar.delete", "completed"),
        ],
        confirmation: {
          id: "demo-confirm-2",
          title: "删除日历日程",
          summary: "助手请求删除日程「产品评审」",
          fields: [
            { label: "日程", value: "产品评审" },
            { label: "时间", value: "周三 10:00–11:00" },
          ],
          expiresAt: minutesAgo(13),
          state: "rejected",
        },
      },
      {
        id: "demo-msg-11",
        role: "user",
        content: "好的，那直接把这封确认邮件发出去。",
        createdAt: minutesAgo(10),
        state: "complete",
        citations: [],
        toolActivities: [],
      },
      {
        id: "demo-msg-12",
        role: "assistant",
        content: "发送遇到问题：SMTP 服务器暂时不可用，草稿仍安全保存在草稿箱，可以稍后重试。",
        createdAt: minutesAgo(8),
        state: "error",
        citations: [],
        toolActivities: [
          tool("demo-tool-9", "messages.send", "messages.send", "failed", {
            error: { code: "HOST_UNAVAILABLE", message: "SMTP 服务器暂时不可用（网络中断）", retryable: true },
          }),
        ],
        error: { code: "HOST_UNAVAILABLE", message: "SMTP 服务器暂时不可用（网络中断）", suggestion: "检查网络连接后重试，或稍后再发送", retryable: true },
      },
      {
        id: "demo-msg-13",
        role: "user",
        content: "重试发送。",
        createdAt: minutesAgo(6),
        state: "complete",
        citations: [],
        toolActivities: [],
      },
      {
        id: "demo-msg-14",
        role: "assistant",
        content: "已发送：确认参加季度回顾会议（收件人 meeting@xingchen.example）。",
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
        content: "明天上午还有什么安排吗？",
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
