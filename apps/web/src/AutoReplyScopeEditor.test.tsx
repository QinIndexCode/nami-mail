// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import AutoReplyScopeEditor from "./AutoReplyScopeEditor";
import { I18nProvider } from "./i18n";
import type { AutoReplyScope } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const initialScope: AutoReplyScope = {
  contactsOnly: false,
  startDate: null,
  endDate: null,
  threadOnce: true,
  rules: [
    {
      id: "rule-1",
      field: "from",
      op: "contains",
      value: "boss@example.com",
      action: "reply",
      enabled: true,
    },
    {
      id: "rule-2",
      field: "domain",
      op: "not-contains",
      value: "spam.test",
      action: "ignore",
      enabled: false,
    },
  ],
};

describe("AutoReplyScopeEditor", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("renders existing rules with badges and natural language summary", async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <AutoReplyScopeEditor scope={initialScope} onChange={() => undefined} />
        </I18nProvider>,
      );
    });

    const ruleCards = container.querySelectorAll(".auto-reply-rule-card");
    expect(ruleCards.length).toBe(2);

    expect(ruleCards[0].textContent).toContain("回复");
    expect(ruleCards[0].textContent).toContain("发件人地址");
    expect(ruleCards[0].textContent).toContain("包含");
    expect(ruleCards[0].textContent).toContain("boss@example.com");

    expect(ruleCards[1].textContent).toContain("忽略");
    expect(ruleCards[1].textContent).toContain("发件人域名");
    expect(ruleCards[1].textContent).toContain("不包含");
    expect(ruleCards[1].textContent).toContain("spam.test");
  });

  it("toggles a rule's enabled state directly", async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(
        <I18nProvider>
          <AutoReplyScopeEditor scope={initialScope} onChange={onChange} />
        </I18nProvider>,
      );
    });

    const firstSwitch = container.querySelector(".auto-reply-rule-card .setting-switch") as HTMLButtonElement;
    expect(firstSwitch).not.toBeNull();

    await act(async () => {
      firstSwitch.click();
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    const updatedScope = onChange.mock.calls[0][0] as AutoReplyScope;
    expect(updatedScope.rules[0].enabled).toBe(false);
  });

  it("deletes a rule directly", async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(
        <I18nProvider>
          <AutoReplyScopeEditor scope={initialScope} onChange={onChange} />
        </I18nProvider>,
      );
    });

    const deleteBtn = container.querySelector(".auto-reply-rule-actions .danger-icon-button") as HTMLButtonElement;
    expect(deleteBtn).not.toBeNull();

    await act(async () => {
      deleteBtn.click();
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    const updatedScope = onChange.mock.calls[0][0] as AutoReplyScope;
    expect(updatedScope.rules.length).toBe(1);
    expect(updatedScope.rules[0].id).toBe("rule-2");
  });

  it("opens modal on Add Rule, rejects empty value, and saves trimmed valid value without premature saves", async () => {
    const onChange = vi.fn();
    const portalHost = document.createElement("div");
    document.body.appendChild(portalHost);
    const hostRef = { current: portalHost };

    await act(async () => {
      root.render(
        <I18nProvider>
          <AutoReplyScopeEditor scope={initialScope} onChange={onChange} overlayHostRef={hostRef} />
        </I18nProvider>,
      );
    });

    const addBtn = container.querySelector(".auto-reply-rule-add") as HTMLButtonElement;
    expect(addBtn).not.toBeNull();

    await act(async () => {
      addBtn.click();
    });

    // Opening modal should NOT have called onChange with an invalid empty draft!
    expect(onChange).not.toHaveBeenCalled();

    // Modal dialog is portalled into portalHost
    const modal = portalHost.querySelector(".auto-reply-rule-modal");
    expect(modal).not.toBeNull();
    expect(portalHost.querySelector("#auto-reply-rule-editor-title")?.textContent).toBe("新建自动回复规则");

    // Click Save without entering value -> should show validation error and NOT call onChange
    const saveBtn = portalHost.querySelector(".settings-model-actions .primary-button") as HTMLButtonElement;
    await act(async () => {
      saveBtn.click();
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(portalHost.textContent).toContain("请输入匹配内容");

    // Type a valid match value
    const input = portalHost.querySelector("#auto-reply-rule-value") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(input, "  urgent  ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // Now save
    const currentSaveBtn = portalHost.querySelector(".settings-model-actions .primary-button") as HTMLButtonElement;
    await act(async () => {
      currentSaveBtn.click();
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    const updatedScope = onChange.mock.calls[0][0] as AutoReplyScope;
    expect(updatedScope.rules.length).toBe(3);
    const newRule = updatedScope.rules[2];
    expect(newRule.value).toBe("urgent"); // trimmed!
    expect(newRule.field).toBe("from");
    expect(newRule.op).toBe("contains");

    portalHost.remove();
  });

  it("opens modal on Edit Rule and saves updated rule values", async () => {
    const onChange = vi.fn();
    const portalHost = document.createElement("div");
    document.body.appendChild(portalHost);
    const hostRef = { current: portalHost };

    await act(async () => {
      root.render(
        <I18nProvider>
          <AutoReplyScopeEditor scope={initialScope} onChange={onChange} overlayHostRef={hostRef} />
        </I18nProvider>,
      );
    });

    const editBtn = container.querySelector(".auto-reply-rule-actions button") as HTMLButtonElement;
    expect(editBtn).not.toBeNull();

    await act(async () => {
      editBtn.click();
    });

    expect(portalHost.querySelector("#auto-reply-rule-editor-title")?.textContent).toBe("编辑自动回复规则");

    const input = portalHost.querySelector("#auto-reply-rule-value") as HTMLInputElement;
    expect(input.value).toBe("boss@example.com");

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(input, "newboss@example.com");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const currentSaveBtn = portalHost.querySelector(".settings-model-actions .primary-button") as HTMLButtonElement;
    await act(async () => {
      currentSaveBtn.click();
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    const updatedScope = onChange.mock.calls[0][0] as AutoReplyScope;
    expect(updatedScope.rules.length).toBe(2);
    expect(updatedScope.rules[0].value).toBe("newboss@example.com");
    expect(updatedScope.rules[0].id).toBe("rule-1");

    portalHost.remove();
  });
});
