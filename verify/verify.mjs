#!/usr/bin/env node
/**
 * 验收（一次性执行，以退出码报告结果）：
 *   1/3 引擎测试  node --test engine/statechart.test.mjs
 *   2/3 页面构建  node web/build.mjs（独立输出目录，含构建自检）
 *   3/3 HTTP 冒烟 等待 web 服务健康 → /health 资源可用 → 首页与其引用的全部静态资源可取
 *                 → 服务端资源清单与本地构建产物一致（确定性构建）
 * 全部通过退出码 0，否则 1。环境变量：WEB_URL（默认 http://localhost:8080）。
 */
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const WEB_URL = (process.env.WEB_URL || 'http://localhost:8080').replace(/\/+$/, '');

let failed = false;
const report = (name, ok, extra = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed = true;
};

// ---------- 1/3 引擎测试 ----------
console.log('== 1/3 引擎测试 ==');
const tests = spawnSync(process.execPath, ['--test', 'engine/statechart.test.mjs'], {
  cwd: repoRoot,
  stdio: 'inherit',
});
report('引擎测试', tests.status === 0);

// ---------- 2/3 页面构建 ----------
console.log('== 2/3 页面构建 ==');
const buildOut = '/tmp/page-dist';
const build = spawnSync(process.execPath, ['web/build.mjs', '--out', buildOut], {
  cwd: repoRoot,
  stdio: 'inherit',
});
report('页面构建', build.status === 0);

// ---------- 3/3 HTTP 冒烟 ----------
console.log(`== 3/3 HTTP 冒烟（${WEB_URL}）==`);
let health = null;
for (let i = 0; i < 60 && !health; i++) {
  try {
    const r = await fetch(`${WEB_URL}/health`);
    if (r.ok) health = await r.json();
  } catch {
    // 服务尚未就绪，重试
  }
  if (!health) await delay(500);
}
report('健康端点可用', !!health, health ? `status=${health.status} assets=${health.assets}` : '等待超时');

if (health) {
  report('健康响应反映静态资源可用', health.assets === 'available');

  const home = await fetch(`${WEB_URL}/`);
  const html = await home.text();
  report('首页可访问', home.ok && html.includes('<script'), `HTTP ${home.status}`);

  const refs = [...html.matchAll(/(?:src|href)="(\.?\/[^"]+)"/g)]
    .map((m) => (m[1].startsWith('./') ? m[1].slice(1) : m[1]));
  report('首页引用的静态资源已发现', refs.length >= 2, refs.join(', '));

  // 抓取 JS 模块图中的静态导入（引擎模块等），一并纳入冒烟
  const queue = [...refs];
  const seen = new Set();
  while (queue.length) {
    const ref = queue.shift();
    if (seen.has(ref)) continue;
    seen.add(ref);
    try {
      const r = await fetch(`${WEB_URL}${ref}`);
      const body = await r.text();
      report(`资源 ${ref}`, r.ok && body.length > 0, `HTTP ${r.status} ${body.length}B`);
      if (ref.endsWith('.js')) {
        for (const m of body.matchAll(/from\s+["']\.(\/[^"']+)["']/g)) queue.push(m[1]);
      }
    } catch (e) {
      report(`资源 ${ref}`, false, String(e));
    }
  }

  // 服务端资源清单须与本地确定性构建的产物一致
  try {
    const local = JSON.parse(await readFile(path.join(buildOut, 'manifest.json'), 'utf8'));
    const same = Array.isArray(health.files)
      && health.files.length === local.files.length
      && health.files.every((f) => local.files.includes(f));
    report('服务端资源与本地构建产物一致', same, (health.files ?? []).join(', '));
  } catch (e) {
    report('服务端资源与本地构建产物一致', false, String(e));
  }
}

console.log(failed ? '\n验收失败' : '\n验收通过');
process.exit(failed ? 1 : 0);
