// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { SenderAvatar, CustomAvatar } from "./SenderAvatar";
import { setAvatar } from "./avatarStore";
import { resetBimiLogosForTests } from "./bimiStore";

const getBimiAvatarMock = vi.hoisted(() => vi.fn<() => Promise<string | null>>());

vi.mock("./api", () => ({
  getBimiAvatar: getBimiAvatarMock,
}));

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

/** Renders and then flushes the BIMI resolution microtasks inside act(). */
async function renderTreeAsync(element: React.ReactElement): Promise<string> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(element); });
  await act(async () => { await Promise.resolve(); });
  return container.innerHTML;
}

beforeEach(() => {
  installLocalStorageStub();
  resetBimiLogosForTests();
  getBimiAvatarMock.mockReset();
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
    const html = renderTree(<SenderAvatar name="Alice" address="alice@example.com" tone={0} gravatarEnabled={false} bimiEnabled={false} />);
    expect(html).toContain("data:image/jpeg;base64,aaa");
    expect(html).not.toContain("AL");
  });

  it("prefers the local avatar over Gravatar when both are enabled", () => {
    setAvatar("bob@example.com", "data:image/jpeg;base64,bbb");
    const html = renderTree(<SenderAvatar name="Bob" address="bob@example.com" tone={1} gravatarEnabled={true} bimiEnabled={false} />);
    expect(html).toContain("data:image/jpeg;base64,bbb");
    expect(html).not.toContain("gravatar.com");
  });

  it("falls back to initials without a local avatar", () => {
    const html = renderTree(<SenderAvatar name="Carol" address="carol@example.com" tone={2} gravatarEnabled={false} bimiEnabled={false} />);
    expect(html).not.toContain("data:image");
    expect(html).toContain(">CA<");
  });

  it("keys the Gravatar lookup with the RFC 1321 md5 of the lowercased email", () => {
    // Both digests were cross-checked against node:crypto's md5 of the
    // lowercased address; they pin the little-endian digest serialization.
    const apple = renderTree(<SenderAvatar name="Apple News" address="News@InsideApple.Apple.com" tone={0} gravatarEnabled={true} bimiEnabled={false} />);
    expect(apple).toContain("gravatar.com/avatar/e1a703880d8baa3819ff17f779914ad6");
    const nyt = renderTree(<SenderAvatar name="NYT" address="nytdirect@nytimes.com" tone={1} gravatarEnabled={true} bimiEnabled={false} />);
    expect(nyt).toContain("gravatar.com/avatar/cf775fbf8e1b63a401d480d2cbd482be");
  });

  it("shows the BIMI logo before Gravatar and requests only the domain", async () => {
    getBimiAvatarMock.mockResolvedValue("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=");
    const html = await renderTreeAsync(
      <SenderAvatar name="Brand" address="news@brand.example" tone={0} gravatarEnabled={true} bimiEnabled={true} />,
    );
    expect(getBimiAvatarMock).toHaveBeenCalledWith("brand.example");
    expect(html).toContain("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=");
    expect(html).not.toContain("gravatar.com");
  });

  it("never calls the BIMI resolver when the feature is off", () => {
    const html = renderTree(<SenderAvatar name="Carol" address="carol@example.com" tone={2} gravatarEnabled={false} bimiEnabled={false} />);
    expect(getBimiAvatarMock).not.toHaveBeenCalled();
    expect(html).toContain(">CA<");
  });

  it("caches a negative BIMI resolution for the session and falls through", async () => {
    getBimiAvatarMock.mockResolvedValue(null);
    const first = await renderTreeAsync(
      <SenderAvatar name="Carol" address="carol@example.com" tone={2} gravatarEnabled={false} bimiEnabled={true} />,
    );
    expect(first).toContain(">CA<");
    const second = await renderTreeAsync(
      <SenderAvatar name="Carol" address="carol@example.com" tone={2} gravatarEnabled={false} bimiEnabled={true} />,
    );
    expect(second).toContain(">CA<");
    expect(getBimiAvatarMock).toHaveBeenCalledTimes(1);
  });

  it("CustomAvatar shows initials for another account without a picture", () => {
    const html = renderTree(<CustomAvatar name="dave@example.com" address="dave@example.com" tone={3} className="account-avatar" />);
    expect(html).toContain("account-avatar");
    expect(html).toContain(">DA<");
  });
});
