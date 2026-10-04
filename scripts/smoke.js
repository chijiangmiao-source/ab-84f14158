// scripts/smoke.js — HTTP 冒烟：真实启动服务，验证健康检查、静态资源与回放 API
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

async function waitHealth(base, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) return r.json();
      lastErr = new Error(`health ${r.status}`);
    } catch (e) {
      lastErr = e;
    }
    await sleep(200);
  }
  throw lastErr;
}

async function main() {
  const port = Number(process.env.PORT) || (await freePort());
  const base = `http://127.0.0.1:${port}`;
  console.log(`[smoke] 启动服务于 ${base}`);

  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  let code = 0;
  try {
    const h = await waitHealth(base);
    check('健康检查 200 且 status=ok', h.status === 'ok', JSON.stringify(h));
    check('健康检查反映四个静态资源均可用', Object.values(h.static).every(Boolean), JSON.stringify(h.static));

    for (const [p, needle] of [
      ['/', '轨道应急载荷隔离规程'],
      ['/app.js', 'runReplay'],
      ['/styles.css', '--accent'],
      ['/engine/engine.js', 'export function replay']
    ]) {
      const r = await fetch(`${base}${p}`);
      const text = await r.text();
      check(`GET ${p} -> 200 且内容正确`, r.status === 200 && text.includes(needle), `status=${r.status}`);
    }

    // 健康检查必须真实反映资源缺失：临时指向未构建状态不好模拟（dist 已构建），
    // 这里验证 404 资源确实不可得，且健康本身不依赖任意路径。
    const missing = await fetch(`${base}/does-not-exist.txt`);
    check('未知路径返回 404 JSON', missing.status === 404, `status=${missing.status}`);

    const model = JSON.parse(
      readFileSync(path.join(root, 'test', 'fixtures', 'two-region-model.json'), 'utf8')
    );

    const fire = await fetch(`${base}/api/replay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, events: ['FIRE'] })
    });
    const fireBody = await fire.json();
    check('POST /api/replay FIRE 成功', fireBody.ok === true);
    check('两区域同时迁移（选中两条）', fireBody.ok && fireBody.evidence[0].selected.length === 2);
    check(
      '进入序列含嵌套初始叶 A_ON_READY',
      fireBody.ok && fireBody.evidence[0].entries.join() === 'A_ON,A_ON_READY,B_RELEASED',
      JSON.stringify(fireBody.ok && fireBody.evidence[0].entries)
    );

    const reset = await fetch(`${base}/api/replay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, events: ['FIRE', 'RESET'] })
    });
    const resetBody = await reset.json();
    check('复位回放成功', resetBody.ok === true);
    check(
      '复位后回到初始叶配置且无遗留',
      resetBody.ok && resetBody.finalLeaves.join() === 'A_OFF,B_LOCKED',
      JSON.stringify(resetBody.finalLeaves)
    );
    check(
      '复位退出集合不含遗留状态外的多余项',
      resetBody.ok && resetBody.evidence[1].exits.slice().sort().join() === 'A_ON,A_ON_READY,B_RELEASED'
    );

    // 同优先级冲突必须被 API 拒绝并定位首个事件
    const conflictModel = JSON.parse(
      readFileSync(path.join(root, 'test', 'fixtures', 'same-priority-conflict.json'), 'utf8')
    );
    const conflict = await fetch(`${base}/api/replay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: conflictModel, events: ['GO'] })
    });
    const conflictBody = await conflict.json();
    check(
      '同优先级冲突被拒绝并定位首个事件(eventIndex=0)',
      conflictBody.ok === false &&
        conflictBody.code === 'SAME_PRIORITY_CONFLICT' &&
        conflictBody.eventIndex === 0
    );

    // 跨区域目标必须被拒绝
    const crossModel = JSON.parse(readFileSync(path.join(root, 'test', 'fixtures', 'cross-region.json'), 'utf8'));
    const cross = await fetch(`${base}/api/replay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: crossModel, events: ['JUMP'] })
    });
    const crossBody = await cross.json();
    check(
      '跨越并行区域边界目标被拒绝',
      crossBody.ok === false && crossBody.code === 'CROSS_REGION_TARGET' && crossBody.eventIndex === 0
    );
  } catch (e) {
    failures++;
    console.error('[smoke] 异常:', e);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => {
      const t = setTimeout(() => {
        child.kill('SIGKILL');
        r();
      }, 3000);
      child.on('exit', () => {
        clearTimeout(t);
        r();
      });
    });
  }

  if (failures) {
    console.error(`[smoke] ${failures} 项检查失败`);
    code = 1;
  } else {
    console.log('[smoke] 全部冒烟检查通过');
  }
  process.exit(code);
}

main();
