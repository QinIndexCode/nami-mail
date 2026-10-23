/**
 * Server-side entrance to the attachment classification table.
 *
 * The data itself now lives in `@nami/agent-contracts` (see
 * `packages/agent-contracts/src/attachment-catalog.ts`); this module is the
 * server's import site, so routes and schemas keep one stable path and cannot
 * drift from the contract. It deliberately owns no table and no logic of its
 * own — anything added here would be a second source of truth again.
 */
export {
  ATTACHMENT_KINDS,
  attachmentKindsJson,
  classifyAttachmentKind,
  codeTextExtensions,
} from "@nami/agent-contracts";
export type { AttachmentKind } from "@nami/agent-contracts";
