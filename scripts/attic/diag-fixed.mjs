const WebSocket = globalThis.WebSocket;
const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
await new Promise((r) => (ws.onopen = r));

const snap = async (label) => {
  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      const wb = document.querySelector('.window-bar');
      const wc = document.querySelector('.window-controls');
      const close = document.querySelector('.window-control-close');
      const out = {
        windowBarExists: !!wb,
        windowBarParent: wb ? (wb.parentElement ? wb.parentElement.className : 'detached') : 'none',
        controlsInWindowBar: wb && wc ? wb.contains(wc) : false,
        controlsParent: wc ? (wc.parentElement ? wc.parentElement.className : 'detached') : 'none',
        closeRect: close ? (() => { const r = close.getBoundingClientRect(); return { x: Math.round(r.x), right: Math.round(r.right), y: Math.round(r.y) }; })() : 'none',
        windowInnerW: window.innerWidth,
        mailShellClass: (document.querySelector('.mail-shell')||{}).className || 'none',
      };
      return JSON.stringify(out);
    })()`,
    returnByValue: true,
  });
  console.log(label, r.result.result.value);
};

await snap('MAIL LIST:');
await send('Runtime.evaluate', { expression: `(() => { const el = document.querySelector('.agent-launch-button'); if (el) el.click(); return 'ok'; })()`, returnByValue: true });
await new Promise(r => setTimeout(r, 1500));
await snap('AGENT:');
await send('Runtime.evaluate', { expression: `location.reload()`, returnByValue: true });
await new Promise(r => setTimeout(r, 2500));
await snap('RELOAD LIST:');
await send('Runtime.evaluate', { expression: `(() => { const el = document.querySelector('.message-item, .message-row, [data-message-id], .mail-list-item'); if (el) el.click(); return 'clicked'; })()`, returnByValue: true });
await new Promise(r => setTimeout(r, 1500));
await snap('MAIL DETAIL:');

ws.close();
