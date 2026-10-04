#!/bin/sh
# verify.sh — 单次验收：引擎测试 → 页面构建 → HTTP 冒烟；任一步失败即以非零退出码报告
set -eu

echo "=== [verify 1/3] 引擎测试 ==="
node --test test/

echo "=== [verify 2/3] 页面构建 ==="
node scripts/build.js

echo "=== [verify 3/3] HTTP 冒烟 ==="
node scripts/smoke.js

echo "=== [verify] 全部验收步骤通过 ==="
