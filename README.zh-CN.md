# dsh-worldsense

> **给 DSH Agent 一个安全、只读、受限的"现实感知层"。**
>
> WorldSense lets DeepSeek Harness safely read administrator-defined JSON APIs
> without turning the agent into an unrestricted HTTP client.

一句话：**Give AI the ability to read the world.**

```text
World → AI  = WorldSense   （本插件：Agent 感知现实）
AI → World  = Human Intent （姊妹插件：人类授权修改现实）
```

两者是镜像关系：管理员定义"世界有哪些窗口"；Agent 决定"现在看哪个窗
口"；Agent 不能自己在墙上再开一个洞。

---

## 它是什么

WorldSense 给 DeepSeek Harness（DSH）的 Agent 提供六个只读工具，用来感知
**通用结构化世界状态** —— 那些值得读取、但不值得为之写专门插件的 JSON
API：部署状态、feature flag、服务注册表、状态页、GitHub 项目统计、发布
信息、CI 状态、队列深度、库存、内部平台、云控制面只读 API、业务数字、
任何自定义 JSON API（v0.1：**仅 GET + JSON**）。

如果一个系统值得拥有专门插件（指标/仪表盘/告警 → `dsh-grafana`；日志/
搜索/trace 证据 → `dsh-searchops`），就用专门插件。如果只是想让 Agent
**安全地读一个结构化状态 API**，那就是 WorldSense 的事。

### 三个性质

- **安全（safe）**：目的地由管理员配置。Agent 永远无法指定任意 URL、主机、
  端口、协议、路径、HTTP 方法、Header 或凭证 —— 工具参数里根本没有这些
  概念，测试套件从结构上锁死了这一点。
- **受限（bounded）**：每一层都有预算 —— 响应字节数（默认 1 MiB，硬上限
  4 MiB，流式读取时强制执行）、字段数量、值长度/深度/数组长度、diff 条目
  数、历史条数。超限永远如实标注 `truncated` 及原因，绝不静默截断装完整。
- **可追溯（traceable）**：每次读取都是一个 `WorldObservation`，携带完整
  来源（provenance）：source、endpoint、GET url、observedAt、SHA-256
  contentHash。**没有来源的证据是弱证据。**

## 为什么不直接用 curl？

**为什么不能让 Agent 任意访问 URL？** 拥有任意 URL 工具的 Agent 就是一个
可以被引导到任何地方的无鉴权代理 —— 包括 localhost 管理面板、云元数据端
点、内部服务 —— 只要它读到的任何文本里被注入了指令。对 Agent 运行时来
说 SSRF 不是假设风险，而是"给模型一个 fetch 工具"的默认行为。在
WorldSense 里，Agent 只能说出 **source id** 和 **endpoint id**，目的地完
全来自管理员配置，并且每次请求都会重新校验解析出的 URL origin 与配置
origin 一致。

**为什么要 admin-defined source？** 因为信任边界必须有个家。管理员决定
墙上有哪些窗户（base URL、固定路径、白名单 query 参数、命名字段别名、认
证方式）；Agent 决定现在看哪一扇。

**为什么要 snapshot 和 provenance？** 观测可能过时、错误、残缺甚至恶意。
WorldSense 保留 source + 时间 + contentHash，`worldsense_diff` 由插件自己
计算确定性结构化 diff —— "昨天到今天什么变了"是插件算出来的，不是 LLM
用眼睛看的。**Observation ≠ Truth。**

## 六个工具（v0.1）

| 工具 | 作用 |
| --- | --- |
| `worldsense_sources` | 列出配置的 source / endpoint / 白名单参数 / 字段别名（绝不返回凭证） |
| `worldsense_status` | 探测一个 source endpoint：可达性、延迟、HTTP 状态（不返回 body） |
| `worldsense_read` | 立即观测 → 一条受限的 `WorldObservation`（不落库） |
| `worldsense_snapshot` | 立即观测 + 把脱敏结果存入本地 SQLite，返回 `snapshotId` |
| `worldsense_history` | 快照历史的受限元数据列表（source / endpoint / before / after 过滤） |
| `worldsense_diff` | 两个快照之间的确定性结构化 JSON diff |

对外部世界严格只读：HTTP 客户端**在代码结构上**只有 GET（method 是常
量，任何配置、参数、内部路径都改不了它）；重定向永不跟随；响应在流式读
取时按字节上限截停。

## 快速开始

```bash
npm install
npm test        # 118 个测试，完全离线
npm run demo    # 本地端到端演示：read → snapshot → 世界变化 → snapshot → diff
```

在 Settings → Plugins 里配置 source（也支持手写 JSON，两种形态都会被规
范化）：

```json
{
  "sources": [
    {
      "id": "github-dsh-grafana",
      "type": "http-json",
      "baseUrl": "https://api.github.com",
      "auth": { "type": "bearer", "credential": "GITHUB_TOKEN" },
      "endpoints": {
        "repository": {
          "path": "/repos/guhanfei-ai/dsh-grafana",
          "fields": {
            "stars": "/stargazers_count",
            "forks": "/forks_count",
            "issues": "/open_issues_count",
            "updatedAt": "/updated_at"
          }
        }
      }
    }
  ]
}
```

`auth.credential` 是**凭证库引用**，不是密钥本身 —— token 存在 DSH
credential store，请求时才解析、直送 Authorization 头：绝不进入工具输出、
错误信息、日志、快照或数据库。

完整 schema：[docs/SOURCE_CONFIG.md](docs/SOURCE_CONFIG.md) · 可运行示
例：[examples/](examples/)。

## 三个真实场景

### A — 部署状态

source `prod-platform`，endpoint `deployment-status` →
`service=payment-api, version=1.8.4, replicas=12, healthy=12`。Agent 可以
回答"生产 payment-api 现在是什么版本？"—— 且答案带 contentHash 和观测时
间。

### B — GitHub 现实反馈

source `github-dsh-grafana`，endpoint `repository` →
`stars / forks / issues / updatedAt`。"项目现在有什么现实世界的反馈？"
通用 JSON 适配器一把梭 —— 不写 GitHub 专用插件，不上浏览器，不做爬虫。

### C — 内部业务状态

source `business-api`，endpoint `daily-summary` →
`orders / revenue / failedPayments / activeUsers`。Agent 用同一条受限管
线观察业务现实。

## 设计哲学

```text
Connectivity ≠ Permission        Data ≠ Evidence        Evidence ≠ Truth
```

WorldSense 负责确定性工作 —— Fetch、Validate、Select、Redact、Bound、
Hash、Persist、Diff。模型负责推理 —— Understand、Reason、Explain、决定下
一步看什么。插件绝不主观判断：它报告 `readyReplicas=8,
desiredReplicas=10`，由 Agent 得出结论；它绝不调用任何额外 LLM、绝不做
AI 摘要、绝不做"AI 根因分析"。**WorldSense = deterministic perception。
LLM = reasoning。**

在更大的图景里（两个仓库刻意解耦，只是理念互补）：

```text
WorldSense 回答：  "Agent 可以观察什么？"
Human Intent 回答："Agent 可以改变什么？"
```

WorldSense **不授权任何写操作** —— 写属于 Human Intent。

## 诚实的"不保证"

- 无法保证识别出每一个密钥（脱敏是 best-effort 的键名/模式启发式，不是
  DLP 产品）。
- 不会让一个不可信 API 变得可信。
- 不能阻止恶意内容出现在被允许的数据内部（远程内容一律视为不可信数
  据）。
- 不提供完整的 prompt-injection 防护。
- 不提供分布式快照一致性（快照是本地观测，不是共识日志）。
- 不授权写操作。

详见 [docs/SECURITY.md](docs/SECURITY.md)。

## 文档

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 架构与分层
- [docs/SECURITY.md](docs/SECURITY.md) — 威胁模型与安全边界
- [docs/EVIDENCE_MODEL.md](docs/EVIDENCE_MODEL.md) — 观测、快照、哈希、diff、时效性
- [docs/SOURCE_CONFIG.md](docs/SOURCE_CONFIG.md) — source 配置完整 schema
- [examples/](examples/) — 本地演示（无需真实凭证、无需外网）

## Future ideas（明确不在 v0.1）

更多 source 适配器（HTML、GraphQL、RSS/XML、WebSocket/SSE）、路径插值
（`/repos/{owner}/{repo}`）、POST 等写动词（走 Human Intent 式审批）、跨
source 观测、World Graph、证据关联、插件互操作、Grafana/SearchOps 适配
器、浏览器、MCP 聚合、AI 摘要、Sidebar 仪表盘、向量搜索。今天这些都
不存在 —— v0.1 刻意只做深一个适配器，而不是浅做十个。

## 开发

```bash
npm run verify   # check（语法门禁）+ 全量离线测试
```

要求 Node ≥ 22.5（快照存储使用内建 `node:sqlite`，零原生依赖）。
MIT License。
