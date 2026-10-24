// @vitest-environment jsdom
import { act, useState, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReaderAiLaunchIntent } from "../readerAiActions";
import { useAgentWorkspaceTransition, type AgentPhase } from "./useAgentWorkspaceTransition";

// The hook warms the Agent chunk while the mail layers fade; loading the real
// workspace here would drag the whole panel into a timer unit test.
vi.mock("../AgentWorkspace", () => ({ default: () => null }));

type HarnessView = {
  phase: AgentPhase;
  open: boolean;
  intent: ReaderAiLaunchIntent | null;
  api: ReturnType<typeof useAgentWorkspaceTransition> | null;
};

const SUMMARY: ReaderAiLaunchIntent = { action: "summary", prompt: "/summary", autoSend: true };
const DRAFT: ReaderAiLaunchIntent = { action: "draft", prompt: "/draft ", autoSend: false };

function Harness({
  listRef,
  demoPresentation,
  view,
}: {
  listRef: RefObject<HTMLDivElement | null>;
  demoPresentation: boolean;
  view: HarnessView;
}) {
  const [phase, setPhase] = useState<AgentPhase>("idle");
  const [open, setOpen] = useState(false);
  const [intent, setIntent] = useState<ReaderAiLaunchIntent | null>(null);
  const api = useAgentWorkspaceTransition({
    demoPresentation,
    setAgentPhase: setPhase,
    setAgentOpen: setOpen,
    setAgentLaunchIntent: setIntent,
    messageListRef: listRef,
  });
  view.phase = phase;
  view.open = open;
  view.intent = intent;
  view.api = api;
  return null;
}

let host: HTMLDivElement;
let root: Root;
let view: HarnessView;
let frames: FrameRequestCallback[];

function flushFrames() {
  act(() => {
    while (frames.length) frames.shift()!(0);
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  view = { phase: "idle", open: false, intent: null, api: null };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mount({
  demoPresentation = false,
  listRef = { current: null },
}: {
  demoPresentation?: boolean;
  listRef?: RefObject<HTMLDivElement | null>;
} = {}) {
  act(() => root.render(<Harness listRef={listRef} demoPresentation={demoPresentation} view={view} />));
}

describe("useAgentWorkspaceTransition", () => {
  // Regression: the pre-fix handler cleared the timers *before* checking the
  // phase, so a second click during the mail fade-out left the phase stranded
  // in `mail-leaving` and the workspace never mounted.
  it("retargets a second open that arrives mid-transition instead of stranding the phase", () => {
    mount();
    act(() => view.api!.openAgentWorkspace(SUMMARY));
    expect(view.phase).toBe("mail-leaving");
    expect(view.open).toBe(false);

    act(() => vi.advanceTimersByTime(100));
    expect(view.phase).toBe("mail-leaving");

    act(() => view.api!.openAgentWorkspace(DRAFT));
    expect(view.intent).toEqual(DRAFT);

    act(() => vi.advanceTimersByTime(200));
    expect(view.open).toBe(true);
    expect(view.phase).toBe("agent-entering");

    act(() => vi.advanceTimersByTime(320));
    expect(view.phase).toBe("idle");
  });

  // The symmetric guard: a close arriving after the close already started must
  // not clear the only timers that can finish it.
  it("ignores a second close without clearing the timers that finish the first", () => {
    mount();
    act(() => view.api!.openAgentWorkspace());
    act(() => vi.advanceTimersByTime(620));
    expect(view.open).toBe(true);

    act(() => view.api!.closeAgentWorkspace());
    act(() => vi.advanceTimersByTime(100));
    expect(view.phase).toBe("agent-leaving");

    act(() => view.api!.closeAgentWorkspace());
    act(() => vi.advanceTimersByTime(220));
    expect(view.open).toBe(false);
    expect(view.phase).toBe("mail-entering");

    act(() => vi.advanceTimersByTime(300));
    expect(view.phase).toBe("idle");
  });

  it("restores the mail list offset once the column is laid out again", () => {
    const list = document.createElement("div");
    list.scrollTop = 120;
    mount({ listRef: { current: list } });

    act(() => view.api!.openAgentWorkspace());
    act(() => vi.advanceTimersByTime(620));
    expect(view.open).toBe(true);

    // display:none while the workspace is open drops the virtualizer's offset.
    list.scrollTop = 0;
    act(() => view.api!.closeAgentWorkspace());
    act(() => vi.advanceTimersByTime(320));
    expect(view.phase).toBe("mail-entering");

    flushFrames();
    expect(list.scrollTop).toBe(120);
  });

  // A re-entry during the return fade happens while the column is still
  // display:none and reports scrollTop 0. That is not the user's reading
  // position: the saved offset must survive until a restore actually lands.
  it("keeps the saved offset across a re-entry that interrupts the return", () => {
    const list = document.createElement("div");
    list.scrollTop = 120;
    mount({ listRef: { current: list } });

    act(() => view.api!.openAgentWorkspace());
    act(() => vi.advanceTimersByTime(620));
    expect(view.open).toBe(true);

    list.scrollTop = 0;
    act(() => view.api!.closeAgentWorkspace());
    act(() => vi.advanceTimersByTime(320));
    expect(view.phase).toBe("mail-entering");

    // Re-open before the queued restore runs; the interrupted restore must
    // bail without discarding the saved position.
    act(() => view.api!.openAgentWorkspace());
    expect(view.phase).toBe("mail-leaving");
    flushFrames();
    expect(list.scrollTop).toBe(0);
    act(() => vi.advanceTimersByTime(620));
    expect(view.open).toBe(true);
    act(() => vi.advanceTimersByTime(320));
    expect(view.phase).toBe("idle");

    act(() => view.api!.closeAgentWorkspace());
    act(() => vi.advanceTimersByTime(320));
    flushFrames();
    expect(list.scrollTop).toBe(120);
  });

  it("never switches interfaces in the demo presentation", () => {
    mount({ demoPresentation: true });
    act(() => view.api!.openAgentWorkspace(SUMMARY));
    act(() => vi.advanceTimersByTime(2_000));
    expect(view.phase).toBe("idle");
    expect(view.open).toBe(false);
    expect(view.intent).toBeNull();
  });
});
