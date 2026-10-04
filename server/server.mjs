/**
 * 静态资源服务器：提供构建后的回放页面，并暴露 /health。
 * /health 依据 manifest.json 逐项核对静态资源是否可用：
 *   全部可用 → 200 { status:'ok', assets:'available' }
 *   任一缺失 → 503 { status:'error', assets:'missing', missing:[...] }
 * 环境变量：PORT（默认 8080）、WEB_ROOT（默认 ../web/dist）。
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.WEB_ROOT || path.join(here, '../web/dist'));
const PORT = Number(process.env.PORT || 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function assetStatus() {
  try {
    const manifest = JSON.parse(await readFile(path.join(ROOT, 'manifest.json'), 'utf8'));
    const missing = [];
    for (const name of manifest.files) {
      try {
        const s = await stat(path.join(ROOT, name));
        if (!s.isFile() || s.size === 0) missing.push(name);
      } catch {
        missing.push(name);
      }
    }
    return missing.length
      ? { ok: false, missing, files: manifest.files }
      : { ok: true, files: manifest.files };
  } catch {
    return { ok: false, missing: ['manifest.json'], files: [] };
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/health') {
      const s = await assetStatus();
      res.writeHead(s.ok ? 200 : 503, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        status: s.ok ? 'ok' : 'error',
        assets: s.ok ? 'available' : 'missing',
        ...(s.missing ? { missing: s.missing } : {}),
        files: s.files,
      }));
      return;
    }

    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';
    const file = path.normalize(path.join(ROOT, pathname));
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('forbidden');
      return;
    }

    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
});

server.listen(PORT, () => {
  console.log(`web 服务已启动：http://0.0.0.0:${PORT}（资源目录 ${ROOT}）`);
});
