// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { rewriteRemoteImagesToProxy, sanitizeMailHtml } from "./app/app-utils";
import { hideFailedMailImages } from "./mailImageFallback";

function mountBody(html: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.append(container);
  return container;
}

describe("hideFailedMailImages", () => {
  it("keeps the whole mail readable when a proxied image fails", () => {
    // The proxy fails closed by design (blocked host, dead link, over the size
    // or wall-clock ceiling), so a 404 here is routine, not exceptional. The
    // reader must lose the picture, never the mail.
    const html = rewriteRemoteImagesToProxy(sanitizeMailHtml(
      '<p>Invoice attached below.</p><p>Regards,<br>Support</p>'
      + '<img src="https://blocked.example/logo.png" alt="Acme Corp logo">',
      false,
    ));
    const container = mountBody(html);
    const cleanup = hideFailedMailImages(container);

    const image = container.querySelector("img")!;
    image.dispatchEvent(new Event("error"));

    expect(container.textContent).toContain("Invoice attached below.");
    expect(container.textContent).toContain("Regards,");
    expect(container.textContent).toContain("Support");
    // The failed image gives way to its alt text rather than a broken glyph.
    expect(image.style.display).toBe("none");
    const placeholder = container.querySelector(".mail-image-fallback");
    expect(placeholder?.textContent).toBe("Acme Corp logo");
    cleanup();
  });

  it("catches an error that does not bubble, which is every image error", () => {
    // `error` on an <img> does not bubble. A plain onerror on the container
    // would never fire, so the listener must be a capture-phase delegate.
    const container = mountBody('<img src="/api/images/proxy?url=x" alt="a">');
    const cleanup = hideFailedMailImages(container);

    const seen: EventTarget[] = [];
    container.addEventListener("error", (event) => seen.push(event.target!), true);
    container.addEventListener("error", (event) => seen.push(event.target!));

    container.querySelector("img")!.dispatchEvent(new Event("error", { bubbles: false }));

    // Exactly one handler reached it: the capturing one.
    expect(seen).toHaveLength(1);
    expect(container.querySelector(".mail-image-fallback")?.textContent).toBe("a");
    cleanup();
  });

  it("hides a failed image that has no alt text without inventing a placeholder", () => {
    // Tracking beacons are exactly the alt-less case, and an empty placeholder
    // box would leave a visible hole where the reader expects nothing.
    const container = mountBody('<p>Body</p><img src="/api/images/proxy?url=x" alt="">');
    const cleanup = hideFailedMailImages(container);

    const image = container.querySelector("img")!;
    image.dispatchEvent(new Event("error"));

    expect(image.style.display).toBe("none");
    expect(container.querySelector(".mail-image-fallback")).toBeNull();
    expect(container.textContent).toBe("Body");
    cleanup();
  });

  it("leaves an image that loaded alone", () => {
    const container = mountBody('<img src="/api/images/proxy?url=x" alt="chart">');
    const cleanup = hideFailedMailImages(container);

    const image = container.querySelector("img")!;
    // Not complete-with-zero-naturalWidth, i.e. still loading or loaded fine.
    Object.defineProperty(image, "naturalWidth", { value: 640 });
    Object.defineProperty(image, "complete", { value: true });
    const cleanup2 = hideFailedMailImages(container);

    expect(image.style.display).toBe("");
    expect(container.querySelector(".mail-image-fallback")).toBeNull();
    cleanup();
    cleanup2();
  });

  it("stops reacting once detached, so a stale listener cannot touch a new body", () => {
    const container = mountBody('<img src="/api/images/proxy?url=x" alt="a">');
    const cleanup = hideFailedMailImages(container);
    cleanup();

    container.querySelector("img")!.dispatchEvent(new Event("error"));

    expect(container.querySelector(".mail-image-fallback")).toBeNull();
  });

  it("tolerates a missing container", () => {
    expect(() => hideFailedMailImages(null)()).not.toThrow();
  });
});
