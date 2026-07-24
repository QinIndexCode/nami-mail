import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "./i18n";
import TranslationPanel from "./TranslationPanel";

describe("translation panel", () => {
  it("renders translated content as selectable plain text with an accuracy disclosure", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <TranslationPanel
          availability="available"
          state={{ phase: "ready", translatedText: "<strong>Safe text</strong>", detectedLanguage: "en", visible: true }}
          onCheckAvailability={() => undefined}
          onTranslate={() => undefined}
          onShow={() => undefined}
          onHide={() => undefined}
        />
      </I18nProvider>,
    );

    expect(markup).toContain("translation-text");
    expect(markup).toContain("机器翻译可能不准确");
    expect(markup).toContain("&lt;strong&gt;Safe text&lt;/strong&gt;");
    expect(markup).not.toContain("<strong>Safe text</strong>");
  });

  it("keeps translation failures visible with an explicit retry action", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <TranslationPanel
          availability="available"
          state={{ phase: "error", message: "无法连接翻译服务。" }}
          onCheckAvailability={() => undefined}
          onTranslate={() => undefined}
          onShow={() => undefined}
          onHide={() => undefined}
        />
      </I18nProvider>,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("重试");
  });

  it("keeps a prior result visible while a manual refresh is running", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <TranslationPanel
          availability="available"
          state={{ phase: "loading", previous: { translatedText: "现有翻译", visible: true } }}
          onCheckAvailability={() => undefined}
          onTranslate={() => undefined}
          onShow={() => undefined}
          onHide={() => undefined}
        />
      </I18nProvider>,
    );

    expect(markup).toContain("现有翻译");
    expect(markup).toContain("正在翻译");
    expect(markup).toContain('role="status"');
  });

  it("does not offer a failing translate action before a local service is configured", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <TranslationPanel
          availability="unavailable"
          state={{ phase: "idle" }}
          onCheckAvailability={() => undefined}
          onTranslate={() => undefined}
          onShow={() => undefined}
          onHide={() => undefined}
        />
      </I18nProvider>,
    );

    expect(markup).toContain("翻译服务尚未配置");
    expect(markup).toContain("重新检查配置");
    expect(markup).not.toContain("翻译为 简体中文");
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
  });
});
