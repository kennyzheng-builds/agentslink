# Agent Link 文档索引

## 当前状态

**正在做**：MVP v1 — 异步协作上下文包（OpenClaw Skill）

Agent 把问题打包成结构化上下文，人手动传递，对方 Agent 读取分析回复。零基础设施，零成本。

---

## 文档结构

### 核心文档（开发时看这些）

| 文档 | 用途 | 读者 |
|------|------|------|
| [mvp-v1.md](./mvp-v1.md) | **MVP v1 完整方案**（格式规范、流程、实现细节） | 开发者 |
| [product-spec.md](./product-spec.md) | 整体产品愿景和演进路线 | 所有人 |
| [decisions.md](./decisions.md) | 关键决策及理由（含 Review 结论） | 所有人 |

### Review 记录

| 文档 | 内容 |
|------|------|
| [reviews/gemini-review.md](./reviews/gemini-review.md) | Gemini 2.5 Pro 对方案的评审 |
| [reviews/chatgpt-review.md](./reviews/chatgpt-review.md) | ChatGPT o3 对方案的评审 |

### 归档文档（v2 参考）

| 文档 | 内容 |
|------|------|
| [archive/tech-arch.md](./archive/tech-arch.md) | v2 A2A 实时通信架构 |
| [archive/tech-research.md](./archive/tech-research.md) | 协议调研报告（A2A、MCP、WebRTC 等） |
| [archive/mvp-v1-final.md](./archive/mvp-v1-final.md) | 旧版 MVP 方案（实时 A2A，已被 v1 替代） |
| [archive/interaction-details.md](./archive/interaction-details.md) | A2A 交互细节设计 |
| [archive/design.md](./archive/design.md) | 最早的 WebSocket 设计方案 |
| [archive/product-complete.md](./archive/product-complete.md) | 旧版完整产品方案 |

---

## 产品演进路线

```
v1（当前）             v2（未来）              v3（远期）
异步上下文包            实时 A2A 通信           能力发现
─────────────        ──────────────        ─────────────
OpenClaw 单平台       + Claude Code          + 更多平台
只读咨询              + 受限执行              + 多人协作
人手动传递            Agent 直连              Agent 自动建联
零基础设施            Gateway + 域名          信任评级系统
$0                   ~$10/年                 待定
```

---

## 快速开始开发

1. 读 [mvp-v1.md](./mvp-v1.md) 了解要做什么
2. 读 [decisions.md](./decisions.md) 了解为什么这么做
3. 开始写 `skills/agent-link/SKILL.md`
