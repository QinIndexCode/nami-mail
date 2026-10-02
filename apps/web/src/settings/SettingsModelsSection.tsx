import { useCallback, useEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  Bot,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Star,
  Trash2,
} from "lucide-react";
import type { AgentMcpServerSummary, AgentProviderList, AgentProviderSummary } from "../agentTypes";
import type { Translate } from "../i18n";
import { ModelFeedbackLine } from "./SettingsModelDialog";
import SettingsModelMcpDialog from "./SettingsModelMcpDialog";
import SettingsModelProviderDialog from "./SettingsModelProviderDialog";
import { mcpServerVisualState, providerVisualState } from "./settings-models";
import { useMcpServers, useModelProviders } from "./useSettingsModels";

export type SettingsModelsSectionProps = {
  t: Translate;
  /** Demo sessions never reach the local Agent service, so the panel shows the
   *  same in-memory notice the agent category uses instead of fetching. */
  demoMode: boolean;
  /** Seeds the first frame from the App-level bootstrap preload; the list is
   *  still refetched on mount. */
  initialProviders: AgentProviderSummary[];
  initialDefaultProviderId: string | null;
  /** Fired after every save or delete so the host can sync the workspace. */
  onProvidersChanged: (snapshot: AgentProviderList) => void;
  /** A form dialog is stacked over the panel: the host stops closing itself. */
  onOverlayOpenChange?: (open: boolean) => void;
  /** A save or connection check is running: the host guards its own close. */
  onBusyChange?: (busy: boolean) => void;
  /**
   * The settings backdrop. The forms portal into it rather than rendering under
   * the panel — see the note next to the portal call below.
   */
  overlayHostRef: RefObject<HTMLElement | null>;
};

/**
 * Status dots reuse the settings `status-dot` scale, not the agent one. Green
 * means "verified"; amber means "configured but not proven" (or a connection
 * that needs review); red means unusable; grey means switched off.
 */
function providerDotClass(provider: AgentProviderSummary): string {
  const state = providerVisualState(provider);
  if (state === "verified") return "";
  if (state === "configurationComplete" || state === "degraded") return " warning";
  return " error";
}

function mcpDotClass(server: AgentMcpServerSummary): string {
  const state = mcpServerVisualState(server);
  if (state === "checked") return "";
  if (state === "disabled") return " muted";
  return state === "failed" ? " error" : " warning";
}

/** The muted line under a row title: state, where the model runs, and the
 *  connection's identity (model id for providers, command line for servers). */
function providerSummary(provider: AgentProviderSummary, t: Translate): string {
  return [
    t(`agent.providers.status.${providerVisualState(provider)}`),
    provider.cloud ? t("agent.providers.status.cloud") : t("agent.providers.status.local"),
    provider.model,
  ].filter(Boolean).join(" · ");
}

function mcpSummary(server: AgentMcpServerSummary, t: Translate): string {
  const parts = [t(`agent.mcpServers.status.${mcpServerVisualState(server)}`)];
  if (server.toolCount !== undefined) parts.push(t("agent.mcpServers.status.tools", { count: server.toolCount }));
  parts.push([server.command, ...server.args].join(" "));
  return parts.join(" · ");
}

export default function SettingsModelsSection({
  t,
  demoMode,
  initialProviders,
  initialDefaultProviderId,
  onProvidersChanged,
  onOverlayOpenChange,
  onBusyChange,
  overlayHostRef,
}: SettingsModelsSectionProps) {
  const providers = useModelProviders({
    enabled: !demoMode,
    initialProviders,
    initialDefaultProviderId,
    onProvidersChanged: demoMode ? () => undefined : onProvidersChanged,
    t,
  });
  const mcp = useMcpServers({ enabled: !demoMode, t });
  // The settings modal guards its own Escape / backdrop / "done" paths, and its
  // focus trap, on ONE flag reported from here — never one per dialog: with two
  // independent forms mounted, whichever unmounted last would clear a signal the
  // other still needs. The panel's own state is the single source of truth.
  const overlayOpen = providers.editing || mcp.editing;
  useEffect(() => {
    onOverlayOpenChange?.(overlayOpen);
    return () => onOverlayOpenChange?.(false);
  }, [overlayOpen, onOverlayOpenChange]);
  // The settings modal must hold still for BOTH kinds of pending work: the form
  // dialogs (which report their own save/check) and the row-level actions —
  // check, set-default, delete — that never go through a dialog but can run for
  // the whole 120 s check timeout. One OR'd flag, for the same reason as above.
  const [dialogBusy, setDialogBusy] = useState(false);
  const panelBusy = dialogBusy || providers.panelBusy || mcp.panelBusy;
  useEffect(() => {
    onBusyChange?.(panelBusy);
    return () => onBusyChange?.(false);
  }, [onBusyChange, panelBusy]);
  const reportBusy = useCallback((busy: boolean) => setDialogBusy(busy), []);

  if (demoMode) {
    return (
      <section className="settings-section" data-settings-nav="models" aria-labelledby="models-settings">
        <div className="settings-section-title">
          <Bot size={16} />
          <div><span id="models-settings">{t("settings.nav.models.title")}</span><p>{t("settings.nav.models.description")}</p></div>
        </div>
        <p className="settings-empty" role="status">{t("agent.demo.modelsUnavailable")}</p>
      </section>
    );
  }

  const providerBusy = providers.saving || providers.checkingId !== null;
  const mcpBusy = mcp.saving || mcp.checkingId !== null;

  // The two forms are stacked over the panel, so they must not sit inside it.
  // `.settings-panel` runs `animation: .2s both settings-panel-in`, and
  // `fill-mode: both` leaves the animated `transform` at its end value — which
  // the browser resolves to an identity `matrix(...)`, still a value other than
  // `none`. A transformed ancestor becomes the containing block for its
  // `position: fixed` descendants, so a dialog rendered here measured against
  // the panel (787×522 at (592,201) in a 1707×932 window) instead of the
  // window: the backdrop covered only the panel and the card was cropped on
  // every side. The backdrop has no transform, so portalling there lands the
  // dialog in the layer `.confirmation-card` already uses — a sibling of the
  // settings card, above it, unaffected by the panel's animation.
  const formDialogs = (
    <>
      {providers.editing && (
        <SettingsModelProviderDialog t={t} providers={providers} onBusyChange={reportBusy} />
      )}
      {mcp.editing && (
        <SettingsModelMcpDialog t={t} mcp={mcp} onBusyChange={reportBusy} />
      )}
    </>
  );

  return (
    <>
      <section className="settings-section" data-settings-nav="models" aria-labelledby="models-settings">
        <div className="settings-section-title">
          <Bot size={16} />
          <div><span id="models-settings">{t("settings.nav.models.title")}</span><p>{t("settings.nav.models.description")}</p></div>
        </div>
      </section>

      <section className="settings-section" data-models-card="providers" aria-labelledby="models-providers-title">
        <div className="settings-section-title">
          <KeyRound size={16} />
          <div><span id="models-providers-title">{t("agent.providers.title")}</span><p>{t("agent.providers.description")}</p></div>
        </div>
        {providers.loading && providers.providers.length === 0 && (
          <p className="settings-empty" role="status"><LoaderCircle className="spin" size={14} aria-hidden="true" />{t("agent.providers.loading")}</p>
        )}
        {!providers.loading && providers.providers.length === 0 && (
          <p className="settings-empty" role="status">{t("agent.providers.empty")}<br />{t("agent.providers.emptyDescription")}</p>
        )}
        {providers.providers.map((provider) => {
          const isDefault = provider.id === providers.defaultProviderId;
          const rowDeletePending = providers.deletePendingId === provider.id;
          const rowChecking = providers.checkingId === provider.id;
          return (
            <div
              key={provider.id}
              className="setting-row"
              data-model-row="provider"
              data-provider-id={provider.id}
              data-default={isDefault ? "true" : "false"}
            >
              <div>
                <strong>
                  {provider.label}
                  {isDefault && <span> · {t("agent.providers.status.default")}</span>}
                </strong>
                <span>{providerSummary(provider, t)}</span>
              </div>
              <div className="settings-row-actions">
                <span className={`status-dot${providerDotClass(provider)}`} aria-hidden="true" />
                {!isDefault && (
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={providerBusy}
                    onClick={() => void providers.setDefault(provider)}
                  >
                    <Star size={13} />{t("settings.models.providers.setDefault")}
                  </button>
                )}
                <button
                  className="secondary-button"
                  type="button"
                  disabled={providerBusy}
                  onClick={() => void providers.check(provider)}
                >
                  {rowChecking ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
                  {t("agent.providers.check")}
                </button>
                <button className="secondary-button" type="button" disabled={providerBusy} onClick={() => providers.startEdit(provider)}>
                  <Pencil size={13} />{t("settings.models.edit")}
                </button>
                <button
                  className={`secondary-button danger-button${rowDeletePending ? " settings-model-delete-pending" : ""}`}
                  type="button"
                  disabled={providerBusy}
                  onClick={() => (rowDeletePending ? void providers.confirmDelete(provider.id) : providers.requestDelete(provider.id))}
                >
                  <Trash2 size={13} />{rowDeletePending ? t("agent.providers.deleteConfirm") : t("agent.providers.delete")}
                </button>
              </div>
            </div>
          );
        })}
        {providers.deletePendingId !== null && <p className="settings-model-delete-note">{t("agent.providers.deletePrompt")}</p>}
        <div className="settings-inline-actions">
          <button className="secondary-button" type="button" disabled={providerBusy} onClick={providers.startCreate}>
            <Plus size={15} />{t("agent.providers.new")}
          </button>
        </div>
        {/* A list load failure retries the load; a row action's outcome stays in
            its dialog, so only the closeable card shows anything here. */}
        {providers.listError && (
          <ModelFeedbackLine
            feedback={{ kind: "error", message: providers.listError, retry: () => providers.retryList() }}
            retryLabel={t("agent.providers.retry")}
            busy={providerBusy}
          />
        )}
        {!providers.editing && providers.feedback && (
          <ModelFeedbackLine feedback={providers.feedback} retryLabel={t("agent.providers.retry")} busy={providerBusy} />
        )}
      </section>

      <section className="settings-section" data-models-card="mcp" aria-labelledby="models-mcp-title">
        <div className="settings-section-title">
          <Server size={16} />
          <div><span id="models-mcp-title">{t("agent.mcpServers.title")}</span><p>{t("agent.mcpServers.description")}</p></div>
        </div>
        {mcp.loading && mcp.servers.length === 0 && (
          <p className="settings-empty" role="status"><LoaderCircle className="spin" size={14} aria-hidden="true" />{t("agent.mcpServers.loading")}</p>
        )}
        {!mcp.loading && mcp.servers.length === 0 && (
          <p className="settings-empty" role="status">{t("agent.mcpServers.empty")}<br />{t("agent.mcpServers.emptyDescription")}</p>
        )}
        {mcp.servers.map((server) => {
          const rowDeletePending = mcp.deletePendingId === server.id;
          const rowChecking = mcp.checkingId === server.id;
          return (
            <div key={server.id} className="setting-row" data-model-row="mcp" data-mcp-id={server.id}>
              <div>
                <strong>{server.label}</strong>
                <span>{mcpSummary(server, t)}</span>
              </div>
              <div className="settings-row-actions">
                <span className={`status-dot${mcpDotClass(server)}`} aria-hidden="true" />
                <button
                  className="secondary-button"
                  type="button"
                  disabled={mcpBusy}
                  onClick={() => void mcp.check(server)}
                >
                  {rowChecking ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
                  {t("agent.mcpServers.check")}
                </button>
                <button className="secondary-button" type="button" disabled={mcpBusy} onClick={() => mcp.startEdit(server)}>
                  <Pencil size={13} />{t("settings.models.edit")}
                </button>
                <button
                  className={`secondary-button danger-button${rowDeletePending ? " settings-model-delete-pending" : ""}`}
                  type="button"
                  disabled={mcpBusy}
                  onClick={() => (rowDeletePending ? void mcp.confirmDelete(server.id) : mcp.requestDelete(server.id))}
                >
                  <Trash2 size={13} />{rowDeletePending ? t("agent.mcpServers.deleteConfirm") : t("agent.mcpServers.delete")}
                </button>
              </div>
            </div>
          );
        })}
        {mcp.deletePendingId !== null && <p className="settings-model-delete-note">{t("agent.mcpServers.deletePrompt")}</p>}
        <div className="settings-inline-actions">
          <button className="secondary-button" type="button" disabled={mcpBusy} onClick={mcp.startCreate}>
            <Plus size={15} />{t("agent.mcpServers.new")}
          </button>
        </div>
        {mcp.listError && (
          <ModelFeedbackLine
            feedback={{ kind: "error", message: mcp.listError, retry: () => mcp.retryList() }}
            retryLabel={t("agent.mcpServers.retry")}
            busy={mcpBusy}
          />
        )}
        {!mcp.editing && mcp.feedback && (
          <ModelFeedbackLine feedback={mcp.feedback} retryLabel={t("agent.mcpServers.retry")} busy={mcpBusy} />
        )}
      </section>

      {overlayHostRef.current
        ? createPortal(formDialogs, overlayHostRef.current)
        : formDialogs}
    </>
  );
}