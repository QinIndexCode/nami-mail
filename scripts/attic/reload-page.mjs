// 强制刷新渲染进程页面，让 Vite 重新注入最新 CSS
const WebSocket = globalThis.WebSocket;
const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
await new Promise((r) => (ws.onopen = r));

await send('Page.enable');
await send('Page.reload', { ignoreCache: true });
console.log('reloaded, waiting for CSS...');
await new Promise(r => setTimeout(r, 2500));

// 重新探测 window-bar 样式
const r = await send('Runtime.evaluate', {
  expression: `(() => {
    const el = document.querySelector('.desktop-app .window-bar');
    if (!el) return 'MISSING';
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return JSON.stringify({ region: cs.webkitAppRegion, w: Math.round(rect.width), h: Math.round(rect.height) });
  })()`,
  returnByValue: true,
});
console.log('AFTER RELOAD window-bar:', r.result.result.value);
ws.close();
