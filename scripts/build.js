// scripts/build.js — 页面构建：校验语法并把静态资源与引擎拷贝到 dist，产出构建清单
import { mkdir, rm, cp, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

async function main() {
  // 1) 语法检查所有参与构建的 JS（页面构建必须真实执行）
  for (const rel of ['src/engine/engine.js', 'src/web/app.js', 'server.js']) {
    execFileSync(process.execPath, ['--check', path.join(root, rel)], { stdio: 'inherit' });
  }

  await rm(dist, { recursive: true, force: true });
  await mkdir(path.join(dist, 'engine'), { recursive: true });

  // 2) 拷贝静态资源与浏览器侧引擎
  await cp(path.join(root, 'src', 'web'), dist, { recursive: true });
  await cp(path.join(root, 'src', 'engine', 'engine.js'), path.join(dist, 'engine', 'engine.js'));

  // 3) 引擎冒烟导入，确认构建产物可被加载
  const mod = await import(pathToFileURL(path.join(dist, 'engine', 'engine.js')).href);
  if (typeof mod.replay !== 'function') throw new Error('构建产物缺少 replay 导出');

  // 4) 构建清单
  const manifest = {
    name: 'orbital-payload-isolation-console',
    builtAt: new Date().toISOString(),
    assets: ['index.html', 'app.js', 'styles.css', 'engine/engine.js']
  };
  await writeFile(path.join(dist, 'build-manifest.json'), JSON.stringify(manifest, null, 2));

  for (const a of manifest.assets) await access(path.join(dist, a), constants.R_OK);
  console.log('[build] 页面构建完成 -> dist/（', manifest.assets.join(', '), '）');
}

main().catch((e) => {
  console.error('[build] 失败:', e.message);
  process.exit(1);
});
