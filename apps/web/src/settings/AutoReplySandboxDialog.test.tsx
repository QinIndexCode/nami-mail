// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import AutoReplySandboxDialog from "./AutoReplySandboxDialog";
import { api } from "../api";
import type { AutoReplySimulateResult } from "../agentTypes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../api", () => ({
  api: {
    autoReplySimulate: vi.fn(),
  },
}));

const mockTranslate = (key: string, params?: Record<string, unknown>) => {
  if (key === "settings.agent.sandbox.tokensSaved") {
    return `Saved ~${params?.count} Tokens`;
  }
  return key;
};

describe("AutoReplySandboxDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("renders with form fields, presets, and properly styled email input", () => {
    act(() => {
      root.render(
        <AutoReplySandboxDialog
          t={mockTranslate as any}
          onClose={vi.fn()}
        />,
      );
    });

    const emailInput = container.querySelector("#sandbox-from-email") as HTMLInputElement;
    expect(emailInput).not.toBeNull();
    expect(emailInput.type).toBe("email");
    expect(emailInput.placeholder).toBe("sender@example.com");

    const nameInput = container.querySelector("#sandbox-from-name") as HTMLInputElement;
    expect(nameInput).not.toBeNull();
    expect(nameInput.type).toBe("text");

    const subjectInput = container.querySelector("#sandbox-subject") as HTMLInputElement;
    expect(subjectInput).not.toBeNull();

    const bodyTextarea = container.querySelector("#sandbox-body") as HTMLTextAreaElement;
    expect(bodyTextarea).not.toBeNull();

    const presetChips = container.querySelectorAll(".auto-reply-sandbox-preset-chip");
    expect(presetChips.length).toBeGreaterThanOrEqual(4);
  });

  it("loads preset content when a preset chip is clicked", () => {
    act(() => {
      root.render(
        <AutoReplySandboxDialog
          t={mockTranslate as any}
          onClose={vi.fn()}
        />,
      );
    });

    const presetChips = container.querySelectorAll(".auto-reply-sandbox-preset-chip");
    const secondChip = presetChips[1] as HTMLButtonElement;
    act(() => {
      secondChip.click();
    });

    const emailInput = container.querySelector("#sandbox-from-email") as HTMLInputElement;
    expect(emailInput.value).toBe("newsletter@cloud-service.com");
  });

  it("submits simulation with contact toggle and forceLlm parameters", async () => {
    const mockResult: AutoReplySimulateResult = {
      linkStats: {
        originalLength: 100,
        sanitizedLength: 40,
        replacedCount: 2,
        estimatedTokensSaved: 15,
        sanitizedSnippet: "snippet",
      },
      screening: {
        passed: true,
      },
      scope: {
        passed: true,
      },
      sensitiveKeywords: [],
      decision: {
        evaluated: true,
        replyValue: "high",
        sensitive: false,
        reply: "Simulated draft reply",
      },
      finalAction: "would_reply",
    };

    (api.autoReplySimulate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      result: mockResult,
    });

    act(() => {
      root.render(
        <AutoReplySandboxDialog
          t={mockTranslate as any}
          onClose={vi.fn()}
        />,
      );
    });

    const contactCheckbox = container.querySelector("#sandbox-simulate-contact") as HTMLInputElement;
    const forceLlmCheckbox = container.querySelector("#sandbox-force-llm") as HTMLInputElement;

    act(() => {
      contactCheckbox.click();
      forceLlmCheckbox.click();
    });

    const runBtn = container.querySelector(".settings-model-actions .primary-button") as HTMLButtonElement;
    await act(async () => {
      runBtn.click();
    });

    expect(api.autoReplySimulate).toHaveBeenCalledWith(
      expect.objectContaining({
        simulateAsContact: true,
        forceLlm: true,
      }),
    );

    expect(container.textContent).toContain("Simulated draft reply");
  });

  it("renders LLM error card when decision evaluation fails", async () => {
    const mockResult: AutoReplySimulateResult = {
      linkStats: {
        originalLength: 50,
        sanitizedLength: 50,
        replacedCount: 0,
        estimatedTokensSaved: 0,
        sanitizedSnippet: "test",
      },
      screening: {
        passed: true,
      },
      scope: {
        passed: true,
      },
      sensitiveKeywords: [],
      decision: {
        evaluated: false,
        error: "Provider timed out after 45s",
      },
      finalAction: "would_reply",
    };

    (api.autoReplySimulate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      result: mockResult,
    });

    act(() => {
      root.render(
        <AutoReplySandboxDialog
          t={mockTranslate as any}
          onClose={vi.fn()}
        />,
      );
    });

    const runBtn = container.querySelector(".settings-model-actions .primary-button") as HTMLButtonElement;
    await act(async () => {
      runBtn.click();
    });

    expect(container.textContent).toContain("Provider timed out after 45s");
    expect(container.textContent).toContain("settings.agent.sandbox.llmEvaluationFailed");
  });

  it("displays the loading status card while simulation is in flight", async () => {
    let resolveSimulation: (value: any) => void;
    const pendingPromise = new Promise((resolve) => {
      resolveSimulation = resolve;
    });

    (api.autoReplySimulate as ReturnType<typeof vi.fn>).mockReturnValueOnce(pendingPromise);

    act(() => {
      root.render(
        <AutoReplySandboxDialog
          t={mockTranslate as any}
          onClose={vi.fn()}
        />,
      );
    });

    const runBtn = container.querySelector(".settings-model-actions .primary-button") as HTMLButtonElement;
    await act(async () => {
      runBtn.click();
    });

    const loadingCard = container.querySelector(".sandbox-loading-card");
    expect(loadingCard).not.toBeNull();
    expect(loadingCard?.textContent).toContain("settings.agent.sandbox.runningHint");

    await act(async () => {
      resolveSimulation!({
        ok: true,
        result: {
          linkStats: { originalLength: 10, sanitizedLength: 10, replacedCount: 0, estimatedTokensSaved: 0, sanitizedSnippet: "" },
          screening: { passed: true },
          scope: { passed: true },
          sensitiveKeywords: [],
          finalAction: "would_reply",
        },
      });
    });

    expect(container.querySelector(".sandbox-loading-card")).toBeNull();
    expect(container.querySelector(".sandbox-result-card")).not.toBeNull();
  });
});
