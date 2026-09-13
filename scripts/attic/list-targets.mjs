const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
targets.forEach((t, i) => {
  console.log(i, '|', t.type, '|', t.title, '|', t.url);
});
