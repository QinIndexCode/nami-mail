// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { ErrorBoundary } from "./ErrorBoundary";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: string, values?: Record<string, unknown>) => {
  const raw =
    {
      "app.crash.title": "Something went wrong",
      "app.crash.message": "One area failed to render; reloading restores it.",
      "app.crash.messageArea": "{area} failed to render; reloading restores it.",
      "app.crash.reload": "Reload",
    }[key] ?? key;
  return values ? raw.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? "")) : raw;
};

function Bomb({ explode }: { explode: boolean }) {
  if (explode) throw new Error("boom");
  return <span>alive</span>;
}

describe("ErrorBoundary", () => {
  let host: HTMLElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it("renders children when nothing throws", () => {
    act(() => {
      root.render(
        <ErrorBoundary t={t}>
          <Bomb explode={false} />
        </ErrorBoundary>,
      );
    });
    expect(host.textContent).toContain("alive");
    expect(host.querySelector(".error-boundary-fallback")).toBeNull();
  });

  it("swaps in the fallback when a child throws during render", () => {
    act(() => {
      root.render(
        <ErrorBoundary t={t}>
          <Bomb explode={true} />
        </ErrorBoundary>,
      );
    });
    const fallback = host.querySelector(".error-boundary-fallback");
    expect(fallback).not.toBeNull();
    expect(fallback?.getAttribute("role")).toBe("alert");
    expect(fallback?.textContent).toContain("Something went wrong");
    expect(fallback?.textContent).toContain("Reload");
    // The error must not propagate to unmount the app root.
    expect(host.querySelector("span")).toBeNull();
  });

  it("includes the area name in the message when provided", () => {
    act(() => {
      root.render(
        <ErrorBoundary t={t} area="The message reader">
          <Bomb explode={true} />
        </ErrorBoundary>,
      );
    });
    expect(host.textContent).toContain("The message reader failed to render");
  });

  it("reloads the window from the fallback button", () => {
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      value: { reload },
      writable: true,
    });
    act(() => {
      root.render(
        <ErrorBoundary t={t}>
          <Bomb explode={true} />
        </ErrorBoundary>,
      );
    });
    const button = host.querySelector("button");
    expect(button).not.toBeNull();
    act(() => button?.click());
    expect(reload).toHaveBeenCalledOnce();
  });

  it("recovers when the failing subtree is swapped for a healthy one under a new key", () => {
    act(() => {
      root.render(
        <ErrorBoundary key="broken" t={t}>
          <Bomb explode={true} />
        </ErrorBoundary>,
      );
    });
    expect(host.querySelector(".error-boundary-fallback")).not.toBeNull();
    act(() => {
      root.render(
        <ErrorBoundary key="healthy" t={t}>
          <Bomb explode={false} />
        </ErrorBoundary>,
      );
    });
    expect(host.textContent).toContain("alive");
  });
});
