import { useMemo } from "react";
import { calculateTextStats } from "./composeMarkdown";
import { useI18n } from "./i18n";

export type ComposeWordCounterProps = {
  text: string;
};

export default function ComposeWordCounter({ text }: ComposeWordCounterProps) {
  const { t } = useI18n();
  const stats = useMemo(() => calculateTextStats(text), [text]);

  if (!text.trim()) return null;

  return (
    <div className="compose-word-counter" aria-live="polite">
      <span>{t("compose.markdown.statsWords", { count: stats.words })}</span>
      <span className="compose-counter-dot">{t("common.dotSeparator")}</span>
      <span>{t("compose.markdown.statsChars", { count: stats.characters })}</span>
      <span className="compose-counter-dot">{t("common.dotSeparator")}</span>
      <span>{t("compose.markdown.statsReading", { minutes: stats.readingMinutes })}</span>
    </div>
  );
}
