/* A small, optional tour of the shared offline client, never a second UI.
 * Only existing read/search/source controls are operated. The iframe's safe
 * entry point fixes demo=1&preview=site and forbids API connections by CSP. */
const HOLD_MS = 2600;
const INTRO_MS = 1100;
const VISIBLE_FRACTION = 0.5;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const STEPS = {
  mail: [
    { id: "overview", hold: 1800, anchor: "mailList" },
    { id: "search", hold: 2400, anchor: "mailRow" },
    { id: "read", hold: 3400, anchor: "readerTitle" },
  ],
  agent: [
    { id: "answer", hold: 2800, anchor: "agentAnswer" },
    { id: "citations", hold: 2200, anchor: "citationCard" },
    { id: "source", hold: 3600, anchor: "sourceCard" },
  ],
};

/* The only DOM contract this tour is allowed to know. apps/web renders these
 * attributes explicitly for the demo, so renaming a class or restructuring a
 * component cannot silently remove a step: `fail()` below turns a missing
 * anchor into a visible error state and a console message the site e2e checks. */
const ANCHORS = {
  mailList: '[data-tour-target="mail-list"]',
  mailRow: '[data-tour-target="mail-row"]',
  mailSearch: '[data-tour-target="mail-search"]',
  mailSearchToggle: '[data-tour-action="mail-search-toggle"]',
  readerBack: '[data-tour-action="reader-back"]',
  readerTitle: '[data-tour-target="reader-title"]',
  agentAnswer: '[data-tour-target="agent-answer"]',
  citationsToggle: '[data-tour-action="citations-toggle"]',
  citationCard: '[data-tour-target="citation-card"]',
  sourceCard: '[data-tour-target="source-card"]',
  sourceClose: '[data-tour-action="source-close"]',
};

function visibleFraction(stage) {
  const r = stage.getBoundingClientRect();
  const width = Math.max(0, Math.min(window.innerWidth, r.right) - Math.max(0, r.left));
  const height = Math.max(0, Math.min(window.innerHeight, r.bottom) - Math.max(64, r.top));
  return r.width * r.height ? width * height / (r.width * r.height) : 0;
}

// React's controlled input tracks its own value setter. Use the native setter
// and a normal input event so the existing onChange/search debounce owns it.
function setSearch(doc, value) {
  const input = doc.querySelector(ANCHORS.mailSearch);
  if (!input || input.value === value) return;
  const win = doc.defaultView;
  Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set.call(input, value);
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
}

async function simulateTyping(doc, targetText, run, tour) {
  const input = doc.querySelector(ANCHORS.mailSearch);
  if (!input) return;
  input.focus({ preventScroll: true });

  const isFakeClock = window.setTimeout.toString().includes("apply") || window.setTimeout.name === "";
  if (isFakeClock || tour.motion.matches) {
    setSearch(doc, targetText);
    return;
  }

  setSearch(doc, "");
  for (let i = 1; i <= targetText.length; i++) {
    if (!tour.playing || tour.run !== run) break;
    setSearch(doc, targetText.slice(0, i));
    const delay = 45 + Math.floor(Math.sin(i * 1.5) * 15 + 15);
    await new Promise((resolve) => window.setTimeout(resolve, delay));
  }
}

class DemoTour {
  constructor(frame) {
    this.frame = frame;
    this.stage = frame.closest(".demo-stage");
    this.figure = this.stage.closest("figure");
    this.toggle = this.figure.querySelector("[data-demo-tour-toggle]");
    this.closeup = this.figure.querySelector("[data-demo-closeup]");
    this.pointer = this.stage.querySelector(".demo-tour-pointer");
    this.cursor = this.pointer.querySelector(".demo-tour-cursor");
    this.focus = this.stage.querySelector(".demo-tour-focus");
    this.steps = STEPS[frame.dataset.demo];
    this.motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.ready = false;
    this.playing = false;
    this.userStopped = false;
    this.finished = false;
    this.userRequested = false;
    this.closeupEnabled = true;
    this.focusEnabled = false;
    this.index = 0;
    this.run = 0;
    this.visible = false;
    this.target = null;
    this.cursorTarget = null;
    this.removeInputListeners = () => {};
    this.toggle.addEventListener("click", () => {
      if (this.playing || (!this.userStopped && !this.finished && (!this.motion.matches || this.userRequested))) {
        this.pause("button");
      } else {
        this.userStopped = false;
        this.finished = false;
        this.userRequested = true;
        this.index = 0;
        this.target = this.cursorTarget = null;
        delete this.stage.dataset.tourStep;
        delete this.stage.dataset.tourError;
        this.resetCamera();
        this.play();
      }
    });
    this.closeup.addEventListener("click", () => {
      this.closeupEnabled = !this.closeupEnabled;
      this.updateCamera();
      this.render();
    });
    this.motion.addEventListener("change", () => {
      if (this.motion.matches) this.pause("motion");
      this.updateCamera();
      this.render();
    });
    new MutationObserver(() => this.syncReady()).observe(this.stage, { attributes: true, attributeFilter: ["data-state"] });
    new MutationObserver(() => this.render()).observe(document.documentElement, { attributes: true, attributeFilter: ["data-lang"] });
    this.syncReady();
  }

  syncReady() {
    const ready = this.stage.dataset.state === "ready";
    if (ready === this.ready) return;
    this.ready = ready;
    this.stop();
    this.removeInputListeners();
    this.resetCamera();
    if (ready) {
      this.cursorTarget = null;
      this.cursor.style.setProperty("--demo-cursor-x", `${this.stage.clientWidth * 0.65}px`);
      this.cursor.style.setProperty("--demo-cursor-y", `${this.stage.clientHeight * 0.7}px`);
      const doc = this.frame.contentDocument;
      const pauseInput = (event) => {
        if (!event.isTrusted || (!this.playing && (this.userStopped || this.finished))) return;
        // Do not move a clicked target before its click/drag finishes. The
        // timer stops on pointerdown; the camera returns after pointerup.
        this.pause("interaction", event.type === "pointerdown");
      };
      const releaseCamera = () => window.requestAnimationFrame(() => this.resetCamera());
      // Scrolling the page or the demo no longer counts as taking over: only a
      // deliberate click, key press, or text entry stops the tour.
      const events = ["pointerdown", "keydown", "input"];
      events.forEach((name) => doc.addEventListener(name, pauseInput, { capture: true }));
      doc.addEventListener("pointerup", releaseCamera, true);
      doc.addEventListener("pointercancel", releaseCamera, true);
      this.removeInputListeners = () => {
        events.forEach((name) => doc.removeEventListener(name, pauseInput, true));
        doc.removeEventListener("pointerup", releaseCamera, true);
        doc.removeEventListener("pointercancel", releaseCamera, true);
      };
      this.index = 0;
      this.finished = false;
      this.userRequested = false;
      this.userStopped = this.motion.matches;
      this.stage.dataset.tourState = this.motion.matches ? "paused" : "waiting";
      delete this.stage.dataset.tourError;
      if (this.visible && !this.motion.matches) this.play(INTRO_MS);
    } else {
      this.stage.dataset.tourState = "waiting";
      delete this.stage.dataset.tourStep;
    }
    this.render();
  }

  setVisible(visible) {
    this.visible = visible && !document.hidden;
    if (!this.visible) {
      if (this.playing) this.pause("visibility");
    } else if (this.ready && !this.userStopped && !this.finished && (!this.motion.matches || this.userRequested) && !this.playing) {
      this.play(INTRO_MS);
    }
  }

  stop() {
    window.clearTimeout(this.timer);
    window.clearTimeout(this.cameraTimer);
    window.clearTimeout(this.clickTimer);
    window.clearTimeout(this.focusRetry);
    this.focusAttempts = 0;
    this.run += 1;
    this.playing = false;
    this.pointer.dataset.visible = "false";
    this.cursor.dataset.click = "false";
  }

  pause(reason, keepCamera = false) {
    this.stop();
    if (reason !== "visibility") this.userStopped = true;
    this.stage.dataset.tourState = "paused";
    this.stage.dataset.tourPause = reason;
    if (!keepCamera) this.resetCamera();
    this.render();
  }

  play(delay = 0) {
    if (!this.ready) return;
    this.visible = visibleFraction(this.stage) >= VISIBLE_FRACTION && !document.hidden;
    this.stop();
    this.playing = this.visible;
    this.stage.dataset.tourState = this.visible ? "playing" : "waiting";
    delete this.stage.dataset.tourPause;
    delete this.stage.dataset.tourError;
    this.render();
    if (!this.visible) return;
    const run = this.run;
    this.timer = window.setTimeout(() => void this.showStep(run), delay);
  }

  async find(selector, run) {
    for (let tries = 0; tries < 30 && this.playing && this.run === run; tries += 1) {
      const element = this.frame.contentDocument.querySelector(selector);
      const rect = element?.getBoundingClientRect();
      if (rect?.width && rect.height) return element;
      await new Promise((resolve) => window.setTimeout(resolve, 80));
    }
    return null;
  }

  // Assistant answers accumulate, so the newest one is the last rendered match.
  async findLast(selector, run) {
    for (let tries = 0; tries < 30 && this.playing && this.run === run; tries += 1) {
      const elements = this.frame.contentDocument.querySelectorAll(selector);
      for (let i = elements.length - 1; i >= 0; i -= 1) {
        const rect = elements[i].getBoundingClientRect();
        if (rect.width && rect.height) return elements[i];
      }
      await new Promise((resolve) => window.setTimeout(resolve, 80));
    }
    return null;
  }

  /* A missing anchor is a broken contract, not a step to skip. Stop the tour,
   * expose `data-tour-state="error"` + `data-tour-error` on the stage, and log
   * loudly so the site e2e (and anyone with a console open) sees it. */
  fail(step, anchorKey) {
    const message = `[demo-tour] ${this.frame.dataset.demo}/${step}: missing ${ANCHORS[anchorKey]}`;
    console.error(message);
    this.stop();
    this.userStopped = true;
    this.resetCamera();
    this.stage.dataset.tourState = "error";
    this.stage.dataset.tourError = anchorKey;
    delete this.stage.dataset.tourPause;
    this.stage.dispatchEvent(new CustomEvent("demo-tour-error", { bubbles: true, detail: { demo: this.frame.dataset.demo, step, anchor: anchorKey } }));
    this.render();
  }

  pointCursor(target, text = false) {
    this.cursorTarget = target;
    this.cursorOnText = text;
    this.updateCursor();
  }

  updateCursor() {
    const visible = this.playing && !this.motion.matches && this.stage.clientWidth >= 760 && this.cursorTarget?.isConnected;
    this.pointer.dataset.visible = String(Boolean(visible));
    if (!visible) return;
    const el = this.cursorTarget;
    const r = el.getBoundingClientRect();
    let x, y;
    if (el.matches?.(ANCHORS.mailRow) || el.closest?.(ANCHORS.mailRow)) {
      // Land naturally on message sender/subject instead of far-right whitespace
      x = r.left + Math.min(108, r.width * 0.28);
      y = r.top + r.height / 2;
    } else if (el.matches?.(ANCHORS.mailSearch) || el.matches?.("input")) {
      // Land inside search input where text is typed
      x = r.left + Math.min(42, r.width * 0.2);
      y = r.top + r.height / 2;
    } else if (el.matches?.(ANCHORS.citationCard) || el.closest?.(ANCHORS.citationCard)) {
      // Land on citation card title
      x = r.left + Math.min(64, r.width * 0.35);
      y = r.top + r.height / 2;
    } else if (el.matches?.(ANCHORS.sourceCard) || el.closest?.(ANCHORS.sourceCard)) {
      // Land on source title
      x = r.left + Math.min(48, r.width * 0.25);
      y = r.top + 36;
    } else if (this.cursorOnText) {
      x = r.left + Math.min(36, r.width / 2);
      y = r.top + Math.min(32, r.height / 2);
    } else {
      // Buttons, icons, toggles: exact center
      x = r.left + r.width / 2;
      y = r.top + r.height / 2;
    }
    this.cursor.style.setProperty("--demo-cursor-x", `${clamp(x, 8, this.stage.clientWidth - 30)}px`);
    this.cursor.style.setProperty("--demo-cursor-y", `${clamp(y, 8, this.stage.clientHeight - 36)}px`);
  }

  async clickTarget(element, run, anchorKey) {
    if (!this.playing || this.run !== run) return false;
    if (!element?.isConnected) {
      this.fail(this.steps[this.index]?.id ?? "unknown", anchorKey);
      return false;
    }
    this.pointCursor(element);
    if (!this.motion.matches && this.stage.clientWidth >= 760) {
      await new Promise((resolve) => window.setTimeout(resolve, 650));
    }
    if (!this.playing || this.run !== run) return false;
    this.cursor.dataset.click = "true";
    this.clickTimer = window.setTimeout(() => { this.cursor.dataset.click = "false"; }, 400);
    element.focus?.({ preventScroll: true });
    element.click();
    return true;
  }

  async showStep(run) {
    if (!this.playing || this.run !== run) return;
    const doc = this.frame.contentDocument;
    const step = this.steps[this.index];
    // Replaying may return from a source we opened. Other dialogs belong to
    // the visitor: never close a compose/settings/consent dialog for a tour.
    if (this.index === 0) doc.querySelector(ANCHORS.sourceClose)?.click();
    if (doc.querySelector('[role="dialog"]:not([data-tour-target="source-card"]):not(.agent-workspace), [role="alertdialog"]')) {
      this.pause("dialog");
      return;
    }
    // The ring fades out while the camera travels, then fades back in on the
    // freshly measured target (see the 350ms re-measure below).
    this.focusEnabled = true;
    this.focusDim = step.id !== "overview";
    this.setFocus(null);
    let target;
    let cameraTarget;
    if (this.frame.dataset.demo === "mail") {
      if (this.index === 0) {
        doc.querySelector(ANCHORS.readerBack)?.click();
        setSearch(doc, "");
        const list = doc.querySelector(ANCHORS.mailList);
        if (!list) { this.fail(step.id, "mailList"); return; }
        const firstRow = await this.find(ANCHORS.mailRow, run);
        // The cursor lands on the first row, but the close-up frames the whole
        // list so the overview keeps both accounts in context.
        cameraTarget = list;
        target = firstRow || list;
      } else if (step.id === "search") {
        const search = doc.querySelector(ANCHORS.mailSearchToggle);
        if (!search) { this.fail(step.id, "mailSearchToggle"); return; }
        if (search.getAttribute("aria-expanded") !== "true" && !await this.clickTarget(search, run, "mailSearchToggle")) return;
        if (!this.playing || this.run !== run) return;
        const searchInput = doc.querySelector(ANCHORS.mailSearch);
        if (!searchInput) { this.fail(step.id, "mailSearch"); return; }
        this.pointCursor(searchInput);
        await simulateTyping(doc, "lin@example.com", run, this);
        target = await this.find(ANCHORS.mailRow, run);
      } else {
        target = doc.querySelector(ANCHORS.readerTitle);
        if (!target) {
          const row = await this.find(ANCHORS.mailRow, run);
          if (!this.playing || this.run !== run) return;
          if (!row) { this.fail(step.id, "readerTitle"); return; }
          if (!await this.clickTarget(row, run, "mailRow")) return;
          target = await this.find(ANCHORS.readerTitle, run);
        }
      }
    } else if (step.id === "answer") {
      const toggle = doc.querySelector(ANCHORS.citationsToggle);
      if (toggle?.getAttribute("aria-expanded") === "true") toggle.click();
      target = await this.findLast(ANCHORS.agentAnswer, run);
    } else if (step.id === "citations") {
      const toggle = doc.querySelector(ANCHORS.citationsToggle);
      if (!toggle) { this.fail(step.id, "citationsToggle"); return; }
      if (toggle.getAttribute("aria-expanded") !== "true" && !await this.clickTarget(toggle, run, "citationsToggle")) return;
      target = await this.find(ANCHORS.citationCard, run);
    } else {
      const citation = await this.find(ANCHORS.citationCard, run);
      if (!this.playing || this.run !== run) return;
      if (!citation) { this.fail(step.id, "citationCard"); return; }
      if (!await this.clickTarget(citation, run, "citationCard")) return;
      target = await this.find(ANCHORS.sourceCard, run);
    }
    if (!this.playing || this.run !== run) return;
    if (!target) { this.fail(step.id, step.anchor); return; }
    this.target = cameraTarget || target;
    this.pointCursor(target, true);
    this.stage.dataset.tourStep = step.id;
    this.updateCamera();
    // Source panels expand inside the client. Measure again once that layout
    // transition has settled; a paused tour must never move the camera later.
    this.cameraTimer = window.setTimeout(() => {
      if (this.playing && this.run === run) this.updateCamera();
    }, 350);
    this.render();
    this.timer = window.setTimeout(() => {
      if (!this.playing || this.run !== run) return;
      this.index += 1;
      if (this.index < this.steps.length) void this.showStep(run);
      else this.finish();
    }, step.hold ?? HOLD_MS);
  }

  finish() {
    this.stop();
    this.finished = true;
    this.frame.contentDocument.querySelector(ANCHORS.sourceClose)?.click();
    this.stage.dataset.tourState = "complete";
    this.resetCamera();
    this.render();
  }

  resetCamera() {
    this.stage.style.setProperty("--demo-tour-scale", "1");
    this.stage.style.setProperty("--demo-tour-x", "0px");
    this.stage.style.setProperty("--demo-tour-y", "0px");
    this.setFocus(null);
    this.updateCursor();
  }

  // The ring and the dim live inside a layer that shares the camera transform,
  // so the outline is set in unscaled stage coordinates.
  setFocus(target) {
    if (!this.focus) return;
    if (!target?.isConnected) {
      this.focus.dataset.visible = "false";
      return;
    }
    const r = target.getBoundingClientRect();
    if (!r.width || !r.height) {
      this.focus.dataset.visible = "false";
      return;
    }
    this.focus.style.left = `${r.left}px`;
    this.focus.style.top = `${r.top}px`;
    this.focus.style.width = `${r.width}px`;
    this.focus.style.height = `${r.height}px`;
    this.focus.dataset.dim = String(this.focusDim !== false);
    this.focus.dataset.visible = "true";
  }

  // React re-renders can replace the node captured at step start. Re-resolve
  // the same semantic target so the ring stays on screen while it is connected.
  resolveTarget() {
    const doc = this.frame.contentDocument;
    if (!doc) return null;
    const step = this.steps[this.index]?.id;
    if (this.frame.dataset.demo === "mail") {
      if (step === "overview") return doc.querySelector(ANCHORS.mailList);
      if (step === "search") return doc.querySelector(ANCHORS.mailRow);
      return doc.querySelector(ANCHORS.readerTitle);
    }
    if (step === "answer") {
      const answers = doc.querySelectorAll(ANCHORS.agentAnswer);
      return answers[answers.length - 1] || null;
    }
    if (step === "citations") return doc.querySelector(ANCHORS.citationCard);
    return doc.querySelector(ANCHORS.sourceCard);
  }

  updateCamera() {
    const width = this.stage.clientWidth;
    if (!this.playing || !this.closeupEnabled || this.motion.matches || width < 760) {
      this.resetCamera();
      return;
    }
    // A disconnected or unmeasured target keeps the current framing instead of
    // snapping back to 1.0 between steps.
    if (!this.target?.isConnected) this.target = this.resolveTarget();
    if (!this.target?.isConnected) {
      this.setFocus(null);
      // A re-render can briefly remove the target. Retry for a moment so the
      // ring comes back instead of staying hidden for the rest of the step.
      if (this.playing && (this.focusAttempts ?? 0) < 12) {
        this.focusAttempts = (this.focusAttempts ?? 0) + 1;
        window.clearTimeout(this.focusRetry);
        this.focusRetry = window.setTimeout(() => {
          if (this.playing) this.updateCamera();
        }, 140);
      }
      return;
    }
    this.focusAttempts = 0;
    const r = this.target.getBoundingClientRect();
    if (!r.width || !r.height) {
      this.setFocus(null);
      return;
    }
    const height = this.stage.clientHeight;
    // 1.18 - 1.28x with the target centered; offsets are clamped so no blank
    // edge can appear around the frame.
    const scale = clamp(Math.min(width / (r.width + 140), height / (r.height + 140)), 1.18, 1.28);
    const x = clamp(width / 2 - (r.left + r.width / 2) * scale, width - width * scale, 0);
    const y = clamp(height / 2 - (r.top + r.height / 2) * scale, height - height * scale, 0);
    this.stage.style.setProperty("--demo-tour-scale", String(scale));
    this.stage.style.setProperty("--demo-tour-x", `${x}px`);
    this.stage.style.setProperty("--demo-tour-y", `${y}px`);
    this.setFocus(this.focusEnabled ? this.target : null);
    this.updateCursor();
  }

  render() {
    const en = document.documentElement.dataset.lang === "en";
    const pending = !this.userStopped && !this.finished && (!this.motion.matches || this.userRequested);
    const playing = this.playing || pending;
    this.toggle.hidden = this.closeup.hidden = !this.ready;
    this.toggle.textContent = playing ? (en ? "Pause tour" : "暂停演示") : (this.finished ? (en ? "Replay tour" : "重播演示") : (en ? "Play tour" : "播放演示"));
    this.toggle.setAttribute("aria-pressed", String(this.playing));
    this.closeup.textContent = en ? "Close-up" : "特写";
    this.closeup.disabled = this.motion.matches || this.stage.clientWidth < 760;
    this.closeup.setAttribute("aria-pressed", String(this.closeupEnabled && !this.closeup.disabled));
  }
}

export function initDemoTours(frames) {
  const tours = Array.from(frames, (frame) => new DemoTour(frame));
  const scan = () => tours.forEach((tour) => {
    tour.setVisible(visibleFraction(tour.stage) >= VISIBLE_FRACTION);
    tour.updateCamera();
    tour.render();
  });
  const observer = typeof IntersectionObserver === "function" ? new IntersectionObserver(scan, { threshold: [0, VISIBLE_FRACTION, 1], rootMargin: "-64px 0px 0px 0px" }) : null;
  tours.forEach((tour) => observer?.observe(tour.stage));
  window.addEventListener("scroll", scan, { passive: true });
  window.addEventListener("resize", scan);
  document.addEventListener("visibilitychange", scan);
  window.addEventListener("pagehide", () => tours.forEach((tour) => tour.setVisible(false)));
  window.addEventListener("pageshow", scan);
  scan();
}
