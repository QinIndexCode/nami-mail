// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "./i18n";
import ThemedSelect from "./ThemedSelect";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("themed select", () => {
  it("renders an app-owned select-only combobox trigger instead of a browser select control", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ThemedSelect id="mailbox" value="gmail" onValueChange={() => undefined}>
          <option value="gmail">Gmail</option>
          <option value="outlook">Outlook</option>
        </ThemedSelect>
      </I18nProvider>,
    );

    expect(markup).toContain('aria-haspopup="listbox"');
    expect(markup).toContain('role="combobox"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('aria-controls=');
    expect(markup).not.toContain('aria-activedescendant=');
    expect(markup).toContain('class="themed-select"');
    expect(markup).not.toContain("<select");
  });

  it("portals its listbox to the body instead of growing the trigger's container", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    let root: Root | null = null;
    await act(async () => {
      root = createRoot(container);
      root.render(
        <I18nProvider>
          <ThemedSelect id="mailbox" value="gmail" onValueChange={() => undefined}>
            <option value="gmail">Gmail</option>
            <option value="outlook">Outlook</option>
          </ThemedSelect>
        </I18nProvider>,
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>("#mailbox");
    expect(trigger, "the combobox trigger should be inside the container").not.toBeNull();
    await act(async () => {
      trigger?.click();
    });

    expect(container.querySelector('[role="listbox"]'), "the menu must not stay in the trigger's flow").toBeNull();
    const menu = document.querySelector<HTMLElement>('[role="listbox"]');
    expect(menu, "the menu should be open").not.toBeNull();
    expect(menu!.parentElement, "the menu should be attached to document.body").toBe(document.body);
    expect(trigger!.getAttribute("aria-expanded")).toBe("true");
    expect(trigger!.getAttribute("aria-controls")).toBe(menu!.id);
    expect(menu!.querySelectorAll('[role="option"]')).toHaveLength(2);

    await act(async () => {
      root?.unmount();
    });
    container.remove();
    expect(document.querySelector('[role="listbox"]'), "unmounting must remove the portal").toBeNull();
  });
});
