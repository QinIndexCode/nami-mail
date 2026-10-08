// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  getAccountDisplayName,
  hydrateAccountDisplayNames,
  setAccountDisplayName,
  useAccountDisplayNames,
} from "./accountDisplayNameStore";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("accountDisplayNameStore", () => {
  beforeEach(() => {
    hydrateAccountDisplayNames([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("round-trips a display name keyed by normalized email", () => {
    expect(getAccountDisplayName("Alice@Example.com")).toBeNull();
    setAccountDisplayName("Alice@Example.com", "Work Mailbox");
    expect(getAccountDisplayName("alice@example.com")).toBe("Work Mailbox");
    expect(getAccountDisplayName("  ALICE@EXAMPLE.COM ")).toBe("Work Mailbox");
  });

  it("keeps server hydration authoritative and honors cleared names", () => {
    setAccountDisplayName("alice@example.com", "Session name");
    hydrateAccountDisplayNames([{ email: "alice@example.com", displayName: "School" }]);
    expect(getAccountDisplayName("alice@example.com")).toBe("School");
    hydrateAccountDisplayNames([{ email: "alice@example.com", displayName: null }]);
    expect(getAccountDisplayName("alice@example.com")).toBeNull();
  });

  it("never consults localStorage (the stale-override path is removed)", () => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new Error("SecurityError: localStorage must not be read");
      },
      configurable: true,
    });
    setAccountDisplayName("noread@example.com", "In-memory");
    expect(getAccountDisplayName("noread@example.com")).toBe("In-memory");
  });

  it("trims whitespace and truncates names to 64 characters", () => {
    const longName = "  " + "A".repeat(100) + "  ";
    setAccountDisplayName("user@domain.com", longName);
    const stored = getAccountDisplayName("user@domain.com");
    expect(stored).toBe("A".repeat(64));
  });

  it("clears the display name when set to null or whitespace", () => {
    setAccountDisplayName("bob@example.com", "School");
    expect(getAccountDisplayName("bob@example.com")).toBe("School");

    setAccountDisplayName("bob@example.com", "   ");
    expect(getAccountDisplayName("bob@example.com")).toBeNull();

    setAccountDisplayName("bob@example.com", "Personal");
    expect(getAccountDisplayName("bob@example.com")).toBe("Personal");

    setAccountDisplayName("bob@example.com", null);
    expect(getAccountDisplayName("bob@example.com")).toBeNull();
  });

  it("triggers hook re-render when display names change", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    let renderCount = 0;
    function Consumer() {
      useAccountDisplayNames();
      renderCount += 1;
      return null;
    }

    act(() => {
      root.render(createElement(Consumer));
    });
    const initialRenderCount = renderCount;

    act(() => {
      setAccountDisplayName("carol@example.com", "Carol Work");
    });

    expect(renderCount).toBeGreaterThan(initialRenderCount);
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("keeps demo-mode names for the session without any storage", () => {
    // Demo accounts are never hydrated from the server; the name still edits
    // in memory (session scope) instead of falling back to localStorage.
    setAccountDisplayName("demo@example.test", "Demo Name");
    expect(getAccountDisplayName("demo@example.test")).toBe("Demo Name");
  });
});
