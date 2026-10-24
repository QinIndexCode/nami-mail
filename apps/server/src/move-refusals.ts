/**
 * The wording of a refused move acceptance.
 *
 * The acceptance carries the reason and no text (`tasks/kinds/move.ts`): a task
 * row per message in five locales is not a thing, and the entries answer the
 * same reason differently -- a route throws it, the explicit batch route reports
 * one entry per id, the Agent service throws it. One mapping, so they cannot
 * drift into telling the user different stories about the same refusal.
 *
 * It lives outside `routes/` because the Agent application service reads it too;
 * a route module importing nothing from the service layer is the direction this
 * file keeps.
 */
import {
  MOVE_LOCATION_UNVERIFIED_ERROR,
  PENDING_MOVE_RECONCILIATION_ERROR,
} from "./message-storage.js";
import {
  MOVE_FOLDER_UNAVAILABLE_ERROR,
  moveTargets,
  type MessageMoveTarget,
} from "./move-destinations.js";
import type { MoveRefusalReason } from "./tasks/index.js";

/**
 * What the refused move was headed for. The named form reads its sentence from
 * the target table; the folder form has one sentence for every account, because
 * "that folder is not there" is the same news whichever path was named.
 */
export type MoveRefusalSelection = MessageMoveTarget | { folderPath: string };

export function moveRefusalMessage(reason: MoveRefusalReason, selection: MoveRefusalSelection): string {
  switch (reason) {
    case "not_found": return "Message not found.";
    case "unavailable":
      return typeof selection === "string"
        ? moveTargets[selection].unavailableMessage
        : MOVE_FOLDER_UNAVAILABLE_ERROR;
    case "reconciling": return PENDING_MOVE_RECONCILIATION_ERROR;
    case "location_unverified": return MOVE_LOCATION_UNVERIFIED_ERROR;
    // Deliberately the same sentence as `reconciling`: to the reader both mean
    // "another move owns this message, wait for the reconcile", and the
    // difference between them (who restores it) is internal. Contract §0.4 十五 W3.
    case "claimed": return PENDING_MOVE_RECONCILIATION_ERROR;
  }
}
