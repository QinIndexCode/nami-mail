import { useRef, useState } from "react";
import { LayoutTemplate, LoaderCircle, RefreshCw } from "lucide-react";
import { api } from "./api";
import { usePopupExitTransition } from "./hooks/usePopupExitTransition";
import { useI18n } from "./i18n";
import type { MailTemplate } from "./types";

export type ComposeTemplatePickerProps = {
  disabled?: boolean;
  isDemo: boolean;
  onApplyTemplate: (template: MailTemplate) => void;
};

export default function ComposeTemplatePicker({
  disabled = false,
  isDemo,
  onApplyTemplate,
}: ComposeTemplatePickerProps) {
  const { t } = useI18n();
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const {
    mounted: templatePickerMounted,
    closing: templatePickerClosing,
    beginClose: beginTemplatePickerClose,
  } = usePopupExitTransition(templatePickerOpen, () => setTemplatePickerOpen(false));
  const [composeTemplates, setComposeTemplates] = useState<MailTemplate[] | null>(null);
  const [templateLoadBusy, setTemplateLoadBusy] = useState(false);
  const [templateLoadFailed, setTemplateLoadFailed] = useState(false);
  const templateLoadInFlightRef = useRef(false);

  const loadComposeTemplates = async () => {
    if (isDemo || composeTemplates || templateLoadInFlightRef.current) return;
    templateLoadInFlightRef.current = true;
    setTemplateLoadBusy(true);
    setTemplateLoadFailed(false);
    try {
      const result = await api.templates();
      setComposeTemplates(result.items);
    } catch {
      setTemplateLoadFailed(true);
    } finally {
      templateLoadInFlightRef.current = false;
      setTemplateLoadBusy(false);
    }
  };

  const toggleTemplatePicker = () => {
    if (disabled) return;
    if (templatePickerOpen) {
      beginTemplatePickerClose();
      return;
    }
    setTemplatePickerOpen(true);
    void loadComposeTemplates();
  };

  const handleSelectTemplate = (template: MailTemplate) => {
    beginTemplatePickerClose();
    onApplyTemplate(template);
  };

  return (
    <div className="compose-template-wrap">
      <button
        className="secondary-button compose-template-toggle"
        type="button"
        disabled={disabled}
        onClick={toggleTemplatePicker}
        aria-expanded={templatePickerOpen}
        aria-controls={templatePickerOpen ? "compose-template-picker" : undefined}
        aria-haspopup="listbox"
      >
        <LayoutTemplate size={15} />
        {t("compose.templates")}
      </button>
      {templatePickerMounted && (
        <div
          className={`compose-template-picker${templatePickerClosing ? " closing" : ""}`}
          id="compose-template-picker"
          role="listbox"
          aria-label={t("compose.templates")}
        >
          {isDemo ? (
            <p className="compose-template-empty" role="status">{t("compose.templates.demoUnavailable")}</p>
          ) : templateLoadBusy ? (
            <p className="compose-template-empty" role="status">
              <LoaderCircle className="spin" size={14} aria-hidden="true" />
              {t("common.loading")}
            </p>
          ) : templateLoadFailed ? (
            <div className="compose-template-empty" role="alert">
              <span>{t("compose.templates.loadFailed")}</span>
              <button className="secondary-button" type="button" onClick={() => void loadComposeTemplates()}>
                <RefreshCw size={14} aria-hidden="true" />
                {t("common.retry")}
              </button>
            </div>
          ) : composeTemplates && composeTemplates.length === 0 ? (
            <p className="compose-template-empty" role="status">{t("compose.templates.empty")}</p>
          ) : (
            <ul className="compose-template-list">
              {composeTemplates?.map((template, index) => (
                <li key={template.id}>
                  <button
                    type="button"
                    role="option"
                    id={`compose-template-option-${index}`}
                    onClick={() => handleSelectTemplate(template)}
                  >
                    <span>{template.name}</span>
                    {template.subject && <small>{template.subject}</small>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
