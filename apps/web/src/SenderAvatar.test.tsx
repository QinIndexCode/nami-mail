// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { SenderAvatar, CustomAvatar } from "./SenderAvatar";
import { setAvatar } from "./avatarStore";

/** jsdom 29 exposes a localStorage shell without working methods; stub it. */
function installLocalStorageStub() {
  const store = new Map<string, string>();
  const stub: Storage = {
    get length() { return store.size; },
    clear() { store.clear(); },
    getItem(key: string) { return store.get(key) ?? null; },
    key(index: number) { return [...store.keys()][index] ?? null; },
    removeItem(key: string) { store.delete(key); },
    setItem(key: string, value: string) { store.set(key, String(value)); },
  };
  Object.defineProperty(window, "localStorage", { value: stub, configurable: true, writable: true });
}

let container: HTMLDivElement;
let root: Root;

function renderTree(element: React.ReactElement): string {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => { root.render(element); });
  return container.innerHTML;
}

beforeEach(() => {
  installLocalStorageStub();
});

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  document.querySelectorAll("span").forEach((span) => span.remove());
  vi.restoreAllMocks();
});

describe("SenderAvatar", () => {
  it("renders the locally configured avatar when present", () => {
    setAvatar("Alice@Example.com", "data:image/jpeg;base64,aaa");
    const html = renderTree(<SenderAvatar name="Alice" address="alice@example.com" tone={0} gravatarEnabled={false} />);
    expect(html).toContain("data:image/jpeg;base64,aaa");
    expect(html).not.toContain("AL");
  });

  it("prefers the local avatar over Gravatar when both are enabled", () => {
    setAvatar("bob@example.com", "data:image/jpeg;base64,bbb");
    const html = renderTree(<SenderAvatar name="Bob" address="bob@example.com" tone={1} gravatarEnabled={true} />);
    expect(html).toContain("data:image/jpeg;base64,bbb");
    expect(html).not.toContain("gravatar.com");
  });

  it("falls back to initials without a local avatar", () => {
    const html = renderTree(<SenderAvatar name="Carol" address="carol@example.com" tone={2} gravatarEnabled={false} />);
    expect(html).not.toContain("data:image");
    expect(html).toContain(">CA<");
  });

  it("CustomAvatar shows initials for another account without a picture", () => {
    const html = renderTree(<CustomAvatar name="dave@example.com" address="dave@example.com" tone={3} className="account-avatar" />);
    expect(html).toContain("account-avatar");
    expect(html).toContain(">DA<");
  });
});