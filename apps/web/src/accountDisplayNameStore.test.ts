// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  getAccountDisplayName,
  setAccountDisplayName,
  useAccountDisplayNames,
} from "./accountDisplayNameStore";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function installLocalStorageStub(): Storage {
  const map = new Map<string, string>();
  const stub = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => {
      map.clear();
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  } as unknown as Storage;
  Object.defineProperty(window, "localStorage", {
    value: stub,
    configurable: true,
    writable: true,
  });
  return stub;
}

describe("accountDisplayNameStore", () => {
  beforeEach(() => {
    installLocalStorageStub();
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

  it("degrades gracefully to null when localStorage throws", () => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new Error("SecurityError: localStorage is disabled");
      },
      configurable: true,
    });

    expect(() => {
      setAccountDisplayName("denied@example.com", "Name");
    }).not.toThrow();

    expect(getAccountDisplayName("denied@example.com")).toBeNull();
  });
});
