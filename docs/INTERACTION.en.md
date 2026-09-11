# NamiMail Interaction Conventions

[简体中文](INTERACTION.zh-CN.md)

Cross-module interaction rules. Each one exists because of a real defect that was fixed — **every rule here corresponds to a state regression or a lost input that actually happened**. Follow these when adding new interactions instead of copying whatever a neighbouring module does.

## 1. Leave multi-select when a bulk action finishes

- A bulk action that **succeeds** clears the selection and leaves multi-select; one that **fails** keeps the selection so it can be retried.
- Why: processed rows that stay selected mean the next click on any row fires a second batch.
- Where: `batchUpdateFlags` in `App.tsx` (the `applied` flag gates `exitSelectionMode()`) and `exitOnSuccess` on the predicate batch-job path.
- On partial failure, unpin the failed rows **before** the reconciling reload, or their optimistic value overrides the server's truth.

## 2. Optimistic updates: apply locally, roll back on failure

Every user-perceivable action applies locally first. Already optimistic: send, create/delete/rename conversation, withdraw a message, memory suggestions, confirmation cards, and mail flags/moves.

Deliberately **not** optimistic (waiting for the server is the meaningful part): auto-reply approval.

Rollback is mandatory — never leave the UI showing one value while the server holds another.

## 3. Cancel/stop actions react immediately

Stop, close and cancel must drop their local affordances (button, spinner, progress) at once, not after the server round-trip completes.

## 4. A server snapshot must not replace newer local state

A refresh, poll or conversation fetch can return a snapshot taken before local changes. Merge rules:

- streaming text: while a run is live keep whichever copy is further along (`keepAheadTranscript`); once it ends the server is authoritative;
- mail rows: overwrite everything except protected fields, and count pins instead of using a Set (two concurrent actions on one row must not cancel each other's protection);
- counts and badges: correct them from the same source as the rows (`applyPinnedUnseenCorrections`), or the badge jumps back;
- unread-view total: take the server number; retained read rows are reported separately in the label and must not be counted twice.

## 5. No background refresh may clear the form being edited

List refreshes, polls and save responses must never wipe a form the user is filling in — especially an API key. Rule: any edit marks the form dirty; only an explicit switch, a successful save or a delete may rebuild it.

## 6. Fetches carry an epoch, typing is debounced

- every list/detail fetch needs a request epoch, and only the newest may write state;
- search inputs are debounced before firing;
- "skip while a request is in flight" is not protection — callers (the refresh after an approval) need it to run; queue a rerun instead.

## 7. Teardown leaves nothing behind

Close, update-install and start-failure paths all clean up child processes and subscriptions; subscriptions must not be torn down and re-created just because a callback identity changed (events arriving in that gap reach nobody).
