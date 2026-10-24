import { act } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider, translate } from "../../i18n";
import type { PreviewDocument } from "../document";

/** Shared plumbing for surface tests: markup for static cases, mount for events. */

export const zh = (key: string, values?: Record<string, string | number>) => translate("zh-CN", key, values);

export function markup(element: ReactElement): string {
  return renderToStaticMarkup(<I18nProvider>{element}</I18nProvider>);
}

export type Mounted = {
  container: HTMLElement;
  unmount: () => Promise<void>;
};

export async function mount(element: ReactElement): Promise<Mounted> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(<I18nProvider>{element}</I18nProvider>);
  });
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

/** Lets pending promises settle inside act, so effects finish before assertions. */
export async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

export function documentWith(surface: PreviewDocument["surface"], overrides: Partial<PreviewDocument> = {}): PreviewDocument {
  return {
    kind: "text",
    filename: "notes.txt",
    contentType: "text/plain",
    size: 11,
    surface,
    ...overrides,
  };
}
