/**
 * Style-preserving translation for the HTML mail reader.
 *
 * Instead of replacing the whole body with plain text (which drops markup,
 * links, and inline styles), we follow the approach used by Immersive
 * Translate / mail-client extensions: walk the sanitized DOM, collect the
 * *visible text nodes*, send them to the server as segments, and write the
 * translations back into the same nodes. Tags, attributes, hrefs, and inline
 * styles are untouched, so the layout and look of the original email survive.
 *
 * Pure text bodies have no markup to preserve, so they keep the classic
 * single-document translation path (see App.tsx).
 */

const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "OBJECT", "EMBED", "FORM", "TEXTAREA", "SELECT",
]);

export type MailTextSegment = {
  /** Node path: a stable index trail from the root to this text node. */
  path: number[];
  /** The visible text content of the node. */
  text: string;
};

/**
 * Collects visible text nodes from a parsed HTML document, in document order.
 * Each segment keeps a path of child indices so the translation can be written
 * back to the exact same node after the DOM is cloned/rendered.
 */
export function extractMailTextSegments(root: ParentNode): MailTextSegment[] {
  const segments: MailTextSegment[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      const parent = node.parentNode as Element | null;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (SKIP_TAGS.has(parent.nodeName)) return NodeFilter.FILTER_REJECT;
      // Walk ancestors defensively: the immediate parent may be a
      // DocumentFragment (e.g. the root passed to extractMailTextSegments),
      // which has no getAttribute.
      let ancestor: Node | null = parent;
      while (ancestor && ancestor.nodeType === Node.ELEMENT_NODE) {
        const element = ancestor as Element;
        if (element.getAttribute("contenteditable") === "false") return NodeFilter.FILTER_REJECT;
        ancestor = ancestor.parentNode;
      }
      const text = node.textContent ?? "";
      // Keep meaningful whitespace (e.g. "Hello " before an inline element) so
      // translating and writing back does not glue words together, but skip
      // nodes that contain only whitespace.
      return text.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  // Build the path for each accepted node by walking up from it.
  let node: Node | null = walker.nextNode();
  while (node) {
    const path: number[] = [];
    let currentNode: Node | null = node;
    while (currentNode && currentNode !== root) {
      const parentNode: ParentNode | null = currentNode.parentNode;
      if (!parentNode) break;
      const index = Array.prototype.indexOf.call(parentNode.childNodes, currentNode);
      path.unshift(index);
      currentNode = parentNode;
    }
    const text = node.textContent ?? "";
    segments.push({ path, text });
    node = walker.nextNode();
  }
  return segments;
}

/**
 * Writes translated text back into the text node located by `path`. Returns the
 * node for convenience; `null` when the path no longer resolves (e.g. the DOM
 * was rebuilt between extraction and application).
 */
export function applyMailTranslation(root: ParentNode, path: number[], translatedText: string): Text | null {
  let current: Node = root;
  for (let depth = 0; depth < path.length; depth++) {
    const index = path[depth]!;
    const children = current.childNodes;
    if (index >= children.length) return null;
    current = children[index]!;
  }
  if (current.nodeType !== Node.TEXT_NODE) return null;
  current.textContent = translatedText;
  return current as Text;
}

/**
 * Translates the visible text segments of a rendered mail body. `onApply` is
 * invoked per segment as translations arrive so the reader updates
 * incrementally. Returns true when every segment was applied.
 */
export async function translateMailDom(
  root: ParentNode,
  segments: MailTextSegment[],
  translateSegments: (segments: string[]) => Promise<string[]>,
  onApply?: (applied: number, total: number) => void,
): Promise<boolean> {
  if (segments.length === 0) return true;
  const texts = segments.map((segment) => segment.text);
  const translations = await translateSegments(texts);
  if (translations.length !== segments.length) return false;
  let applied = 0;
  for (let index = 0; index < segments.length; index++) {
    const ok = applyMailTranslation(root, segments[index]!.path, translations[index]!);
    if (ok) applied += 1;
    onApply?.(applied, segments.length);
  }
  return applied === segments.length;
}
