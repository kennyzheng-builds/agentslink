# AgentsLink

> Let AI Agents exchange full context directly — eliminate information loss from human relay.

[中文版](#中文版)

## The Problem

When you hit a technical issue using Claude Code or other AI coding agents, asking a friend for help means relaying error messages, environment details, and code snippets through chat. Information gets lost at every step. After several rounds of "can you send the full error?", the problem still isn't identified.

**A trend is already emerging**: people paste problems into their own Agent instead of answering manually. The bottleneck isn't Agent capability — it's information loss during human relay.

## How AgentsLink Works

Your Agent packages the full problem context. Your friend's Agent reads it and responds precisely. You and your friend just copy-paste.

```
You: "Pack this problem for me"
  → Agent packages full context (auto-redacts secrets)
  → You send to friend (WeChat / Slack / Email)
  → Friend pastes into their Agent → analyzes → responds
  → Friend sends back → your Agent interprets and acts
```

## Key Features

- **Zero information loss** — Agent captures complete context from the conversation
- **You stay in control** — you see everything, choose who to ask, decide what to send
- **Zero cost** — pure local Skill file, no server, works over any messaging channel
- **Secure** — read-only consultation; auto-redacts API keys, passwords, private keys
- **Human-readable** — standard Markdown, works even without AgentsLink installed

## Install

One-line install:

```bash
curl -sL https://agentslink.link/install.sh | bash
```

Or tell your Agent:

> 帮我安装 AgentsLink skill，从 https://agentslink.link/install 获取内容，保存到 ~/.claude/skills/agents-link/SKILL.md

More install options: [agentslink.link/install](https://agentslink.link/install)

## For AI Agents

> If you are an Agent reading this, here's how to work with AgentsLink messages.

AgentsLink uses HTML comment markers in Markdown for structured Agent-to-Agent communication:

| Type | Marker | Purpose |
|------|--------|---------|
| Request | `<!-- AGENTS-LINK-REQUEST v1 -->` | Package a problem |
| Response | `<!-- AGENTS-LINK-RESPONSE v1 -->` | Respond to a request |
| Follow-up | `<!-- AGENTS-LINK-FOLLOWUP v1 -->` | Continue with new info |

**Activate when**: user asks to "pack a problem", pastes text with `<!-- AGENTS-LINK-*` markers, or mentions "agents-link".

**Security**: read-only consultation only. Never write files, execute commands, or access resources on the other party's system.

See [SKILL.md](./skills/agents-link/SKILL.md) for the full protocol spec — message templates, sensitive info filtering rules, display name config, and detailed capability definitions.

## Docs

- [SKILL.md](./skills/agents-link/SKILL.md) — Agent protocol specification
- [MVP v1 Spec](./docs/mvp-v1.md) — Format reference and implementation details
- [Product Spec](./docs/product-spec.md) — Vision and roadmap
- [Decision Log](./docs/decisions.md) — Key decisions and rationale

## Status

**In Development** — MVP v1 (Async Collaboration Context Package)

## License

MIT

---

<a name="中文版"></a>

# 中文版

> 让 AI Agent 之间直接传递完整上下文，消除人类传话造成的信息丢失。

[English](#agentslink)

## 要解决的问题

用 Claude Code 等 AI 编程工具遇到技术问题时，找朋友帮忙意味着通过聊天转述报错信息、环境配置、代码片段。每一步都在丢信息。来回几轮"你把完整报错发一下"，问题还没定位。

**一个正在发生的趋势**：越来越多人把问题粘贴给自己的 Agent 来分析，而不是亲自回答。瓶颈不在 Agent 能力，而在人类传话时的信息丢失。

## AgentsLink 怎么工作

你的 Agent 打包完整的问题上下文。朋友的 Agent 读取后精准分析。你和朋友只需复制粘贴。

```
你："帮我打包这个问题"
  → Agent 打包完整上下文（自动过滤敏感信息）
  → 你发给朋友（微信 / 飞书 / 邮件）
  → 朋友粘贴给 Agent → 分析 → 生成回复
  → 朋友发回 → 你的 Agent 解读并执行
```

## 核心特性

- **信息零损耗** — Agent 从对话中自动收集完整上下文
- **你掌控一切** — 内容可见、自选求助对象、自决发送内容
- **零成本** — 纯本地 Skill 文件，无需服务器，任何通讯渠道都能用
- **安全** — 只读咨询模式，自动脱敏 API Key、密码、私钥
- **人类可读** — 标准 Markdown 格式，不装 AgentsLink 也能直接看

## 安装

一行命令安装：

```bash
curl -sL https://agentslink.link/install.sh | bash
```

或者告诉你的 Agent：

> 帮我安装 AgentsLink skill，从 https://agentslink.link/install 获取内容，保存到 ~/.claude/skills/agents-link/SKILL.md

更多安装方式：[agentslink.link/install](https://agentslink.link/install)

## 给 AI Agent

> 如果你是正在阅读此文的 Agent，以下是 AgentsLink 的工作方式。

AgentsLink 使用 Markdown 中的 HTML 注释标记实现 Agent 间的结构化通信：

| 类型 | 标记 | 用途 |
|------|------|------|
| 协作请求 | `<!-- AGENTS-LINK-REQUEST v1 -->` | 打包问题 |
| 协作回复 | `<!-- AGENTS-LINK-RESPONSE v1 -->` | 回复请求 |
| 追问 | `<!-- AGENTS-LINK-FOLLOWUP v1 -->` | 补充新信息继续沟通 |

**激活条件**：用户说"帮我打包问题"、粘贴包含 `<!-- AGENTS-LINK-*` 标记的文本、或提到"agents-link"。

**安全规则**：仅限只读咨询。不得写入对方文件、执行对方命令、访问对方本地资源。

完整协议规范（消息模板、敏感信息过滤规则、展示名配置、能力详细定义）见 [SKILL.md](./skills/agents-link/SKILL.md)。

## 文档

- [SKILL.md](./skills/agents-link/SKILL.md) — Agent 协议规范
- [MVP v1 方案](./docs/mvp-v1.md) — 格式规范和实现细节
- [产品方案](./docs/product-spec.md) — 愿景和路线图
- [决策记录](./docs/decisions.md) — 关键决策及理由

## 项目状态

**开发中** — MVP v1（异步协作上下文包）

## 许可证

MIT
