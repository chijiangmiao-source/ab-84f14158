# 轨道应急载荷隔离规程 · 并行状态图回放

由并行状态图（statechart）驱动的隔离规程引擎、浏览器回放页面，以及基于 Compose 的一次性验收服务。

## 组成

```
engine/statechart.mjs        引擎（零依赖 ES 模块，Node 与浏览器共用）
engine/statechart.test.mjs   引擎测试（node:test，18 项）
engine/example.mjs           验收示例规程：两并行区域同时迁移 + 父状态迁移复位
web/                         回放页面（index.html / app.js / styles.css）与构建脚本 build.mjs
server/server.mjs            静态资源服务器（含 /health 健康响应）
verify/verify.mjs            验收脚本：引擎测试 + 页面构建 + HTTP 冒烟
Dockerfile                   web 服务镜像（构建页面 → 运行服务器）
verify/Dockerfile            verify 验收镜像
docker-compose.yml           web + verify 两个服务
```

## 语义规则

- **模型**：至多 24 个状态、顶层之下至多 2 层嵌套、并行区域总数至多 4 个、至多 32 个外部事件。
  每个复合状态必须声明初始子状态；并行状态的子状态即区域，必须是复合状态。
- **迁移**：携带触发事件、目标状态与优先级；优先级为整数，同一源状态内唯一（不同源状态可相同）。
- **候选**：事件到达时，仅源状态处于当前配置中的迁移成为候选（即活动状态或其祖先上的迁移）。
- **退出集合**：迁移源/目标最近公共祖先（LCA，真祖先）之下的活动真后代。
- **裁决**：候选按优先级降序、文档顺序升序处理；退出集合相交的迁移不可并行——高优先级胜出，
  低优先级丢弃；**同优先级且退出集合相交 → 拒绝**。
- **拒绝**（均定位首个失败事件的下标）：
  1. `same-priority-conflict` 同优先级冲突；
  2. `crosses-parallel-region` 目标跨越并行区域边界（目标落在某并行状态的单个区域内，而源不在同一区域）；
  3. `invalid-configuration` 执行后无法形成“每区域一个活动叶”的稳定配置。
- **执行**：选中迁移先退出（文档逆序）至各自最近公共祖先，再按文档顺序进入目标及其初始后代，
  直至得到稳定配置；每步产出稳定配置、候选/选中/丢弃迁移、退出与进入序列、各区域活动叶状态。
- **确定性**：全部遍历基于文档顺序与优先级排序，重复运行产出完全一致的证据（页面与测试均做核验）。

## 本地运行

```bash
npm test          # 引擎测试
npm run build     # 页面构建 → web/dist（含构建自检）
npm start         # 启动页面服务（PORT 默认 8080，WEB_ROOT 默认 web/dist）
npm run verify    # 本地验收：引擎测试 + 页面构建 + HTTP 冒烟（需先 npm start）
```

浏览器打开 `http://localhost:8080`：录入状态/迁移/事件（或点“载入示例”），点击 **▶ 回放**
后按事件展开每步证据；页面会重复运行两次并核验证据一致。

## Compose 运行

```bash
# 启动页面（宿主端口可用 WEB_PORT 配置，默认 8080）
WEB_PORT=9090 docker compose up -d web
curl http://localhost:9090/health   # 反映静态资源可用性的健康响应

# 验收：单次服务，完成后以退出码报告结果
docker compose up verify --exit-code-from verify   # 或：docker compose run --rm verify
echo $?                                            # 0=通过，非 0=失败
```

`verify` 服务等待 `web` 健康后，实际执行：引擎测试 → 页面构建 → HTTP 冒烟
（/health 资源可用、首页及其引用的全部静态资源可取、服务端资源清单与本地确定性构建产物一致），
全部通过以退出码 0 结束，否则非 0。

## 验收示例规程

`engine/example.mjs`：并行状态 `P` 含电源、链路两个区域。事件 `ISOLATE` 同时触发
`t-power`（PowerOn→PowerCut）与 `t-link`（LinkUp→LinkDown）——退出集合不相交，并行执行；
随后事件 `RESET` 触发父状态迁移 `t-reset`（P→P），退出至最近公共祖先（根）并依文档顺序
重新进入初始后代，回到初始稳定配置。回放序列：`ISOLATE RESET`。
