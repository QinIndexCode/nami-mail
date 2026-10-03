import { describe, expect, it, vi } from "vitest";
import { simulateAutoReply } from "../src/agent/auto-reply-simulator.js";
import type { AgentService } from "../src/agent-service.js";

describe("auto-reply-simulator", () => {
  it("computes link sanitization token savings and filters junk messages offline", async () => {
    const fakeAgentService = {
      evaluateAutoReply: vi.fn(),
    } as unknown as AgentService;

    const input = {
      fromAddress: "marketing@spammydomain.com",
      subject: "Special Promo",
      textBody: "Click here to see: https://track.spammydomain.com/ad?click=1234567890&utm=email",
      mailbox: "Junk",
    };

    const result = await simulateAutoReply(fakeAgentService, input);

    expect(result.linkStats.replacedCount).toBe(1);
    expect(result.linkStats.estimatedTokensSaved).toBeGreaterThan(0);
    expect(result.screening.passed).toBe(false);
    expect(result.screening.reason).toBe("junk-folder");
    expect(result.finalAction).toBe("ignored_offline_rule");
    // Should NOT call evaluateAutoReply when offline rule fails without forceLlm
    expect(fakeAgentService.evaluateAutoReply).not.toHaveBeenCalled();
  });

  it("evaluates via LLM when screening and scope pass", async () => {
    const fakeAgentService = {
      evaluateAutoReply: vi.fn().mockResolvedValue({
        replyValue: "high",
        sensitive: false,
        replyText: "收到您的邮件，我们正在跟进处理。",
      }),
    } as unknown as AgentService;

    const input = {
      fromAddress: "colleague@company.com",
      subject: "合作意向确认",
      textBody: "你好，关于上周讨论的合作方案，请问本周是否有空进一步交流？详情见 https://company.com/docs/plan",
      mailbox: "INBOX",
    };

    const result = await simulateAutoReply(fakeAgentService, input);

    expect(result.screening.passed).toBe(true);
    expect(result.decision?.evaluated).toBe(true);
    expect(result.decision?.replyValue).toBe("high");
    expect(result.decision?.reply).toContain("收到您的邮件");
    expect(result.finalAction).toBe("would_reply");
  });

  it("flags sensitive content requiring manual confirmation", async () => {
    const fakeAgentService = {
      evaluateAutoReply: vi.fn().mockResolvedValue({
        replyValue: "high",
        sensitive: true,
        replyText: "已为您核对银行卡与转账信息。",
      }),
    } as unknown as AgentService;

    const input = {
      fromAddress: "finance@bank.com",
      subject: "账户安全转账验证",
      textBody: "您的账户产生了一笔大额转账，请核对密码与支付凭证。",
      mailbox: "INBOX",
    };

    const result = await simulateAutoReply(fakeAgentService, input);

    expect(result.decision?.sensitive).toBe(true);
    expect(result.finalAction).toBe("sensitive_requires_confirmation");
  });

  it("supports forceLlm when offline screening did not pass", async () => {
    const fakeAgentService = {
      evaluateAutoReply: vi.fn().mockResolvedValue({
        replyValue: "low",
        sensitive: false,
        reply: "",
      }),
    } as unknown as AgentService;

    const input = {
      fromAddress: "newsletter@updates.com",
      subject: "周报",
      textBody: "这是本周的周报内容。退订请访问 https://newsletter.com/optout",
      mailbox: "Junk",
      forceLlm: true,
    };

    const result = await simulateAutoReply(fakeAgentService, input);

    expect(result.screening.passed).toBe(false);
    expect(result.decision?.evaluated).toBe(true);
    expect(result.decision?.replyValue).toBe("low");
    expect(fakeAgentService.evaluateAutoReply).toHaveBeenCalled();
  });
});
