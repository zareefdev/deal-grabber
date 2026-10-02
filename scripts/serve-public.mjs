import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const port = Number(process.env.PORT || 8899);

const types = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

// public/deals.json is the published feed, but the page runtime fetches /api/deals
// and re-renders from it. Without these stubs the runtime bails to its error state
// and a static-only audit never exercises pickSpotlight or the schema injection.
const snapshot = JSON.parse(fs.readFileSync(path.join(root, 'deals.json'), 'utf8'));

const api = {
  '/api/deals': snapshot,
  '/api/push/key': { key: '', ready: true }
};

http.createServer((req, res) => {
  const requested = decodeURIComponent(req.url.split('?')[0]);
  if (api[requested]) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(api[requested]));
  }
  let file = path.join(root, requested);
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  } catch {}
  fs.readFile(file, (err, body) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  });
}).listen(port, () => console.log(`serving public/ on http://127.0.0.1:${port}`));
