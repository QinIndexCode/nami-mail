export { agentConfirmationIpcChannel } from "./confirmation-channel.cjs";

const agentConfirmationIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const agentConfirmationDecisions = ["approve", "reject"] as const;

export type AgentConfirmationDecision = typeof agentConfirmationDecisions[number];

export type AgentConfirmationIpcRequest = Readonly<{
  confirmationId: string;
  decision: AgentConfirmationDecision;
}>;

type RendererFrame = Readonly<{
  url: string;
}>;

export type ConfirmationIpcEvent = Readonly<{
  sender: Readonly<{
    id: number;
  }>;
  senderFrame?: unknown;
}>;

export type ConfirmationIpcWindow = Readonly<{
  webContents: Readonly<{
    id: number;
    mainFrame: unknown;
  }>;
}>;

export type AgentConfirmationResolver<TResult = unknown> = (
  confirmationId: string,
  decision: AgentConfirmationDecision,
) => TResult | Promise<TResult | undefined> | undefined;

export type AgentConfirmationIpcHandlerOptions<TResult = unknown> = Readonly<{
  getMainWindow: () => ConfirmationIpcWindow | undefined;
  isLocalAppUrl: (url: string) => boolean;
  resolve: AgentConfirmationResolver<TResult>;
}>;

function isRendererFrame(value: unknown): value is RendererFrame {
  return value !== null
    && typeof value === "object"
    && "url" in value
    && typeof value.url === "string";
}

export function normalizeAgentConfirmationIpcRequest(
  confirmationId: unknown,
  decision: unknown,
): AgentConfirmationIpcRequest | undefined {
  if (typeof confirmationId !== "string" || !agentConfirmationIdentifierPattern.test(confirmationId)) return undefined;
  if (typeof decision !== "string" || !(agentConfirmationDecisions as readonly string[]).includes(decision)) return undefined;
  return { confirmationId, decision: decision as AgentConfirmationDecision };
}

export function isCurrentConfirmationRenderer(
  event: ConfirmationIpcEvent,
  mainWindow: ConfirmationIpcWindow | undefined,
  isLocalAppUrl: (url: string) => boolean,
): boolean {
  const frame = event.senderFrame;
  return Boolean(
    mainWindow
    && event.sender.id === mainWindow.webContents.id
    && frame === mainWindow.webContents.mainFrame
    && isRendererFrame(frame)
    && isLocalAppUrl(frame.url),
  );
}

/**
 * Creates the narrow desktop-only IPC entry point for a visible Agent
 * confirmation. The handler never supplies a capability; it only delegates a
 * validated user decision after verifying the current main renderer.
 */
export function createAgentConfirmationIpcHandler<TResult = unknown>(
  options: AgentConfirmationIpcHandlerOptions<TResult>,
): (event: ConfirmationIpcEvent, confirmationId: unknown, decision: unknown) => Promise<TResult | undefined> {
  return async (event, confirmationId, decision) => {
    if (!isCurrentConfirmationRenderer(event, options.getMainWindow(), options.isLocalAppUrl)) return undefined;
    const request = normalizeAgentConfirmationIpcRequest(confirmationId, decision);
    if (!request) return undefined;
    return await options.resolve(request.confirmationId, request.decision);
  };
}
