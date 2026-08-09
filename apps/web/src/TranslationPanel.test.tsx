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
          onTranslateWithLlm={() => undefined}
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

  it("auto-links URLs in translated text and preserves paragraph breaks", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <TranslationPanel
          availability="available"
          state={{ phase: "ready", translatedText: "Visit https://example.com for details.\n\nSecond paragraph.", visible: true }}
          onCheckAvailability={() => undefined}
          onTranslate={() => undefined}
          onTranslateWithLlm={() => undefined}
          onShow={() => undefined}
          onHide={() => undefined}
        />
      </I18nProvider>,
    );

    expect(markup).toContain('<a href="https://example.com"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).toContain("Second paragraph.");
    expect(markup).toContain("<p>");
  });

  it("keeps translation failures visible with an explicit retry action", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <TranslationPanel
          availability="available"
          state={{ phase: "error", message: "无法连接翻译服务。" }}
          onCheckAvailability={() => undefined}
          onTranslate={() => undefined}
          onTranslateWithLlm={() => undefined}
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
          onTranslateWithLlm={() => undefined}
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
          onTranslateWithLlm={() => undefined}
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

  it("offers AI translation when the free service is unconfigured but an LLM provider exists", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <TranslationPanel
          availability="unavailable"
          state={{ phase: "idle" }}
          llmAvailable={true}
          onCheckAvailability={() => undefined}
          onTranslate={() => undefined}
          onTranslateWithLlm={() => undefined}
          onShow={() => undefined}
          onHide={() => undefined}
        />
      </I18nProvider>,
    );

    expect(markup).toContain("使用 AI 翻译");
    expect(markup).toContain("token 费用");
  });

  it("does not offer AI translation when no LLM provider is configured", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <TranslationPanel
          availability="unavailable"
          state={{ phase: "idle" }}
          llmAvailable={false}
          onCheckAvailability={() => undefined}
          onTranslate={() => undefined}
          onTranslateWithLlm={() => undefined}
          onShow={() => undefined}
          onHide={() => undefined}
        />
      </I18nProvider>,
    );

    expect(markup).not.toContain("使用 AI 翻译");
  });

  it("shows a cancel action while a chunked translation is streaming", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <TranslationPanel
          availability="available"
          state={{ phase: "ready", translatedText: "部分翻译内容", visible: true, streaming: true }}
          onCheckAvailability={() => undefined}
          onTranslate={() => undefined}
          onTranslateWithLlm={() => undefined}
          onShow={() => undefined}
          onHide={() => undefined}
          onCancel={() => undefined}
        />
      </I18nProvider>,
    );

    expect(markup).toContain("正在翻译");
    expect(markup).toContain("取消翻译");
    expect(markup).toContain("部分翻译内容");
  });

  it("does not show a cancel action when streaming is not in progress", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <TranslationPanel
          availability="available"
          state={{ phase: "ready", translatedText: "完整翻译", visible: true }}
          onCheckAvailability={() => undefined}
          onTranslate={() => undefined}
          onTranslateWithLlm={() => undefined}
          onShow={() => undefined}
          onHide={() => undefined}
          onCancel={() => undefined}
        />
      </I18nProvider>,
    );

    expect(markup).not.toContain("取消翻译");
  });

  it("shows a cancel action while a non-streaming LLM translation is loading", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <TranslationPanel
          availability="unavailable"
          state={{ phase: "loading" }}
          onCheckAvailability={() => undefined}
          onTranslate={() => undefined}
          onTranslateWithLlm={() => undefined}
          onShow={() => undefined}
          onHide={() => undefined}
          onCancel={() => undefined}
        />
      </I18nProvider>,
    );

    expect(markup).toContain("正在翻译");
    expect(markup).toContain("取消翻译");
  });

  it("does not show a cancel action during loading when no cancel handler is provided", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <TranslationPanel
          availability="unavailable"
          state={{ phase: "loading" }}
          onCheckAvailability={() => undefined}
          onTranslate={() => undefined}
          onTranslateWithLlm={() => undefined}
          onShow={() => undefined}
          onHide={() => undefined}
        />
      </I18nProvider>,
    );

    expect(markup).toContain("正在翻译");
    expect(markup).not.toContain("取消翻译");
  });

  it("applies the original message's branded backdrop to the translated result", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <TranslationPanel
          availability="available"
          state={{ phase: "ready", translatedText: "深色邮件翻译", visible: true }}
          mailStyle={{ background: "#10131a", color: "#eef0f4", fontFamily: "Arial, Helvetica, sans-serif", fontSize: "14px" }}
          onCheckAvailability={() => undefined}
          onTranslate={() => undefined}
          onTranslateWithLlm={() => undefined}
          onShow={() => undefined}
          onHide={() => undefined}
        />
      </I18nProvider>,
    );

    expect(markup).toContain("has-mail-surface");
    expect(markup).toContain("background-color:#10131a");
    expect(markup).toContain("color:#eef0f4");
    expect(markup).toContain("font-family:Arial, Helvetica, sans-serif");
  });
});
