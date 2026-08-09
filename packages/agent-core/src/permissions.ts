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

const accessLevelRank: Record<AgentAccessLevel, number> = {
  "read-only": 0,
  "send-confirmed": 1,
  "full-access": 2,
};

function requiredAccessLevel(mode: AgentToolDescriptor["executionMode"]): AgentAccessLevel {
  switch (mode) {
    case "read": return "read-only";
    case "draft": return "send-confirmed";
    case "write": return "send-confirmed";
    case "high-risk": return "send-confirmed";
  }
}

function deny(code: AgentError["code"], message: string, suggestion?: string): PermissionDecision {
  return { status: "denied", error: createAgentError({ code, message, suggestion }) };
}

export class PermissionEngine {
  evaluate(check: PermissionCheck): PermissionDecision {
    const { caller, tool, accountIds } = check;
    if (["cli", "mcp"].includes(caller.kind) && !tool.availableToExternal) {
      return deny("NOT_SUPPORTED", `The ${tool.name} tool is not available to external callers.`);
    }
    // External callers may run write tools only when the desktop host has
    // assigned them a level that reaches the tool (send-confirmed or above).
    // The host constructs the caller, so a paired CLI/MCP client cannot
    // self-promote; a read-only external caller is denied right below.
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

    // Full access is the explicitly-warned highest level: it runs every
    // supported operation, including sending mail and other inherently
    // high-risk work, without a per-tool prompt. The host must show a clear
    // warning before the user enables it. Every lower level still confirms
    // any operation marked confirmationPolicy "required" or high-risk.
    // Irreversible operations (tool.irreversible) are the sole exception:
    // they always ask for a visible confirmation, even under full-access.
    const requiresConfirmation =
      (caller.accessLevel !== "full-access"
        && (tool.confirmationPolicy === "required" || tool.executionMode === "high-risk"))
      || (caller.accessLevel === "full-access" && tool.irreversible === true);
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

export function createPermissionEngine(): PermissionEngine {
  return new PermissionEngine();
}
