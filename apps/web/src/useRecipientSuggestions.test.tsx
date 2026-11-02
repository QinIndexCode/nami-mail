// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { applyRecipientToField, getTrailingRecipientQuery, useRecipientSuggestions } from "./useRecipientSuggestions";
import { api } from "./api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("./api", () => ({
  api: {
    contacts: vi.fn(),
  },
}));

describe("useRecipientSuggestions helper functions", () => {
  it("extracts trailing recipient query correctly", () => {
    expect(getTrailingRecipientQuery("")).toBe("");
    expect(getTrailingRecipientQuery("alice@example.com")).toBe("alice@example.com");
    expect(getTrailingRecipientQuery("alice@example.com, bob")).toBe("bob");
    expect(getTrailingRecipientQuery("alice@example.com; charlie")).toBe("charlie");
    expect(getTrailingRecipientQuery("alice@example.com  dave")).toBe("dave");
    expect(getTrailingRecipientQuery("alice@example.com, ")).toBe("");
  });

  it("applies recipient to field with appropriate separators", () => {
    expect(applyRecipientToField("", "alice@example.com")).toBe("alice@example.com");
    expect(applyRecipientToField("ali", "alice@example.com")).toBe("alice@example.com");
    expect(applyRecipientToField("bob@example.com, ali", "alice@example.com")).toBe("bob@example.com, alice@example.com");
    expect(applyRecipientToField("bob@example.com, ", "alice@example.com")).toBe("bob@example.com, alice@example.com");
    expect(applyRecipientToField("bob@example.com ali", "alice@example.com")).toBe("bob@example.com alice@example.com");
    expect(applyRecipientToField("bob@example.com;ali", "alice@example.com")).toBe("bob@example.com;alice@example.com");
  });
});

describe("useRecipientSuggestions hook harness", () => {
  let container: HTMLDivElement;
  let root: Root;

  const mockContacts = [
    { id: "c1", name: "Alice", email: "alice@example.com", autoCollected: false, createdAt: "", updatedAt: "", notes: "" },
    { id: "c2", name: "Bob", email: "bob@example.com", autoCollected: false, createdAt: "", updatedAt: "", notes: "" },
  ];

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.mocked(api.contacts).mockReset();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("searches contacts with debounce on typing", async () => {
    vi.useFakeTimers();
    vi.mocked(api.contacts).mockResolvedValue({ ok: true, items: mockContacts });
    const onApply = vi.fn();
    let hookState!: ReturnType<typeof useRecipientSuggestions>;

    function TestComponent() {
      hookState = useRecipientSuggestions({
        controlsId: "compose-contact-suggestions",
        onApplyRecipient: onApply,
      });
      return null;
    }

    act(() => {
      root.render(<TestComponent />);
    });

    act(() => {
      hookState.search("ali");
    });

    expect(api.contacts).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(200);
    });

    expect(api.contacts).toHaveBeenCalledWith("ali", 8);
    expect(hookState.open).toBe(true);
    expect(hookState.suggestions).toEqual(mockContacts);
    expect(hookState.activeDescendantId).toBe("compose-contact-suggestion-0");

    vi.useRealTimers();
  });

  it("toggles contact suggestions immediately on click", async () => {
    vi.mocked(api.contacts).mockResolvedValue({ ok: true, items: mockContacts });
    const onApply = vi.fn();
    let hookState!: ReturnType<typeof useRecipientSuggestions>;

    function TestComponent() {
      hookState = useRecipientSuggestions({
        controlsId: "compose-contact-suggestions",
        onApplyRecipient: onApply,
      });
      return null;
    }

    act(() => {
      root.render(<TestComponent />);
    });

    await act(async () => {
      hookState.toggle("");
    });

    expect(api.contacts).toHaveBeenCalledWith("", 8);
    expect(hookState.open).toBe(true);
    expect(hookState.suggestions).toEqual(mockContacts);
  });

  it("navigates suggestions with arrow keys and applies with enter", async () => {
    vi.mocked(api.contacts).mockResolvedValue({ ok: true, items: mockContacts });
    const onApply = vi.fn();
    let hookState!: ReturnType<typeof useRecipientSuggestions>;

    function TestComponent() {
      hookState = useRecipientSuggestions({
        controlsId: "compose-contact-suggestions",
        onApplyRecipient: onApply,
      });
      return null;
    }

    act(() => {
      root.render(<TestComponent />);
    });

    await act(async () => {
      hookState.toggle("ali");
    });

    expect(hookState.suggestedIndex).toBe(0);

    // Arrow down moves index to 1
    act(() => {
      const event = { key: "ArrowDown", preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as React.KeyboardEvent<HTMLInputElement>;
      hookState.onKeyDown(event, "ali");
      expect(event.preventDefault).toHaveBeenCalled();
    });

    expect(hookState.suggestedIndex).toBe(1);

    // Enter applies second contact
    act(() => {
      const event = { key: "Enter", preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as React.KeyboardEvent<HTMLInputElement>;
      hookState.onKeyDown(event, "ali");
      expect(event.preventDefault).toHaveBeenCalled();
    });

    expect(onApply).toHaveBeenCalledWith("bob@example.com");
    expect(hookState.open).toBe(false);
  });
});
