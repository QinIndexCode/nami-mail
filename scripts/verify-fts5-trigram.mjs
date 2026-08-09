import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const db = new Database(":memory:");
db.pragma("journal_mode = WAL");
db.exec(
  "CREATE VIRTUAL TABLE f USING fts5(subject, from_name, from_address, body, message_id UNINDEXED, tokenize = 'trigram')",
);
const insert = db.prepare(
  "INSERT INTO f (message_id, subject, from_name, from_address, body) VALUES (?, ?, ?, ?, ?)",
);
const esc = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const count = (s) => {
  const p = `%${esc(s)}%`;
  const t0 = performance.now();
  const rows = db
    .prepare(
      "SELECT message_id FROM f WHERE subject LIKE ? ESCAPE '\\' OR from_name LIKE ? ESCAPE '\\' OR from_address LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\'",
    )
    .all(p, p, p, p);
  return { n: rows.length, ms: Math.round((performance.now() - t0) * 10) / 10 };
};
console.log("plan like:", db.prepare("EXPLAIN QUERY PLAN SELECT message_id FROM f WHERE subject LIKE 'x' OR body LIKE 'x'").all());
console.log("plan match:", db.prepare("EXPLAIN QUERY PLAN SELECT message_id FROM f WHERE f MATCH '\"x\"'").all());
const t0 = performance.now();
db.transaction(() => {
  for (let i = 0; i < 50_000; i += 1) {
    insert.run(
      `m${i}`,
      i % 97 === 0 ? "Quarterly project report" : `Subject number ${i}`,
      "Ada Lovelace",
      `ada${i}@example.test`,
      i % 101 === 0
        ? "The project review and the needle are here for Friday."
        : `Body line ${i} with some words.`,
    );
  }
})();
console.log("insert 50k ms:", Math.round(performance.now() - t0));
console.log("like 'needle'  ", count("needle"));
console.log("like 'he'      ", count("he"));
console.log("like '中文'    ", count("中文"));
console.log("match needle   ", (() => { const t = performance.now(); const r = db.prepare("SELECT message_id FROM f WHERE f MATCH ?").all('"needle"'); return { n: r.length, ms: Math.round((performance.now() - t) * 10) / 10 }; })());
db.close();
