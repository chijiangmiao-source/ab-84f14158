// server.js — 零依赖静态服务 + 回放 API + 健康检查
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replay, validateModel } from './src/engine/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || process.env.HOST_PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

// 构建产物优先；未构建时回退到源码目录，便于本地开发
const DIST = path.join(__dirname, 'dist');
const WEB_SRC = path.join(__dirname, 'src', 'web');

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon']
]);

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// 将 URL 映射到候选静态文件（构建产物优先）；任何含父目录段的路径一律拒绝
function staticCandidates(urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return [];
  }
  const parts = rel.split(/[/\\]+/);
  if (parts.some((p) => p === '..')) return [];
  const clean = '/' + parts.filter(Boolean).join('/');
  const safe = clean === '/' ? '/index.html' : clean;
  return [
    path.join(DIST, safe),
    path.join(WEB_SRC, safe),
    safe.startsWith('/engine/') ? path.join(__dirname, 'src', safe) : null
  ].filter(Boolean);
}

async function resolveStatic(urlPath) {
  for (const c of staticCandidates(urlPath)) {
    if ((await exists(c)) && (await stat(c)).isFile()) return c;
  }
  return null;
}

// 健康检查必须真实反映静态资源是否可用
async function health() {
  const required = {
    index: await resolveStatic('/index.html'),
    app: await resolveStatic('/app.js'),
    styles: await resolveStatic('/styles.css'),
    engine: await resolveStatic('/engine/engine.js')
  };
  const checks = Object.fromEntries(Object.entries(required).map(([k, v]) => [k, Boolean(v)]));
  const ok = Object.values(checks).every(Boolean);
  return {
    status: ok ? 'ok' : 'degraded',
    port: PORT,
    static: checks,
    builtDir: await exists(DIST)
  };
}

function sendJson(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(payload);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) reject(new Error('请求体过大'));
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'local'}`);
  try {
    if (url.pathname === '/healthz' || url.pathname === '/health') {
      const h = await health();
      return sendJson(res, h.status === 'ok' ? 200 : 503, h);
    }

    if (url.pathname === '/api/validate' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const result = validateModel(body.model ?? body);
      if (!result.ok) return sendJson(res, 200, { ok: false, errors: result.errors });
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === '/api/replay' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const result = replay(body.model ?? {}, Array.isArray(body.events) ? body.events : []);
      return sendJson(res, 200, result);
    }

    if (req.method === 'GET') {
      const file = await resolveStatic(url.pathname);
      if (file) {
        res.writeHead(200, {
          'content-type': MIME.get(path.extname(file)) || 'application/octet-stream',
          'cache-control': 'no-cache'
        });
        return createReadStream(file).pipe(res);
      }
    }

    sendJson(res, 404, { ok: false, error: 'not found', path: url.pathname });
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[web] 隔离规程控制台监听 http://${HOST}:${PORT}（HOST_PORT 可配置宿主端口）`);
});

export { server, health };
