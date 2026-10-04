# 轨道应急载荷隔离规程控制台

由并行状态图（正交层级状态机）驱动的隔离规程录入与确定性回放工具。零第三方运行时依赖，仅需 Node ≥ 20。

## 功能

- **规程录入**：至多 24 个状态、两层嵌套、根区域 1–4 个（与嵌套区域合计 ≤4）、至多 32 个外部事件。
- **结构规则**：每个复合状态必须声明初始子状态；迁移携带触发事件、整数优先级（小者优先）与目标状态；源/目标留空表示根（整体复位）。
- **事件匹配**：只考虑活动状态或其祖先上的匹配迁移。
- **冲突裁决（切换前确认）**：
  - 退出集合相交的迁移不可并行；
  - 相交且同优先级 → **同优先级冲突**，拒绝；
  - 相交且不同优先级 → 高优先级选中，低优先级让出并记录原因；
  - 目标跨越并行区域边界（含根迁移指向区域内状态）→ 拒绝；
  - 事件后无法形成“每区域一个活动叶”的稳定配置 → 拒绝。
  - 拒绝一律**定位首个事件**（`eventIndex` 从 0 开始）。
- **执行序列**：选中迁移先退出至各自最近公共祖先（自迁移退出至父级并重入自身），再按**文档顺序**进入目标并沿初始后代下行，直至稳定配置。
- **回放证据**：逐步给出稳定配置、候选迁移、裁决结果、退出序列、进入序列与各区域活动顶点/活动叶。
- **确定性**：纯函数推演，重复运行产出逐字段相同的证据。

## 本地运行

```bash
npm test          # 引擎测试
npm run build     # 页面构建（语法校验 + 产物拷贝到 dist/）
PORT=8080 npm start
# 浏览器打开 http://localhost:8080
```

健康端点 `/healthz` 真实反映静态资源（index/app/styles/engine）是否可用：全部可用返回 `200 {"status":"ok"}`，缺失任一返回 `503 {"status":"degraded"}`。

## Docker Compose

```bash
# 启动浏览器页面，宿主端口可配置（默认 8080）
HOST_PORT=9090 docker compose up --build web

# 单次验收服务：实际执行引擎测试、页面构建、HTTP 冒烟，完成后以退出码报告结果
docker compose up --build verify
# 查看退出码：
#   docker inspect <container> --format '{{.State.ExitCode}}'
```

`verify` 是 `restart: "no"` 的单次服务，依次运行 `npm test`、`node scripts/build.js`、`node scripts/smoke.js`（冒烟会在容器内真实启动 `server.js` 并请求健康端点、静态资源与回放 API）。

## 验收规程（内置示例）

两个并行区域在同一事件下同时迁移，随后由父（根）状态迁移复位：

- `R_POWER`：`A_OFF →(FIRE) A_ON/A_ON_READY`（复合状态沿初始子状态下行）
- `R_LATCH`：`B_LOCKED →(FIRE) B_RELEASED`
- 根迁移：`RESET`（源=根、目标=根）退出两区域全部活动状态并重新进入初始配置，不遗留任何已退出区域的动作。

页面点击“载入验收规程”后在“回放事件序列”填入 `FIRE, RESET` 并点击“回放”。

## 目录

```
src/engine/engine.js   纯 ESM 引擎（浏览器/Node 共用）
src/web/               页面（index.html / app.js / styles.css）
server.js              静态服务 + /api/replay + /healthz
scripts/build.js       页面构建
scripts/smoke.js       HTTP 冒烟（实际拉起服务）
scripts/verify.sh      测试→构建→冒烟的单次验收编排
test/                  node:test 测试与规程夹具
```
