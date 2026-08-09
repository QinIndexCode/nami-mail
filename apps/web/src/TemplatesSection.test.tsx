import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider, translate } from "./i18n";
import TemplatesSection from "./TemplatesSection";
import type { MailTemplate } from "./types";

const zh = (key: string, values?: Record<string, string | number>) => translate("zh-CN", key, values);

const templates: MailTemplate[] = [
  {
    id: "template-1",
    name: "开会确认",
    subject: "会议确认：{date}",
    body: "确认收到会议邀请，届时准时参加。",
    createdAt: "",
    updatedAt: "",
  },
  {
    id: "template-2",
    name: "欢迎信",
    subject: "",
    body: "欢迎加入团队！",
    createdAt: "",
    updatedAt: "",
  },
];

function renderSection(options: { demoMode?: boolean; initialTemplates?: MailTemplate[] } = {}): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <TemplatesSection demoMode={options.demoMode} initialTemplates={options.initialTemplates} />
    </I18nProvider>,
  );
}

describe("templates section", () => {
  it("renders the section header and an empty-state hint when there are no templates", () => {
    const markup = renderSection({ initialTemplates: [] });

    expect(markup).toContain('id="templates-settings"');
    expect(markup).toContain(zh("settings.templates.title"));
    expect(markup).toContain(zh("settings.templates.description"));
    expect(markup).toContain(zh("settings.templates.empty"));
    expect(markup).toContain(zh("settings.templates.addTemplate"));
  });

  it("renders each template with its name, subject and body", () => {
    const markup = renderSection({ initialTemplates: templates });

    expect(markup).toContain("开会确认");
    expect(markup).toContain("会议确认：{date}");
    expect(markup).toContain("确认收到会议邀请，届时准时参加。");
    expect(markup).toContain("欢迎信");
    expect(markup).toContain("欢迎加入团队！");
    expect(markup).toContain(zh("settings.templates.edit"));
    expect(markup).toContain(zh("settings.templates.delete"));
  });

  it("shows the search / pagination toolbar and only the first page of rows once there are more templates than one page holds", () => {
    const many: MailTemplate[] = Array.from({ length: 7 }, (_, index) => ({
      id: `template-${index}`,
      name: `模板 ${index}`,
      subject: "",
      body: `正文 ${index}`,
      createdAt: "",
      updatedAt: "",
    }));
    const markup = renderSection({ initialTemplates: many });

    // Toolbar with search, select-all and pagination appears.
    expect(markup).toContain("templates-toolbar");
    expect(markup).toContain(zh("settings.templates.searchPlaceholder"));
    expect(markup).toContain(zh("settings.templates.selectAll"));
    expect(markup).toContain(zh("settings.templates.pagerPrevious"));
    expect(markup).toContain(zh("settings.templates.pagerNext"));
    expect(markup).toContain(zh("settings.templates.pagerLabel", { page: 1, total: 2 }));

    // Only the first page (5 rows) renders.
    for (let index = 0; index < 5; index += 1) expect(markup).toContain(`正文 ${index}`);
    for (let index = 5; index < 7; index += 1) expect(markup).not.toContain(`正文 ${index}`);
  });

  it("declines to offer templates in demo mode", () => {
    const markup = renderSection({ demoMode: true, initialTemplates: [] });

    expect(markup).toContain(zh("settings.templates.demoUnavailable"));
    expect(markup).not.toContain(zh("settings.templates.addTemplate"));
  });
});
