import type { RefObject } from "react";
import type { AgentBootstrap } from "../agentTypes";
import type { Account, AgentAccessLevel, Message } from "../types";

export type AgentWorkspaceProps = {
  accounts: Account[];
  messages: Message[];
  currentMessage?: Message;
  initialPrompt?: string;
  initialAutoSend?: boolean;
  /** A reader-launched action is about the mail in front of the user, not a
   *  continuation of the chat that was last open: start a new conversation. */
  initialNewConversation?: boolean;
  onClose: () => void;
  onOpenMessage: (messageId: string) => void;
  restoreFocusRef?: RefObject<HTMLElement | null>;
  demoMode?: boolean;
  preloadedBootstrap?: AgentBootstrap;
  /** True while an App overlay (the settings modal) covers the workspace, so the
   *  workspace's focus trap stands down and the overlay's Escape routing wins. */
  overlayOpen?: boolean;
  /** Bumped by App when the settings models panel edited the provider list. */
  providerListVersion?: number;
  /** Opens the settings models category WITHOUT closing the workspace (a live
   *  run keeps streaming behind the modal). */
  onOpenModelSettings?: () => void;
  /** Agent permission level, persisted in app settings. */
  agentAccessLevel?: AgentAccessLevel;
  /** Persists a newly selected Agent permission level. */
  onAgentAccessLevelChange?: (level: AgentAccessLevel) => void;
  /** Notified when an agent tool mutates primary mail state (flags, moves) so
   *  the mail list can refresh instead of lagging behind the conversation. */
  onMailStateChanged?: () => void;
};
