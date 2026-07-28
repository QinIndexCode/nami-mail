import {
  AGENT_PROTOCOL_VERSION,
  agentErrorCodes,
  type AgentError,
  type AgentErrorCode,
} from "@nami/agent-contracts";

export { AGENT_PROTOCOL_VERSION, agentErrorCodes };
export type { AgentError, AgentErrorCode };

const knownErrorCodes = new Set<string>(agentErrorCodes);

/**
 * Represents a stable desktop/broker failure before it is serialized into a
 * shared Agent contract envelope. Error details deliberately stay local so
 * pipe paths, key material, and runtime internals are never sent to callers.
 */
export class AgentDesktopError extends Error {
  constructor(
    public readonly code: AgentErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly suggestion?: string,
  ) {
    super(message);
    this.name = "AgentDesktopError";
  }

  toAgentError(): AgentError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.suggestion ? { suggestion: this.suggestion } : {}),
    };
  }
}

export function agentDesktopError(
  code: AgentErrorCode,
  message: string,
  retryable = false,
  suggestion?: string,
): AgentDesktopError {
  if (!knownErrorCodes.has(code)) {
    throw new Error(`Unknown NamiMail Agent error code: ${code}`);
  }
  return new AgentDesktopError(code, message, retryable, suggestion);
}

export function asAgentDesktopError(error: unknown): AgentDesktopError | undefined {
  return error instanceof AgentDesktopError ? error : undefined;
}
