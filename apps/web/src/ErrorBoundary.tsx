import { Component, type ErrorInfo, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import type { Translate } from "./i18n";
import { useI18n } from "./i18n";

type Props = {
  children: ReactNode;
  /** Shown in the fallback so the user knows which area failed (reader, dialog, ...). */
  area?: string;
  t: Translate;
};

type State = { error: Error | null };

/**
 * Catches render-phase errors so a single broken subtree (e.g. one message
 * failing to parse) cannot unmount the whole application.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[nami] render error", error, info.componentStack);
  }

  override render(): ReactNode {
    const { area, t, children } = this.props;
    if (this.state.error) {
      return (
        <div className="error-boundary-fallback" role="alert">
          <TriangleAlert size={20} aria-hidden="true" />
          <strong>{t("app.crash.title")}</strong>
          <p>{area ? t("app.crash.messageArea", { area }) : t("app.crash.message")}</p>
          <button type="button" onClick={() => window.location.reload()}>
            {t("app.crash.reload")}
          </button>
        </div>
      );
    }
    return children;
  }
}

/** App-wide boundary; consumes the active locale so the fallback is translated. */
export function AppBoundary({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return (
    <ErrorBoundary t={t}>
      {children}
    </ErrorBoundary>
  );
}