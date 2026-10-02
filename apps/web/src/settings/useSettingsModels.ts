import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type {
  AgentMcpServerSummary,
  AgentProviderKind,
  AgentProviderList,
  AgentProviderSummary,
} from "../agentTypes";
import type { Translate } from "../i18n";
import {
  mcpCheckFeedback,
  mcpEnvRowsFor,
  mcpRequestFeedback,
  mcpServerFormFor,
  mcpServerInputFor,
  mcpValidationMessage,
  nextEnvRowId,
  providerFormFor,
  providerHealthFeedback,
  providerInputFor,
  providerKindMetadata,
  providerListAfterSave,
  providerRequestFeedback,
  providerValidationMessage,
  type EnvRow,
  type McpServerForm,
  type ModelFeedback,
  type ProviderForm,
} from "./settings-models";

/**
 * List/form state for the two cards of the settings "models" panel. Both hooks
 * follow the same rules:
 *
 * - the newest list request wins (open-time load, retry and the post-save
 *   refresh can otherwise interleave);
 * - a refresh must never rebuild a form the user is mid-edit on. An action
 *   taken on ANOTHER row (promote to default, delete, check) refreshes the list
 *   only, so a half-typed draft — including a write-only API key — survives;
 * - load failures and operation failures are separate channels: `listError`
 *   retries by refetching the list, `feedback` retries by repeating the
 *   operation that failed;
 * - feedback lives on the dialog while it is open, so a save that fails the
 *   connection check stays on screen next to the form that caused it.
 */

export type ModelProvidersController = {
  providers: AgentProviderSummary[];
  defaultProviderId: string | null;
  selectedProvider: AgentProviderSummary | null;
  form: ProviderForm;
  editing: boolean;
  /** The open dialog holds typed input: closing must ask, refreshing must not rebuild it. */
  formDirty: boolean;
  /** A control has been touched, so a validation message is worth showing. */
  touched: boolean;
  loading: boolean;
  saving: boolean;
  /** The row whose connection is being checked, or null. */
  checkingId: string | null;
  /** Any in-flight save, check or delete — including the row-level actions that
   *  never go through the form dialog. The settings modal guards its close on
   *  this: a check can take 120 s and its result must survive the dialog. */
  panelBusy: boolean;
  /** A failed list load; its retry refetches the list. */
  listError: string | null;
  /** Outcome of the last save/check/delete, with the action that repeats it. */
  feedback: ModelFeedback | null;
  deletePendingId: string | null;
  keyVisible: boolean;
  validationMessage: string | null;
  startCreate: () => void;
  startEdit: (provider: AgentProviderSummary) => void;
  cancelEdit: () => void;
  updateForm: <Key extends keyof ProviderForm>(key: Key, value: ProviderForm[Key]) => void;
  updateKind: (kind: AgentProviderKind) => void;
  toggleKeyVisible: () => void;
  save: () => Promise<void>;
  setDefault: (provider: AgentProviderSummary) => Promise<void>;
  /** Connection check straight from a list row, symmetric with the MCP rows. */
  check: (provider: AgentProviderSummary) => Promise<void>;
  requestDelete: (providerId: string) => void;
  confirmDelete: (providerId: string) => Promise<void>;
  retryList: () => Promise<void>;
};

export function useModelProviders({
  enabled = true,
  initialProviders,
  initialDefaultProviderId,
  onProvidersChanged,
  t,
}: {
  /** Demo sessions never reach the local Agent service, so nothing is fetched. */
  enabled?: boolean;
  initialProviders: AgentProviderSummary[];
  initialDefaultProviderId: string | null;
  onProvidersChanged: (snapshot: AgentProviderList) => void;
  t: Translate;
}): ModelProvidersController {
  const [providers, setProviders] = useState<AgentProviderSummary[]>(initialProviders);
  const [defaultProviderId, setDefaultProviderId] = useState<string | null>(initialDefaultProviderId);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  // Separate from the selection: "add" selects nothing yet must still open the form.
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<ProviderForm>(() => providerFormFor(null, initialDefaultProviderId));
  // Set by any form edit: a refresh that lands afterwards must keep what the user
  // has typed — including an API key entered while the provider list was still
  // loading — instead of rebuilding the form from the server snapshot.
  const [formDirty, setFormDirty] = useState(false);
  const [touched, setTouched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<ModelFeedback | null>(null);
  const [deletePendingId, setDeletePendingId] = useState<string | null>(null);
  const [keyVisible, setKeyVisible] = useState(false);
  const formDirtyRef = useRef(false);
  const editingRef = useRef(false);
  const listRequestRef = useRef(0);
  // Callbacks handed in by the host re-bind on every modal render; the ref keeps
  // the fetch helpers stable so the mount effect below runs once.
  const onProvidersChangedRef = useRef(onProvidersChanged);
  onProvidersChangedRef.current = onProvidersChanged;
  const tRef = useRef(t);
  tRef.current = t;
  const selectedProviderIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedProviderIdRef.current = selectedProviderId;
  }, [selectedProviderId]);

  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId) ?? null;

  const markDraft = useCallback((dirty: boolean) => {
    formDirtyRef.current = dirty;
    setFormDirty(dirty);
  }, []);

  /** Leaves the form; the success notice (if any) outlives it onto the card. */
  const closeDraft = useCallback((keepFeedback = false) => {
    editingRef.current = false;
    markDraft(false);
    setEditing(false);
    setTouched(false);
    setDeletePendingId(null);
    setKeyVisible(false);
    if (!keepFeedback) setFeedback(null);
  }, [markDraft]);

  const applyProviderList = useCallback((
    snapshot: AgentProviderList,
    preferredProviderId: string | null = null,
    { resetForm = false }: { resetForm?: boolean } = {},
  ) => {
    // The ref mirrors the last committed selection (see the effect above), so
    // it is the "where was the user" answer for this refresh.
    const previousSelectedId = selectedProviderIdRef.current;
    const stillExists = previousSelectedId === null || snapshot.items.some((provider) => provider.id === previousSelectedId);
    setProviders(snapshot.items);
    setDefaultProviderId(snapshot.defaultProviderId);
    onProvidersChangedRef.current(snapshot);
    // An open draft owns the dialog. Promoting another row to default, deleting
    // another row or checking another row all land here; rebuilding now would
    // silently drop what the user typed — including a new API key.
    if (editingRef.current && formDirtyRef.current && !resetForm && stillExists) {
      setDeletePendingId((current) => current !== null && snapshot.items.some((provider) => provider.id === current) ? current : null);
      return;
    }
    const selected = (preferredProviderId ? snapshot.items.find((provider) => provider.id === preferredProviderId) : undefined)
      ?? snapshot.items.find((provider) => provider.id === previousSelectedId)
      ?? snapshot.items.find((provider) => provider.id === snapshot.defaultProviderId)
      ?? snapshot.items[0]
      ?? null;
    setSelectedProviderId(selected?.id ?? null);
    // A refresh never opens the form by itself. It may close it only when the
    // edited provider is gone from the new snapshot, which would otherwise leave
    // an orphaned draft on screen.
    const keepEditing = editingRef.current && (previousSelectedId === null || selected?.id === previousSelectedId);
    editingRef.current = keepEditing;
    setEditing(keepEditing);
    setForm(providerFormFor(selected, snapshot.defaultProviderId));
    markDraft(false);
    setTouched(false);
    setDeletePendingId(null);
    setKeyVisible(false);
  }, [markDraft]);

  const refreshProviders = useCallback(async (
    preferredProviderId: string | null = null,
    options: { resetForm?: boolean } = {},
  ) => {
    // Two refreshes can overlap; only the newest may write state, or the older
    // list wins and the panel shows providers it already replaced.
    const request = ++listRequestRef.current;
    setLoading(true);
    setListError(null);
    try {
      const snapshot = await api.agentProviders();
      if (request !== listRequestRef.current) return snapshot;
      applyProviderList(snapshot, preferredProviderId, options);
      return snapshot;
    } catch (error) {
      if (request !== listRequestRef.current) return null;
      setListError(error instanceof Error ? error.message : tRef.current("agent.providers.loadFailed"));
      return null;
    } finally {
      if (request === listRequestRef.current) setLoading(false);
    }
  }, [applyProviderList]);

  useEffect(() => {
    if (!enabled) return;
    void refreshProviders();
  }, [enabled, refreshProviders]);

  const selectProvider = useCallback((provider: AgentProviderSummary | null, nextDefaultProviderId = defaultProviderId) => {
    setSelectedProviderId(provider?.id ?? null);
    editingRef.current = true;
    setEditing(true);
    markDraft(false);
    setTouched(false);
    setForm(providerFormFor(provider, nextDefaultProviderId));
    setDeletePendingId(null);
    setKeyVisible(false);
    setFeedback(null);
  }, [defaultProviderId, markDraft]);

  const updateForm = <Key extends keyof ProviderForm>(key: Key, value: ProviderForm[Key]) => {
    markDraft(true);
    setTouched(true);
    setForm((current) => ({ ...current, [key]: value }));
    setFeedback(null);
    setDeletePendingId(null);
  };

  const updateKind = (kind: AgentProviderKind) => {
    markDraft(true);
    setTouched(true);
    setForm((current) => ({
      ...current,
      kind,
      endpoint: !current.endpoint.trim() ? providerKindMetadata[kind].endpointSuggestion : current.endpoint,
      allowCloudMailContent: kind === "ollama" ? false : current.allowCloudMailContent,
    }));
    setFeedback(null);
    setDeletePendingId(null);
  };

  const validationMessage = useMemo(() => providerValidationMessage(form, t), [form, t]);

  const save = useCallback(async () => {
    if (saving || checkingId) return;
    // An untouched form is not nagged about: the message only appears once the
    // user has typed something (or tried to save anyway).
    if (validationMessage) {
      setTouched(true);
      return;
    }
    const run = async () => {
      setSaving(true);
      setFeedback(null);
      try {
        const saved = selectedProvider
          ? await api.updateAgentProvider(selectedProvider.id, providerInputFor(form))
          : await api.createAgentProvider(providerInputFor(form));
        // The key is write-only: drop it from the form so it never lingers in
        // component state after a successful save.
        setForm((current) => ({ ...current, apiKey: "", clearApiKey: false }));
        // The write landed. Everything past this point repeats only the check and
        // the list refresh — replaying the create would leave a duplicate row on
        // the server, which is exactly what a "retry" after a failed refresh used
        // to do.
        const publishSaved = () => {
          onProvidersChangedRef.current(providerListAfterSave(providers, defaultProviderId, saved, {
            isNew: !selectedProvider,
            makeDefault: form.makeDefault,
          }));
        };
        const recheck = async () => {
          try {
            const checked = await api.checkAgentProvider(saved.id);
            if (checked.health?.state === "ready" && await refreshProviders(saved.id, { resetForm: true })) {
              closeDraft(true);
              setFeedback({ kind: "success", message: tRef.current("agent.providers.checked"), retry: null });
              return;
            }
            await refreshProviders(saved.id, { resetForm: true });
            if (checked.health?.state === "ready") {
              // Verified, but the list request is what failed: say so and keep
              // the dialog up instead of closing it as if nothing happened.
              publishSaved();
              setFeedback({ kind: "error", message: tRef.current("agent.providers.refreshFailed"), retry: retryRecheck });
              return;
            }
            setFeedback({
              kind: "error",
              message: providerHealthFeedback(checked, tRef.current),
              retry: retryRecheck,
            });
          } catch (error) {
            await refreshProviders(saved.id, { resetForm: true });
            setFeedback({
              kind: "error",
              message: providerRequestFeedback(error, tRef.current("agent.providers.checkError.failed"), tRef.current),
              retry: retryRecheck,
            });
          }
        };
        const retryRecheck = async () => { setSaving(true); await recheck(); setSaving(false); };
        // The save succeeded, so the server owns this form now: rebuild it.
        await refreshProviders(saved.id, { resetForm: true });
        await recheck();
      } catch (error) {
        setFeedback({
          kind: "error",
          message: providerRequestFeedback(error, tRef.current("agent.providers.saveFailed"), tRef.current),
          retry: run,
        });
      } finally {
        setSaving(false);
      }
    };
    await run();
  }, [checkingId, closeDraft, defaultProviderId, form, providers, refreshProviders, saving, selectedProvider, validationMessage]);

  /** Quick "make this the default" straight from the list row: every other
   *  field is echoed back unchanged and the stored key is never touched. */
  const setDefault = useCallback(async (provider: AgentProviderSummary) => {
    if (saving) return;
    const run = async () => {
      setSaving(true);
      setFeedback(null);
      try {
        await api.updateAgentProvider(provider.id, {
          label: provider.label,
          kind: provider.kind,
          endpoint: provider.endpoint,
          model: provider.model,
          timeoutMs: provider.timeoutMs,
          allowCloudMailContent: provider.cloudContentConsent,
          makeDefault: true,
        });
        await refreshProviders();
        setFeedback({ kind: "success", message: tRef.current("agent.providers.saved"), retry: null });
      } catch (error) {
        setFeedback({
          kind: "error",
          message: providerRequestFeedback(error, tRef.current("agent.providers.saveFailed"), tRef.current),
          retry: run,
        });
      } finally {
        setSaving(false);
      }
    };
    await run();
  }, [refreshProviders, saving]);

  /** Row-level connection check; mirrors the MCP card so both rows behave alike. */
  const check = useCallback(async (provider: AgentProviderSummary) => {
    if (saving || checkingId) return;
    const run = async () => {
      setCheckingId(provider.id);
      setFeedback(null);
      try {
        const checked = await api.checkAgentProvider(provider.id);
        await refreshProviders();
        setFeedback(checked.health?.state === "ready"
          ? { kind: "success", message: tRef.current("agent.providers.checked"), retry: null }
          : {
            kind: "error",
            message: providerHealthFeedback(checked, tRef.current),
            retry: run,
          });
      } catch (error) {
        setFeedback({
          kind: "error",
          message: providerRequestFeedback(error, tRef.current("agent.providers.checkError.failed"), tRef.current),
          retry: run,
        });
      } finally {
        setCheckingId(null);
      }
    };
    await run();
  }, [checkingId, refreshProviders, saving]);

  // Deletion is two-step: the first click arms `deletePendingId`, the second
  // removes the provider. It is driven from the list row.
  const confirmDelete = useCallback(async (providerId: string) => {
    if (saving) return;
    const run = async () => {
      setSaving(true);
      setFeedback(null);
      try {
        await api.deleteAgentProvider(providerId);
        // Only the row being edited may tear the form down; deleting a
        // different row refreshes the list and leaves the open draft alone.
        await refreshProviders(null, { resetForm: providerId === selectedProviderIdRef.current });
        setFeedback({ kind: "success", message: tRef.current("agent.providers.deleted"), retry: null });
      } catch (error) {
        setFeedback({
          kind: "error",
          message: error instanceof Error ? error.message : tRef.current("agent.providers.deleteFailed"),
          retry: run,
        });
      } finally {
        setSaving(false);
      }
    };
    await run();
  }, [refreshProviders, saving]);

  return {
    providers,
    defaultProviderId,
    selectedProvider,
    form,
    editing,
    formDirty,
    touched,
    loading,
    saving,
    checkingId,
    panelBusy: saving || checkingId !== null,
    listError,
    feedback,
    deletePendingId,
    keyVisible,
    validationMessage,
    startCreate: () => selectProvider(null),
    startEdit: (provider: AgentProviderSummary) => selectProvider(provider),
    cancelEdit: () => closeDraft(),
    updateForm,
    updateKind,
    toggleKeyVisible: () => setKeyVisible((visible) => !visible),
    save,
    setDefault,
    check,
    requestDelete: (providerId: string) => setDeletePendingId(providerId),
    confirmDelete,
    retryList: async () => { setListError(null); await refreshProviders(selectedProviderIdRef.current); },
  };
}

export type McpServersController = {
  servers: AgentMcpServerSummary[];
  selectedServer: AgentMcpServerSummary | null;
  form: McpServerForm;
  envRows: EnvRow[];
  editing: boolean;
  formDirty: boolean;
  touched: boolean;
  loading: boolean;
  saving: boolean;
  /** The row whose connection is being checked, or null. */
  checkingId: string | null;
  /** Any in-flight save, check or delete — including the row-level actions that
   *  never go through the form dialog. The settings modal guards its close on
   *  this: a check can take 120 s and its result must survive the dialog. */
  panelBusy: boolean;
  listError: string | null;
  feedback: ModelFeedback | null;
  deletePendingId: string | null;
  validationMessage: string | null;
  startCreate: () => void;
  startEdit: (server: AgentMcpServerSummary) => void;
  cancelEdit: () => void;
  updateForm: <Key extends keyof McpServerForm>(key: Key, value: McpServerForm[Key]) => void;
  updateEnvRow: (index: number, patch: Partial<EnvRow>) => void;
  addEnvRow: () => void;
  removeEnvRow: (index: number) => void;
  save: () => Promise<void>;
  /** Pass a server to check it straight from its list row; the dialog footer
   *  calls it bare and the currently edited server is used. */
  check: (server?: AgentMcpServerSummary) => Promise<void>;
  requestDelete: (serverId: string) => void;
  confirmDelete: (serverId: string) => Promise<void>;
  retryList: () => Promise<void>;
};

export function useMcpServers({ enabled = true, t }: { enabled?: boolean; t: Translate }): McpServersController {
  const [servers, setServers] = useState<AgentMcpServerSummary[]>([]);
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<McpServerForm>(() => mcpServerFormFor(null));
  const [envRows, setEnvRows] = useState<EnvRow[]>(() => [{ id: nextEnvRowId(), key: "", value: "" }]);
  const [formDirty, setFormDirty] = useState(false);
  const [touched, setTouched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<ModelFeedback | null>(null);
  const [deletePendingId, setDeletePendingId] = useState<string | null>(null);
  const formDirtyRef = useRef(false);
  const editingRef = useRef(false);
  const listRequestRef = useRef(0);
  const tRef = useRef(t);
  tRef.current = t;
  const selectedServerIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedServerIdRef.current = selectedServerId;
  }, [selectedServerId]);

  const selectedServer = servers.find((server) => server.id === selectedServerId) ?? null;

  const markDraft = useCallback((dirty: boolean) => {
    formDirtyRef.current = dirty;
    setFormDirty(dirty);
  }, []);

  const closeDraft = useCallback((keepFeedback = false) => {
    editingRef.current = false;
    markDraft(false);
    setEditing(false);
    setTouched(false);
    setDeletePendingId(null);
    if (!keepFeedback) setFeedback(null);
  }, [markDraft]);

  const applyServerList = useCallback((
    snapshot: { items: AgentMcpServerSummary[] },
    preferredServerId: string | null = null,
    { resetForm = false }: { resetForm?: boolean } = {},
  ) => {
    // See useModelProviders: the ref is the last committed selection.
    const previousSelectedId = selectedServerIdRef.current;
    const stillExists = previousSelectedId === null || snapshot.items.some((server) => server.id === previousSelectedId);
    setServers(snapshot.items);
    // An open draft owns the dialog: a check (or delete) started from another
    // row refreshes the list only, never the form under the user's hands.
    if (editingRef.current && formDirtyRef.current && !resetForm && stillExists) {
      setDeletePendingId((current) => current !== null && snapshot.items.some((server) => server.id === current) ? current : null);
      return;
    }
    const selected = (preferredServerId ? snapshot.items.find((server) => server.id === preferredServerId) : undefined)
      ?? snapshot.items.find((server) => server.id === previousSelectedId)
      ?? snapshot.items[0]
      ?? null;
    setSelectedServerId(selected?.id ?? null);
    const keepEditing = editingRef.current && (previousSelectedId === null || selected?.id === previousSelectedId);
    editingRef.current = keepEditing;
    setEditing(keepEditing);
    setForm(mcpServerFormFor(selected));
    setEnvRows(mcpEnvRowsFor(selected));
    markDraft(false);
    setTouched(false);
    setDeletePendingId(null);
  }, [markDraft]);

  const refreshServers = useCallback(async (
    preferredServerId: string | null = null,
    options: { resetForm?: boolean } = {},
  ) => {
    const request = ++listRequestRef.current;
    setLoading(true);
    setListError(null);
    try {
      const snapshot = await api.agentMcpServers();
      if (request !== listRequestRef.current) return snapshot;
      applyServerList(snapshot, preferredServerId, options);
      return snapshot;
    } catch (error) {
      if (request !== listRequestRef.current) return null;
      setListError(error instanceof Error ? error.message : tRef.current("agent.mcpServers.loadFailed"));
      return null;
    } finally {
      if (request === listRequestRef.current) setLoading(false);
    }
  }, [applyServerList]);

  useEffect(() => {
    if (!enabled) return;
    void refreshServers();
  }, [enabled, refreshServers]);

  const selectServer = useCallback((server: AgentMcpServerSummary | null) => {
    setSelectedServerId(server?.id ?? null);
    editingRef.current = true;
    setEditing(true);
    markDraft(false);
    setTouched(false);
    setForm(mcpServerFormFor(server));
    setEnvRows(mcpEnvRowsFor(server));
    setDeletePendingId(null);
    setFeedback(null);
  }, [markDraft]);

  const updateForm = <Key extends keyof McpServerForm>(key: Key, value: McpServerForm[Key]) => {
    markDraft(true);
    setTouched(true);
    setForm((current) => ({ ...current, [key]: value }));
    setFeedback(null);
    setDeletePendingId(null);
  };

  const updateEnvRow = (index: number, patch: Partial<EnvRow>) => {
    markDraft(true);
    setTouched(true);
    setEnvRows((rows) => rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
    setFeedback(null);
    setDeletePendingId(null);
  };

  const validationMessage = useMemo(() => mcpValidationMessage(form, envRows, t), [envRows, form, t]);

  const save = useCallback(async () => {
    if (saving || checkingId) return;
    if (validationMessage) {
      setTouched(true);
      return;
    }
    const run = async () => {
      setSaving(true);
      setFeedback(null);
      try {
        const input = mcpServerInputFor(form, envRows, selectedServer?.envKeys);
        const saved = selectedServer
          ? await api.updateAgentMcpServer(selectedServer.id, input)
          : await api.createAgentMcpServer(input);
        // The write landed. Everything past this point repeats only the check and
        // the list refresh — replaying the create would leave a duplicate server
        // on disk, which is what a "retry" after a failed refresh used to do.
        const recheck = async () => {
          try {
            const checked = await api.checkAgentMcpServer(saved.id);
            const healthy = !checked.lastError;
            const refreshed = await refreshServers(saved.id, { resetForm: true });
            if (healthy && refreshed) {
              closeDraft(true);
              setFeedback({ kind: "success", message: tRef.current("agent.mcpServers.checked"), retry: null });
              return;
            }
            if (healthy) {
              // Checked, but the list request is what failed: say so and keep
              // the dialog up instead of closing it as if nothing happened.
              setFeedback({ kind: "error", message: tRef.current("agent.mcpServers.refreshFailed"), retry: retryRecheck });
              return;
            }
            setFeedback({ kind: "error", message: mcpCheckFeedback(checked, tRef.current), retry: retryRecheck });
          } catch (error) {
            await refreshServers(saved.id, { resetForm: true });
            setFeedback({
              kind: "error",
              message: mcpRequestFeedback(error, tRef.current("agent.mcpServers.checkFailed"), tRef.current),
              retry: retryRecheck,
            });
          }
        };
        const retryRecheck = async () => { setSaving(true); await recheck(); setSaving(false); };
        // The save succeeded, so the server now owns this form: rebuild it.
        await refreshServers(saved.id, { resetForm: true });
        await recheck();
      } catch (error) {
        setFeedback({
          kind: "error",
          message: mcpRequestFeedback(error, tRef.current("agent.mcpServers.saveFailed"), tRef.current),
          retry: run,
        });
      } finally {
        setSaving(false);
      }
    };
    await run();
  }, [checkingId, closeDraft, envRows, form, refreshServers, saving, selectedServer, validationMessage]);

  const check = useCallback(async (server?: AgentMcpServerSummary) => {
    const target = server ?? selectedServer;
    if (!target || saving || checkingId) return;
    const run = async () => {
      setCheckingId(target.id);
      setFeedback(null);
      try {
        const checked = await api.checkAgentMcpServer(target.id);
        await refreshServers();
        setFeedback(checked.lastError
          ? { kind: "error", message: mcpCheckFeedback(checked, tRef.current), retry: run }
          : { kind: "success", message: tRef.current("agent.mcpServers.checked"), retry: null });
      } catch (error) {
        setFeedback({
          kind: "error",
          message: mcpRequestFeedback(error, tRef.current("agent.mcpServers.checkFailed"), tRef.current),
          retry: run,
        });
      } finally {
        setCheckingId(null);
      }
    };
    await run();
  }, [checkingId, refreshServers, saving, selectedServer]);

  const confirmDelete = useCallback(async (serverId: string) => {
    if (saving || checkingId) return;
    const run = async () => {
      setSaving(true);
      setFeedback(null);
      try {
        await api.deleteAgentMcpServer(serverId);
        await refreshServers(null, { resetForm: serverId === selectedServerIdRef.current });
        setFeedback({ kind: "success", message: tRef.current("agent.mcpServers.deleted"), retry: null });
      } catch (error) {
        setFeedback({
          kind: "error",
          message: error instanceof Error ? error.message : tRef.current("agent.mcpServers.deleteFailed"),
          retry: run,
        });
      } finally {
        setSaving(false);
      }
    };
    await run();
  }, [checkingId, refreshServers, saving]);

  return {
    servers,
    selectedServer,
    form,
    envRows,
    editing,
    formDirty,
    touched,
    loading,
    saving,
    checkingId,
    panelBusy: saving || checkingId !== null,
    listError,
    feedback,
    deletePendingId,
    validationMessage,
    startCreate: () => selectServer(null),
    startEdit: (server: AgentMcpServerSummary) => selectServer(server),
    cancelEdit: () => closeDraft(),
    updateForm,
    updateEnvRow,
    addEnvRow: () => {
      markDraft(true);
      setTouched(true);
      setEnvRows((rows) => [...rows, { id: nextEnvRowId(), key: "", value: "" }]);
      // Same as editing a row: a stale save error must not outlive the edit.
      setFeedback(null);
      setDeletePendingId(null);
    },
    removeEnvRow: (index: number) => {
      markDraft(true);
      setTouched(true);
      setEnvRows((rows) => rows.filter((_, rowIndex) => rowIndex !== index));
      setFeedback(null);
      setDeletePendingId(null);
    },
    save,
    check,
    requestDelete: (serverId: string) => setDeletePendingId(serverId),
    confirmDelete,
    retryList: async () => { setListError(null); await refreshServers(selectedServerIdRef.current); },
  };
}