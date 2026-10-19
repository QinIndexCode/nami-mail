/**
 * The three write seams the Agent application service accepts from its host.
 *
 * Kept in their own module rather than in the service's option type because the
 * long "why injected" story belongs to the seam, not to the service: a host
 * that wires the service reads one type to know what it is contracting for, and
 * the service file stays about the Agent's surface.
 */
import type { AccountRecord } from "../types.js";
import type { MessageFlagsPatch } from "../message-flags.js";
import type {
  SendAcceptance,
  FlagsTaskAcceptance,
  MoveTaskAcceptance,
  MoveTaskDestination,
} from "../tasks/index.js";

export type MailWriteTaskSeams = {
  /**
   * Commits an already-prepared submission through the task layer and reports
   * its durable state.
   *
   * Injected rather than imported because the scheduler that owns the task does
   * not exist yet when this service is constructed: the runtime builds the
   * service first (the Agent needs it) and `buildApp` builds the scheduler. The
   * host that owns both closes over the scheduler once it exists. Absent in
   * embedded/test hosts that predate the task layer -- `submitPreparedMail`
   * refuses rather than falling back to an inline SMTP call, because a silent
   * fallback would put a second, uncoordinated executor back in production.
   */
  acceptPreparedSend?: (input: { account: AccountRecord; submissionId: string }) => SendAcceptance;
  /**
   * Commits a flag write through the task layer.
   *
   * Injected for the same reason as {@link acceptPreparedSend}: the service is
   * built before the scheduler it would hand the task to. Absent, the write is
   * refused rather than performed inline -- the direct `sync-flags` call is the
   * second, uncoordinated write path this seam exists to retire.
   */
  acceptFlags?: (input: { messageIds: readonly string[]; patch: MessageFlagsPatch }) => FlagsTaskAcceptance;
  /** The move half of the same seam: local-first goal plus a durable `move` task. */
  acceptMove?: (input: { messageIds: readonly string[]; destination: MoveTaskDestination }) => MoveTaskAcceptance;
};
