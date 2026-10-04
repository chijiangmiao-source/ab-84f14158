#!/usr/bin/env node
/**
 * 页面构建：把页面与其依赖的引擎模块拷贝为带内容指纹的静态资源，
 * 重写引用，输出 manifest.json，并在写出后自检（全部资源存在且非空）。
 * 用法：node web/build.mjs [--out <目录>]（默认 web/dist）
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outIdx = process.argv.indexOf('--out');
const outDir = outIdx >= 0 ? path.resolve(process.argv[outIdx + 1]) : path.join(here, 'dist');

const hash = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 8);

const engineSrc = await readFile(path.join(here, '../engine/statechart.mjs'));
const exampleSrc = await readFile(path.join(here, '../engine/example.mjs'));
const appSrc = await readFile(path.join(here, 'app.js'), 'utf8');
const cssSrc = await readFile(path.join(here, 'styles.css'));
const htmlSrc = await readFile(path.join(here, 'index.html'), 'utf8');

const engineName = `statechart.${hash(engineSrc)}.js`;
const exampleName = `example.${hash(exampleSrc)}.js`;

const appOut = appSrc
  .replaceAll('../engine/statechart.mjs', `./${engineName}`)
  .replaceAll('../engine/example.mjs', `./${exampleName}`);
if (appOut.includes('../engine/')) throw new Error('构建失败：app.js 中仍有未重写的引擎引用');

const appName = `app.${hash(appOut)}.js`;
const cssName = `styles.${hash(cssSrc)}.css`;

const htmlOut = htmlSrc
  .replaceAll('./app.js', `./${appName}`)
  .replaceAll('./styles.css', `./${cssName}`);
if (!htmlOut.includes(appName) || !htmlOut.includes(cssName)) {
  throw new Error('构建失败：index.html 资源引用重写未生效');
}

const files = {
  'index.html': Buffer.from(htmlOut, 'utf8'),
  [appName]: Buffer.from(appOut, 'utf8'),
  [cssName]: cssSrc,
  [engineName]: engineSrc,
  [exampleName]: exampleSrc,
};

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
for (const [name, content] of Object.entries(files)) {
  await writeFile(path.join(outDir, name), content);
}

const manifest = {
  files: Object.keys(files).sort(),
  sizes: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.byteLength])),
};
await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

// 自检：manifest 中每个资源都必须存在且非空
for (const name of manifest.files) {
  const s = await stat(path.join(outDir, name));
  if (!s.isFile() || s.size === 0) throw new Error(`构建自检失败：${name} 缺失或为空`);
}

console.log(`页面构建完成 → ${outDir}`);
for (const name of manifest.files) console.log(`  ${name} (${manifest.sizes[name]}B)`);
