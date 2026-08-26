// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { AvatarEditor } from "./AvatarEditor";
import { I18nProvider } from "./i18n";

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

function renderTree(element: React.ReactElement): HTMLElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => { root.render(<I18nProvider>{element}</I18nProvider>); });
  return container;
}

beforeEach(() => {
  installLocalStorageStub();
});

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  vi.restoreAllMocks();
});

describe("AvatarEditor", () => {
  it("shows the initials fallback and no clear badge without a picture", () => {
    const html = renderTree(<AvatarEditor name="" address="dave@example.com" current={null} onChange={() => {}} />);
    expect(html.querySelector(".avatar-editor-letter")?.textContent).toBe("D");
    expect(html.querySelector(".avatar-editor-image")).toBeNull();
    expect(html.querySelector(".avatar-editor-clear")).toBeNull();
    expect(html.querySelector(".avatar-editor-choose")).not.toBeNull();
  });

  it("shows the picture and a clear badge when one is set", () => {
    const html = renderTree(<AvatarEditor name="Dave" address="dave@example.com" current="data:image/jpeg;base64,xyz" onChange={() => {}} />);
    const image = html.querySelector<HTMLImageElement>(".avatar-editor-image");
    expect(image?.src).toBe("data:image/jpeg;base64,xyz");
    expect(html.querySelector(".avatar-editor-letter")).toBeNull();
    expect(html.querySelector(".avatar-editor-clear")).not.toBeNull();
  });

  it("calls onChange with null when the clear badge is clicked", () => {
    const onChange = vi.fn();
    const html = renderTree(<AvatarEditor name="Dave" address="dave@example.com" current="data:image/jpeg;base64,xyz" onChange={onChange} />);
    act(() => { html.querySelector<HTMLButtonElement>(".avatar-editor-clear")!.click(); });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("disables both edit affordances while busy", () => {
    const html = renderTree(<AvatarEditor name="Dave" address="dave@example.com" current="data:image/jpeg;base64,xyz" disabled onChange={() => {}} />);
    expect(html.querySelector<HTMLButtonElement>(".avatar-editor-choose")?.disabled).toBe(true);
    expect(html.querySelector<HTMLButtonElement>(".avatar-editor-clear")?.disabled).toBe(true);
  });
});