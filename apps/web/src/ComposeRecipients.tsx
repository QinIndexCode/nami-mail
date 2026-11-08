import { BookUser } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useI18n } from "./i18n";
import { useRecipientSuggestions } from "./useRecipientSuggestions";

type RecipientKind = "to" | "cc" | "bcc";
type Props = Record<RecipientKind, string> & {
  onChange: (kind: RecipientKind, value: string) => void;
  disabled: boolean;
  isDemo: boolean;
};

function RecipientField({ kind, value, onChange, disabled, isDemo, visible, children }: {
  kind: RecipientKind; value: string; onChange: (value: string) => void;
  disabled: boolean; isDemo: boolean; visible: boolean; children?: ReactNode;
}) {
  const { t } = useI18n();
  const id = `compose-${kind}`;
  const controlsId = kind === "to" ? "compose-contact-suggestions" : `${id}-contact-suggestions`;
  const suggestions = useRecipientSuggestions({ isDemo, controlsId, onApplyRecipient: onChange });
  const optionId = (index: number) => kind === "to" ? `compose-contact-suggestion-${index}` : `${controlsId}-suggestion-${index}`;
  return (
    <div className={`compose-row compose-${kind === "to" ? "to" : "cc"}-row${kind === "to" ? "" : visible ? " is-open" : " is-collapsed"}`}>
      <label htmlFor={id}><span id={`${id}-label`}>{t(`compose.${kind}`)}</span>
        <div className="compose-to-input-wrap">
          <input id={id} type="text" data-dialog-initial-focus={kind === "to" || undefined} value={value}
            onChange={(event) => { onChange(event.target.value); suggestions.search(event.target.value); }}
            onKeyDown={(event) => suggestions.onKeyDown(event, value)}
            placeholder={kind === "to" ? "email@example.com" : t("compose.ccPlaceholder")} disabled={disabled}
            aria-labelledby={`${id}-label`} aria-autocomplete="list" aria-expanded={suggestions.open}
            aria-controls={suggestions.open ? controlsId : undefined} aria-activedescendant={suggestions.activeDescendantId} />
          <button type="button" className="compose-contact-picker-btn" aria-label={t("compose.searchContacts")} data-tooltip={t("compose.searchContacts")} onClick={() => suggestions.toggle(value)} disabled={disabled}><BookUser size={14} /></button>
          {children}
        </div>
      </label>
      {suggestions.mounted && (
        <div className={`compose-contact-suggestions${suggestions.closing ? " closing" : ""}`} id={controlsId} role="listbox" aria-label={t("compose.contactSuggestions")}>
          {suggestions.suggestions.map((contact, index) => (
            <button key={contact.id} type="button" role="option" id={optionId(index)} aria-selected={index === suggestions.suggestedIndex} onMouseDown={(event) => event.preventDefault()} onClick={() => suggestions.applyContact(contact, value)}>
              <span>{contact.name || contact.email}</span><small>{contact.name ? contact.email : ""}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ComposeRecipients({ to, cc, bcc, onChange, disabled, isDemo }: Props) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState({ cc: Boolean(cc.trim()), bcc: Boolean(bcc.trim()) });
  const shared = { disabled, isDemo };
  return <>
    <RecipientField {...shared} kind="to" value={to} onChange={(value) => onChange("to", value)} visible>
      {(["cc", "bcc"] as const).filter((kind) => !expanded[kind] && !(kind === "cc" ? cc : bcc).trim()).map((kind) => (
        <button key={kind} type="button" className="compose-cc-toggle" onClick={() => setExpanded((current) => ({ ...current, [kind]: true }))} disabled={disabled}>{t(`compose.${kind}`)}</button>
      ))}
    </RecipientField>
    <RecipientField {...shared} kind="cc" value={cc} onChange={(value) => onChange("cc", value)} visible={expanded.cc || Boolean(cc.trim())} />
    <RecipientField {...shared} kind="bcc" value={bcc} onChange={(value) => onChange("bcc", value)} visible={expanded.bcc || Boolean(bcc.trim())} />
  </>;
}
