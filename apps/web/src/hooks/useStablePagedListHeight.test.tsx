// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { useStablePagedListHeight } from "./useStablePagedListHeight";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let host: HTMLDivElement;
let root: Root;

function Harness({ locked }: { locked: boolean }) {
  const { ref, style } = useStablePagedListHeight<HTMLDivElement>(locked);
  return (
    <div ref={ref} data-testid="list" style={style}>
      <div>row one</div>
      <div>row two</div>
      <div>row three</div>
    </div>
  );
}

function render(locked: boolean): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root.render(<Harness locked={locked} />);
  });
}

function listElement(): HTMLDivElement {
  const list = document.querySelector<HTMLDivElement>('[data-testid="list"]');
  if (!list) throw new Error("list element not found");
  return list;
}

afterEach(() => {
  act(() => root.unmount());
  host?.remove();
});

describe("useStablePagedListHeight", () => {
  it("leaves the list natural-sized while pagination is inactive", () => {
    render(false);
    const list = listElement();
    expect(list.style.height).toBe("");
    expect(list.style.overflowY).toBe("");
  });

  it("pins the measured height once pagination appears and keeps it across re-renders", () => {
    render(true);
    const list = listElement();
    expect(list.style.overflowY).toBe("auto");
    expect(list.style.height).not.toBe("");
    // `flex: 0 0 auto` lets the pinned height win over any `flex: 1` basis the
    // host column layout would otherwise apply to the list viewport.
    expect(list.style.flex).toBe("0 0 auto");

    // A different page (same content shape) must not resize the pinned viewport.
    const pinned = list.style.height;
    act(() => root.render(<Harness locked={true} />));
    expect(listElement().style.height).toBe(pinned);
    expect(listElement().style.overflowY).toBe("auto");
  });

  it("releases the lock when the list drops back below one page", () => {
    render(true);
    expect(listElement().style.height).not.toBe("");

    act(() => root.render(<Harness locked={false} />));
    expect(listElement().style.height).toBe("");
    expect(listElement().style.overflowY).toBe("");
  });
});
