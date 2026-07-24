import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "./i18n";
import ThemedSelect from "./ThemedSelect";

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
});
