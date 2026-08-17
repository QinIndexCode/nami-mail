// Single source of truth for the Agent-confirmation IPC channel name, shared
// by the main-process handler (confirmation-ipc.mts) and the preload bridge
// (preload.cts). Keeping the string in one place prevents the two sides from
// drifting apart and silently breaking confirmations.
export const agentConfirmationIpcChannel = "nami:resolve-agent-confirmation";
