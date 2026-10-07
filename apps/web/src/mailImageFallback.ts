/**
 * Graceful degradation for images in a mail body.
 *
 * A mail body's remote images load through /api/images/proxy, which fails
 * closed on purpose: a private/reserved host, a dead link, a non-image response
 * or a body over the proxy's size/wall-clock ceiling all come back 404. The
 * reader must not pay for that with a broken-image glyph mid-paragraph, and
 * above all the rest of the body has to keep rendering — a failed picture is
 * never a reason for the mail itself to fail.
 */

/** Hides one failed image, keeping its alt text visible in its place. */
function collapseFailedImage(element: HTMLImageElement | SVGImageElement): void {
  const alt = (element.getAttribute("alt") || "").trim();
  element.style.display = "none";
  if (!alt) return;
  const placeholder = element.ownerDocument.createElement("span");
  // Carries a class rather than inline styling on purpose: the aggregated
  // stylesheet is under a frozen line-count ratchet (styles-size.test.ts) with no
  // growth budget, so this stays an unstyled hook that inherits the body's own
  // typography instead of buying a rule.
  placeholder.className = "mail-image-fallback";
  placeholder.textContent = alt;
  element.replaceWith(placeholder);
}

/**
 * Collapses every image in `container` that fails to load, now and in future.
 *
 * The listener is delegated on the container because `error` does not bubble but
 * does propagate through the capture phase, and because the nodes created by
 * dangerouslySetInnerHTML are invisible to React's synthetic events. Returns the
 * cleanup that detaches it.
 */
export function hideFailedMailImages(container: Element | null): () => void {
  if (!container) return () => {};
  const onError = (event: Event) => {
    const target = event.target;
    if (target instanceof HTMLImageElement || target instanceof SVGImageElement) collapseFailedImage(target);
  };
  container.addEventListener("error", onError, true);
  // An image that had already failed before this listener attached (cached
  // error, or a body swapped in while off-screen) never fires another event.
  for (const image of container.querySelectorAll<HTMLImageElement>("img[src]")) {
    if (image.complete && image.naturalWidth === 0) collapseFailedImage(image);
  }
  return () => container.removeEventListener("error", onError, true);
}
