/* A small, optional tour of the shared offline client, never a second UI.
 * Only existing read/search/source controls are operated. The iframe's safe
 * entry point fixes demo=1&preview=site and forbids API connections by CSP. */
const HOLD_MS = 2600;
const INTRO_MS = 1100;
const VISIBLE_FRACTION = 0.5;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const STEPS = {
  mail: [
    { id: "overview", hold: 1800, zh: "两个邮箱里的来信，放在一起看。", en: "See mail from both accounts in one inbox." },
    { id: "search", hold: 2400, zh: "按发件人查找，不用来回切换邮箱。", en: "Find a sender without switching accounts." },
    { id: "read", hold: 3400, zh: "打开来信，直接阅读正文。", en: "Open the message and read it in place." },
  ],
  agent: [
    { id: "answer", hold: 2800, zh: "先看整理后的要点。", en: "Start with the answer and its key points." },
    { id: "citations", hold: 2200, zh: "展开来源，看看回答引用了哪些邮件。", en: "Expand the sources behind the answer." },
    { id: "source", hold: 3600, zh: "打开引用，核对原邮件。", en: "Open a source and check the original message." },
  ],
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
  const input = doc.querySelector("#mail-search");
  if (!input || input.value === value) return;
  const win = doc.defaultView;
  Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set.call(input, value);
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
}

class DemoTour {
  constructor(frame) {
    this.frame = frame;
    this.stage = frame.closest(".demo-stage");
    this.figure = this.stage.closest("figure");
    this.toggle = this.figure.querySelector("[data-demo-tour-toggle]");
    this.closeup = this.figure.querySelector("[data-demo-closeup]");
    this.caption = this.figure.querySelector(".demo-tour-caption");
    this.pointer = this.stage.querySelector(".demo-tour-pointer");
    this.cursor = this.pointer.querySelector(".demo-tour-cursor");
    this.steps = STEPS[frame.dataset.demo];
    this.motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.ready = false;
    this.playing = false;
    this.userStopped = false;
    this.finished = false;
    this.userRequested = false;
    this.closeupEnabled = true;
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
      const events = ["pointerdown", "keydown", "input", "wheel"];
      events.forEach((name) => doc.addEventListener(name, pauseInput, { capture: true, passive: name === "wheel" }));
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
      if (this.visible && !this.motion.matches) this.play(INTRO_MS);
    } else {
      this.stage.dataset.tourState = "waiting";
      delete this.stage.dataset.tourStep;
      this.stage.style.setProperty("--demo-tour-progress", "0");
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
    this.stop();
    this.playing = this.visible;
    this.stage.dataset.tourState = this.visible ? "playing" : "waiting";
    delete this.stage.dataset.tourPause;
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

  pointCursor(target, text = false) {
    this.cursorTarget = target;
    this.cursorOnText = text;
    this.updateCursor();
  }

  updateCursor() {
    const visible = this.playing && !this.motion.matches && this.stage.clientWidth >= 760 && this.cursorTarget?.isConnected;
    this.pointer.dataset.visible = String(Boolean(visible));
    if (!visible) return;
    const r = this.cursorTarget.getBoundingClientRect();
    // These are iframe coordinates. The pointer layer uses the same camera
    // transform as the iframe, so the cursor follows a zoom without drifting.
    const x = r.left + (this.cursorOnText ? Math.min(36, r.width / 2) : r.width / 2);
    const y = r.top + (this.cursorOnText ? Math.min(42, r.height / 2) : r.height / 2);
    this.cursor.style.setProperty("--demo-cursor-x", `${clamp(x, 8, this.stage.clientWidth - 30)}px`);
    this.cursor.style.setProperty("--demo-cursor-y", `${clamp(y, 8, this.stage.clientHeight - 36)}px`);
  }

  async clickTarget(element, run) {
    if (!this.playing || this.run !== run) return false;
    if (!element?.isConnected) { this.pause("unavailable"); return false; }
    this.pointCursor(element);
    if (!this.motion.matches && this.stage.clientWidth >= 760) {
      await new Promise((resolve) => window.setTimeout(resolve, 650));
    }
    if (!this.playing || this.run !== run) return false;
    this.cursor.dataset.click = "true";
    this.clickTimer = window.setTimeout(() => { this.cursor.dataset.click = "false"; }, 400);
    element.click();
    return true;
  }

  async showStep(run) {
    if (!this.playing || this.run !== run) return;
    const doc = this.frame.contentDocument;
    // Replaying may return from a source we opened. Other dialogs belong to
    // the visitor: never close a compose/settings/consent dialog for a tour.
    const sourceClose = doc.querySelector(".demo-source-card .icon-button");
    if (this.index === 0 && sourceClose) sourceClose.click();
    if (doc.querySelector('[role="dialog"]:not(.demo-source-card):not(.agent-workspace), [role="alertdialog"]')) {
      this.pause("dialog");
      return;
    }
    const step = this.steps[this.index];
    let target;
    if (this.frame.dataset.demo === "mail") {
      if (this.index === 0) {
        doc.querySelector(".reader-back")?.click();
        setSearch(doc, "");
        await this.find('.message-item[data-message-id="m1"]', run);
        target = doc.querySelector(".message-list");
      } else if (step.id === "search") {
        const search = doc.querySelector(".search-toggle");
        if (search?.getAttribute("aria-expanded") !== "true" && !await this.clickTarget(search, run)) return;
        if (!this.playing || this.run !== run) return;
        setSearch(doc, "lin@example.com");
        target = await this.find('.message-item[data-message-id="m1"]', run);
      } else {
        target = doc.querySelector(".mail-reader .mail-title");
        if (!target) {
          const row = await this.find('.message-item[data-message-id="m1"]', run);
          if (!this.playing || this.run !== run) return;
          if (!row) { this.pause("unavailable"); return; }
          if (!await this.clickTarget(row, run)) return;
          target = await this.find(".mail-reader .mail-title", run);
        }
      }
    } else if (step.id === "answer") {
      const panel = doc.querySelector(".agent-citations-sidebar");
      if (panel?.classList.contains("expanded")) panel.querySelector(".agent-citations-toggle")?.click();
      target = doc.querySelector(".agent-message.assistant");
    } else if (step.id === "citations") {
      const panel = doc.querySelector(".agent-citations-sidebar");
      if (!panel?.classList.contains("expanded") && !await this.clickTarget(panel?.querySelector(".agent-citations-toggle"), run)) return;
      target = await this.find(".agent-citations-sidebar.expanded .agent-citations-panel", run);
    } else {
      const citation = await this.find(".agent-citations-sidebar.expanded .agent-citation-card", run);
      if (!this.playing || this.run !== run) return;
      if (!citation) { this.pause("unavailable"); return; }
      if (!await this.clickTarget(citation, run)) return;
      target = await this.find(".demo-source-card", run);
    }
    if (!this.playing || this.run !== run) return;
    if (!target) { this.pause("unavailable"); return; }
    this.target = target;
    this.pointCursor(target, true);
    this.stage.dataset.tourStep = step.id;
    this.stage.style.setProperty("--demo-tour-progress", String((this.index + 1) / this.steps.length));
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
    this.frame.contentDocument.querySelector(".demo-source-card .icon-button")?.click();
    this.stage.dataset.tourState = "complete";
    this.resetCamera();
    this.render();
  }

  resetCamera() {
    this.stage.style.setProperty("--demo-tour-scale", "1");
    this.stage.style.setProperty("--demo-tour-x", "0px");
    this.stage.style.setProperty("--demo-tour-y", "0px");
    this.updateCursor();
  }

  updateCamera() {
    const width = this.stage.clientWidth;
    if (!this.playing || this.steps[this.index]?.id === "overview" || !this.closeupEnabled || this.motion.matches || width < 760 || !this.target?.isConnected) {
      this.resetCamera();
      return;
    }
    const r = this.target.getBoundingClientRect();
    if (!r.width || !r.height) { this.resetCamera(); return; }
    const height = this.stage.clientHeight;
    const scale = clamp(Math.min(width / (r.width + 96), height / (r.height + 96)), 1.08, 1.28);
    const x = clamp(width / 2 - (r.left + r.width / 2) * scale, width * (1 - scale), 0);
    const y = clamp(height / 2 - (r.top + r.height / 2) * scale, height * (1 - scale), 0);
    this.stage.style.setProperty("--demo-tour-scale", String(scale));
    this.stage.style.setProperty("--demo-tour-x", `${x}px`);
    this.stage.style.setProperty("--demo-tour-y", `${y}px`);
    this.updateCursor();
  }

  render() {
    const en = document.documentElement.dataset.lang === "en";
    const pending = !this.userStopped && !this.finished && (!this.motion.matches || this.userRequested);
    const playing = this.playing || pending;
    this.toggle.hidden = this.closeup.hidden = this.caption.hidden = !this.ready;
    this.toggle.textContent = playing ? (en ? "Pause tour" : "暂停演示") : (this.finished ? (en ? "Replay tour" : "重播演示") : (en ? "Play tour" : "播放演示"));
    this.toggle.setAttribute("aria-pressed", String(this.playing));
    this.closeup.textContent = en ? "Close-up" : "特写";
    this.closeup.disabled = this.motion.matches || this.stage.clientWidth < 760;
    this.closeup.setAttribute("aria-pressed", String(this.closeupEnabled && !this.closeup.disabled));
    const counter = this.caption.querySelector(".demo-tour-step");
    counter.textContent = this.playing ? `${String(this.index + 1).padStart(2, "0")} / ${String(this.steps.length).padStart(2, "0")}` : "";
    const step = this.steps[Math.min(this.index, this.steps.length - 1)];
    this.caption.querySelector(".demo-tour-label").textContent = this.playing ? step[en ? "en" : "zh"] : this.stage.dataset.tourPause === "dialog" ? (en ? "Close the dialog, then play the tour." : "关闭当前弹窗后，可以继续演示。") : (en ? "Click or type in the demo to try it yourself." : "点击或输入，就可以自己试试。");
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
  if (!observer) window.addEventListener("scroll", scan, { passive: true });
  window.addEventListener("resize", scan);
  document.addEventListener("visibilitychange", scan);
  window.addEventListener("pagehide", () => tours.forEach((tour) => tour.setVisible(false)));
  window.addEventListener("pageshow", scan);
  scan();
}
