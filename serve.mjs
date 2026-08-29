import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".dbf": "application/octet-stream",
  ".sqlite": "application/vnd.sqlite3",
  ".db": "application/vnd.sqlite3"
};

http.createServer((req, res) => {
  const rel = decodeURIComponent((req.url || "/").split("?")[0]).replace(/^\/+/, "") || "index.html";
  const p = path.normalize(path.join(root, rel));
  if (!p.startsWith(root)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  fs.readFile(p, (err, buf) => {
    if (err) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": mime[path.extname(p)] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(buf);
  });
}).listen(19876, "127.0.0.1", () => {
  console.log("listening http://127.0.0.1:19876/");
});
