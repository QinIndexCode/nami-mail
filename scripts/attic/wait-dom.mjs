// 轮询等待 .desktop-app 出现，最长 30s
const WebSocket = globalThis.WebSocket;
const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
await new Promise((r) => (ws.onopen = r));

for (let i = 0; i < 15; i++) {
  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      const out = {};
      out.hasDesktopApp = !!document.querySelector('.desktop-app');
      out.hasWindowControl = !!document.querySelector('.window-control');
      out.bodyChildren = document.body.children.length;
      return JSON.stringify(out);
    })()`,
    returnByValue: true,
  });
  const o = JSON.parse(r.result.result.value);
  console.log('poll', i, JSON.stringify(o));
  if (o.hasWindowControl) { console.log('BUTTONS READY'); break; }
  await new Promise(r => setTimeout(r, 2000));
}
ws.close();
