import {
  createAgentError,
  type AgentAccessLevel,
  type AgentError,
  type AgentToolDescriptor,
  type CallerContext,
} from "@nami/agent-contracts";

export type PermissionCheck = {
  caller: CallerContext;
  tool: AgentToolDescriptor;
  accountIds: readonly string[];
};

export type PermissionDecision =
  | { status: "allowed" }
  | { status: "confirmation_required" }
  | { status: "denied"; error: AgentError };

export type PermissionEngineOptions = {
  allowExternalWrite?: boolean;
};

const accessLevelRank: Record<AgentAccessLevel, number> = {
  "read-only": 0,
  "draft-only": 1,
  "mail-write": 2,
  "send-confirmed": 3,
  "full-access": 4,
};

function requiredAccessLevel(mode: AgentToolDescriptor["executionMode"]): AgentAccessLevel {
  switch (mode) {
    case "read": return "read-only";
    case "draft": return "draft-only";
    case "write": return "mail-write";
    case "high-risk": return "send-confirmed";
  }
}

function deny(code: AgentError["code"], message: string, suggestion?: string): PermissionDecision {
  return { status: "denied", error: createAgentError({ code, message, suggestion }) };
}

export class PermissionEngine {
  constructor(private readonly options: PermissionEngineOptions = {}) {}

  evaluate(check: PermissionCheck): PermissionDecision {
    const { caller, tool, accountIds } = check;
    if (["cli", "mcp"].includes(caller.kind) && !tool.availableToExternal) {
      return deny("NOT_SUPPORTED", `The ${tool.name} tool is not available to external callers.`);
    }
    if (["cli", "mcp"].includes(caller.kind) && tool.executionMode !== "read" && !this.options.allowExternalWrite) {
      return deny(
        "READ_ONLY",
        "External Nami Mail Agent callers are read-only by default.",
        "Use the desktop app to create a visible confirmation for a write operation.",
      );
    }
    if (accessLevelRank[caller.accessLevel] < accessLevelRank[requiredAccessLevel(tool.executionMode)]) {
      return deny("PERMISSION_DENIED", `The caller access level does not permit ${tool.name}.`);
    }
    const missingScope = tool.requiredScopes.find((scope) => !caller.scopes.includes(scope));
    if (missingScope) {
      return deny("PERMISSION_DENIED", `The caller is missing the ${missingScope} permission.`);
    }
    if (tool.accountAccess === "required" && accountIds.length === 0) {
      return deny("INVALID_ARGUMENT", `The ${tool.name} tool requires an account scope.`);
    }
    const accountScope = caller.accountScope;
    if (accountIds.length > 0 && accountScope.mode === "none") {
      return deny("SCOPE_DENIED", "The caller is not authorized to access any account.");
    }
    if (accountScope.mode === "selected" && accountIds.some((accountId) => !accountScope.accountIds.includes(accountId))) {
      return deny("SCOPE_DENIED", "The requested account is outside the caller account scope.");
    }

    const requiresConfirmation = tool.confirmationPolicy === "required" || tool.executionMode === "high-risk";
    if (!requiresConfirmation) return { status: "allowed" };
    if (!caller.interactive || !caller.canRequestConfirmation) {
      return deny(
        "CONFIRMATION_REQUIRED",
        `The ${tool.name} tool requires a visible desktop confirmation.`,
        "Open Nami Mail and approve the action in its confirmation dialog.",
      );
    }
    return { status: "confirmation_required" };
  }
}

export function createPermissionEngine(options: PermissionEngineOptions = {}): PermissionEngine {
  return new PermissionEngine(options);
}
