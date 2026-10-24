// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The list is cursor-paged: the server hands out an opaque `nextCursor` and
// says "this was the last page" by omitting it. The behavioural half of that
// contract is pinned in mailListState.test.ts; this file pins the wiring,
// because the two ways it can be broken again are both invisible to a unit
// test of the chain alone:
//
//   - a caller reintroducing `page=N` in a list query. The server accepts and
//     ignores it, so that caller's scroll silently fetches page 1 forever —
//     no error anywhere, just a list that stops growing;
//   - a load-more gate compared against `total`, which is the non-convergent
//     gate this replaced: an arriving message raises `total` at the same
//     moment it is prepended above the loaded window, so `loaded >= total`
//     never fires and the list pages past its end forever.
//
// App.tsx is a 4 300-line module with no seam to drive a scroll through, so
// these read the source instead — the same approach MessageList.test.tsx takes
// for its virtualiser contract.

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(path.join(here, file), "utf8");

/** The body of `loadMore`, from its declaration to the line that closes it. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`const ${name} = async () => {`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const end = source.indexOf("\n  };", start);
  expect(end, `${name} not closed`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("message list paging wiring", () => {
  it("keeps the load-more gate on the server's signal", () => {
    const body = functionBody(read("App.tsx"), "loadMore");
    expect(body).toContain("canLoadMoreMessagePage");
    // The gate itself. `nextCursor === null` is the server saying the page it
    // just served was the last one; nothing about a row count appears here.
    expect(body).not.toMatch(/loadedServerMessageCount\s*>=\s*currentMessageTotal/);
    expect(body).not.toMatch(/currentMessageTotal\s*<=\s*loadedServerMessageCount/);
  });

  it("resumes a page from the cursor the last one returned", () => {
    const body = functionBody(read("App.tsx"), "loadMore");
    expect(body).toContain("cursor: messageNextCursor ?? undefined");
    expect(body).toContain("setMessageNextCursor(nextPage.nextCursor)");
    // The chain's own dedupe, so a redelivered row cannot render twice. It
    // lives in the store now, which is the one place a page meets the list.
    expect(body).toContain("store.appendPage(");
    expect(read(path.join("app", "mailStore.ts"))).toContain("appendMessageCursorChain");
  });

  it("sends no page number to the list endpoint anywhere in the renderer", () => {
    for (const file of ["App.tsx", "AgentWorkspace.tsx", "app/app-utils.ts"]) {
      const source = read(file);
      // `pageSize` is the page *length* and stays; `page` is the offset and
      // must not come back.
      const offenders = source
        .split("\n")
        .filter((line) => /[?&]page=|["'`]page["'`]\s*:|setMessagePage|messagePage\b/.test(line));
      expect(offenders, `${file} still pages by offset`).toEqual([]);
    }
  });

  it("restarts the chain from the first page on a full load", () => {
    const source = read("App.tsx");
    // A full reload re-reads the view from the head, so it must adopt the
    // cursor that page handed out rather than keeping the deep one.
    expect(source).toContain("setMessageNextCursor(firstPage.nextCursor)");
  });

  it("leaves the total in place for the counts the header shows", () => {
    // `total` still drives the header badge and "select all matching"; only the
    // load-more gate stopped trusting it. A full load hands the server's total
    // to the store, which owns the pinned-row correction that used to be
    // applied at the call site.
    expect(read("App.tsx")).toContain("store.adoptSnapshot(");
    expect(read(path.join("app", "mailStore.ts"))).toContain("nextMessageTotalForSnapshot(");
  });

  it("describes the page as the server defines it", () => {
    const contract = read("api.ts").match(/export type MessagePage = \{[^}]*\}/)?.[0] ?? "";
    expect(contract).toContain("nextCursor: string | null");
    expect(contract).toContain("pageSize: number");
    expect(contract).toContain("total: number");
    expect(contract).not.toMatch(/\bpage: number\b/);
  });
});
