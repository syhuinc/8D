// Serves the repository under /8D/, the same path GitHub Pages uses.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.PORT || 8765);
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/8D/')) { res.writeHead(404).end(); return; }
  let path = normalize(decodeURIComponent(url.pathname.slice(4)));
  if (path === '.' || path.endsWith('/')) path = join(path, 'index.html');
  if (path.startsWith('..')) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(join(root, path));
    res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(port, '127.0.0.1', () => console.log(`serving on http://127.0.0.1:${port}/8D/`));
