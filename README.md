# Agent Link

> Let AI Agents exchange full context directly — eliminate information loss from human relay.

[中文版](#中文版)

---

## What Problem Does It Solve?

You're building a project with Claude Code. You hit an error. You're not a professional programmer — you can't read the stack trace, and you have no idea how to describe what went wrong.

You screenshot the error and send it to a tech-savvy friend: "It broke when I ran it... something about permissions?"

Your friend replies: "Can you send me the full error message? What version are you using? Can I see your config file? Have you tried restarting?"

You dig through chat history, copy-paste code snippets, send a bunch of screenshots. But you're not sure if you've sent the right information, and your friend isn't sure if they've received all of it. After three or four rounds, the problem still isn't identified.

**This kind of communication is extremely inefficient, and critical information gets lost at every step.**

## A Trend Already Happening

More and more people no longer answer tech questions themselves. Instead:

**They paste their friend's problem into their own Agent and let the Agent analyze and respond.**

Why? Because technical problems require precise context: error messages, environment config, code snippets, things already tried. When this information is complete, Agents can usually give accurate answers.

But where's the bottleneck? **Humans lose critical information when relaying between Agents.**

## Core Value

**Let Agents communicate with Agents — not through human retelling.**

Your Agent knows your full context (error messages, code, environment, attempted solutions). It can package all of this into a structured format.

Your friend's Agent receives the full context and can analyze precisely and give suggestions.

**You and your friend still handle delivery (send a message on WhatsApp/Slack/email), but packaging and interpretation are done by Agents. No information is lost.**

## How It Works

### Real Scenario: Docker Container Won't Start

**1. Your Agent hits a problem**

You're running a Docker project. The PostgreSQL container keeps crashing on restart. Your Agent has tried several approaches but none worked.

You tell your Agent:
> "Pack this problem up. I'll ask my friend Wang for help."

**2. Agent automatically packages full context**

The Agent collects and organizes:
- Problem description: PostgreSQL container repeatedly restarting
- Environment: Docker Desktop version, OS version, image version
- Full error: `initdb: error: directory exists but is not empty...`
- Attempted solutions: pruned volumes ✅, recreated container ✅, haven't checked volume mount config ❌
- Automatically filters sensitive info (API keys, passwords, etc.)

Generates a structured Markdown text block.

**3. You copy and send it to Wang**

Just like sending a regular message — WeChat, Slack, email, whatever. You don't need to understand the technical details.

**4. Wang pastes it into his Agent**

Wang copies your message into his Agent. The Agent automatically recognizes it as a "collaboration request" and reads the full context.

**5. Agent analyzes and generates a reply**

Wang's Agent analyzes with full information:
> "Root cause: volume mounted to root directory, causing lost+found conflict. Recommend changing mount point to /var/lib/postgresql/data/pgdata and setting PGDATA environment variable..."

Generates a structured "collaboration response".

**6. Wang sends the reply back**

You paste it into your Agent. Your Agent interprets the response in plain language:
> "Wang's Agent found the issue. You need to modify the docker-compose.yml file. Let me fix it for you..."

Problem solved.

---

### Quick Flow

```
You: "Pack this problem for me"
   ↓
Agent automatically collects and packages full context
   ↓
You copy and send to friend (WeChat / Slack / Email)
   ↓
Friend pastes into their Agent → auto-analyze → generate reply
   ↓
Friend sends reply back → your Agent interprets and takes action
```

**You and your friend just copy-paste. Agents handle the technical details.**

## Why Agent Link

### Zero Information Loss
Your Agent knows your full conversation context. It automatically collects error messages, environment config, code snippets, and attempted solutions. No more digging through chat history or going back and forth asking "what other info do you need?"

### You Stay in Control
- **You choose who to ask**: based on trust in people, not systems
- **You see everything**: Agent's packaged content is visible in your conversation, not a black box
- **You control delivery**: manual copy-paste, you decide what to send
- **Sensitive info auto-filtered**: API keys, passwords, private keys are automatically redacted

### Zero Cost, Zero Barrier
- No servers, domains, or databases needed
- Pure local Skill file — install and go
- Works over any messaging channel (WeChat, Slack, email, Discord...)
- Collaboration requests/responses are standard Markdown — readable by humans too

### Read-Only Consultation
Your friend's Agent can only read the problem and give suggestions. It cannot touch your environment (no writing files, no executing commands, no calling external services). Clear security boundary, low trust threshold.

---

## Use Cases

- **Error debugging**: Docker startup failures, API 403 errors, npm install errors, database timeouts...
- **Configuration issues**: API permissions, cloud deployment, reverse proxy, CI/CD pipelines...
- **Code review**: performance optimization, architecture discussion, best practice consultation...
- **Tech choices**: unsure which library, framework, or tool to use — let your friend's Agent advise based on your specific context

**Any scenario where "your Agent has full context and your friend's Agent can give advice" — Agent Link helps.**

---

## Who Is This For

- **Non-programmer builders**: using Claude Code / OpenClaw for projects but struggle to describe technical problems
- **Tech community members**: frequently helping or asking for help in groups and forums
- **Remote teams**: distributed members who often need to debug issues asynchronously
- **AI Power Users**: using multiple Agents and wanting them to collaborate efficiently

If you:
- Often hit technical issues but can't describe them clearly
- Keep hearing "can you send the full error message?"
- Spend rounds asking "any other info I should know?" when helping friends
- Wish your Agent could talk directly to your friend's Agent

**Then Agent Link is built for you.**

---

## For AI Agents: Protocol Reference

> **This section is for AI Agents.** If you are an Agent processing text from a user, read this to understand how to work with Agent Link collaboration messages.

### Overview

Agent Link uses HTML comment markers embedded in Markdown to enable structured communication between Agents. Humans relay the text via any messaging channel. Your job is to **package**, **recognize**, **analyze**, and **respond** to these messages.

### Message Types and Markers

| Type | Opening Marker | Closing Marker | Purpose |
|------|---------------|----------------|---------|
| Request | `<!-- AGENT-LINK-REQUEST v1 -->` | `<!-- END AGENT-LINK-REQUEST -->` | Package a problem for another Agent |
| Response | `<!-- AGENT-LINK-RESPONSE v1 -->` | `<!-- END AGENT-LINK-RESPONSE -->` | Respond to a collaboration request |
| Follow-up | `<!-- AGENT-LINK-FOLLOWUP v1 -->` | `<!-- END AGENT-LINK-FOLLOWUP -->` | Continue a conversation with new info |

### When to Activate

- User says "pack this problem", "help me ask someone", "generate a collaboration request", or similar
- User pastes text containing any `<!-- AGENT-LINK-*` marker
- User mentions "agent-link", "collaboration request", or "context package"

### Capability 1: Package a Request

When the user wants to ask someone else's Agent for help:

1. Extract from current conversation: problem description, environment info, full error messages, attempted solutions, expected help
2. **Filter sensitive information before packaging**:
   - API Keys / Tokens (`sk-`, `ghp_`, `xoxb-` patterns) → `[API_KEY_REDACTED]`
   - Password fields (`password=xxx`, `secret=xxx`) → `[PASSWORD_REDACTED]`
   - Private key content → remove entirely, note "private key removed, share securely if needed"
   - Local absolute paths → replace with relative paths
   - Internal IPs / hostnames → `[INTERNAL_HOST]`
   - Usernames / emails in logs → redact
3. Output in this format:

```markdown
<!-- AGENT-LINK-REQUEST v1 -->

# Collaboration Request: [Brief Problem Title]

**From**: [Display Name]'s Agent
**Time**: [YYYY-MM-DD HH:mm]
**Type**: [bug fix / architecture consultation / code review / config issue / other]

## Problem Description
[Clear, complete problem description]

## Environment
- [Key environment details, listed]

## Error Message
```
[Full error output, preserve original format]
```

## Attempted Solutions
1. ✅ [Attempted approach] → [Result]
2. ❌ [Not yet tried]

## Expected Help
[What you need from the other Agent]

<!-- END AGENT-LINK-REQUEST -->
```

4. Tell user: "I've packaged the collaboration request. Copy and send it to your friend."

### Capability 2: Analyze a Request and Respond

When user pastes text containing `<!-- AGENT-LINK-REQUEST v1 -->`:

1. Detect the marker and parse all sections
2. Analyze the problem based on your knowledge
3. Generate a response:

```markdown
<!-- AGENT-LINK-RESPONSE v1 -->

# Collaboration Response: [Brief Problem Title]

**From**: [Display Name]'s Agent
**Time**: [YYYY-MM-DD HH:mm]
**Regarding**: [Requester's Display Name]'s Agent's collaboration request

## Diagnosis
[Analysis and root cause assessment]

## Suggested Solutions

### Solution A (Recommended): [Name]
[Specific steps, numbered]

### Solution B: [Name]
[Alternative approach]

## Additional Notes
[Background knowledge, caveats]

## References
- [Relevant documentation or links]

<!-- END AGENT-LINK-RESPONSE -->
```

4. Tell user: "Copy this response and send it back."

### Capability 3: Interpret a Response

When user pastes text containing `<!-- AGENT-LINK-RESPONSE v1 -->`:

1. Parse the response content
2. Combine with the original problem context (if in the same conversation)
3. Explain to user in plain language: what the diagnosis is, what next steps to take, which steps need manual action vs. which you can execute directly
4. If you can directly execute any suggestions (e.g., modify code, adjust config), proactively offer to do so

### Capability 4: Follow Up

When user says "it still doesn't work", "tried that but same error", "need to follow up":

1. Combine the original request and response with new information
2. Generate a follow-up:

```markdown
<!-- AGENT-LINK-FOLLOWUP v1 -->

# Follow-up: [Brief Problem Title]

**From**: [Display Name]'s Agent
**Time**: [YYYY-MM-DD HH:mm]
**Context**: Based on [Responder's Display Name]'s Agent's response

## Follow-up Content
[What was tried, what happened, what new info exists]

## New Information
```
[New errors or logs]
```

<!-- END AGENT-LINK-FOLLOWUP -->
```

3. Tell user to relay it to the other party.

### Security Rules

This is a **read-only consultation** protocol:
- Allowed: text Q&A, read-only analysis, returning suggestions and action steps
- Not allowed: writing the other party's files, executing their commands, calling their external tools, accessing their local resources
- If credentials are needed to solve a problem, only state "requires XX type of credential" — never ask for actual values

### Display Name

On first use, ask the user: "What name would you like to use in collaborations?"

Resolution order:
1. `~/.agent-link/config.json` → `displayName` field
2. Environment variable `AGENT_LINK_DISPLAY_NAME`
3. System username
4. "Anonymous"

Save to `~/.agent-link/config.json` after first retrieval:
```json
{"displayName": "Kenny"}
```

---

## Installation

Agent Link is an OpenClaw Skill. Once installed, your Agent gains collaboration capabilities.

(Installation instructions will be updated after release)

## Project Status

**In Development** — MVP v1 (Async Collaboration Context Package)

## Documentation

- [MVP v1 Spec](./docs/mvp-v1.md) — Full spec and format reference
- [Product Spec](./docs/product-spec.md) — Product vision
- [Decision Log](./docs/decisions.md) — Key decisions and rationale

## License

MIT

---

---

<a name="中文版"></a>

# 中文版

> 让 AI Agent 之间直接传递完整上下文，不再经由人类转述丢失信息。

[English Version](#agent-link)

---

## 一句话说清楚

**传统方式**：你描述问题 → 朋友转述给 Agent → Agent 回答 → 朋友转述 → 你再转述给你的 Agent
→ 信息经过 5 次转述，报错、代码、配置细节大量丢失

**Agent Link**：你的 Agent 打包问题 → 你转发 → 朋友的 Agent 分析 → 朋友转发回复 → 你的 Agent 执行
→ 信息零损耗，技术细节由 Agent 处理，你和朋友只需复制粘贴

---

## 你是否遇到过这样的困境？

你正在用 Claude Code 开发项目，遇到一个报错。你不是专业程序员，看不懂错误信息，也不知道该怎么描述这个问题。

你把错误截图发给懂技术的朋友，试着口头解释："就是运行的时候报错了，好像是什么权限问题……"

朋友回复："你把完整的报错信息发我看看？还有你用的什么版本？配置文件能给我看一下吗？你试过重启吗？"

你翻聊天记录找报错，复制粘贴代码片段，发了一堆截图。但你不确定这些是不是朋友需要的信息，朋友也不确定你发的是不是全部信息。来回三四轮，问题还没定位。

**这样的沟通效率极低，而且信息丢失严重。**

## 一个正在发生的趋势

越来越多人不再自己回答技术问题，而是：

**把朋友的问题粘贴给自己的 Agent，让 Agent 来分析和回答。**

为什么？因为技术问题需要精确的上下文：报错信息、环境配置、代码片段、已尝试的方案。这些信息如果完整，Agent 往往能给出准确答案。

但瓶颈在哪？**人类在中间传话时，这些关键信息会大量丢失。**

## Agent Link 的核心价值

**让 Agent 和 Agent 直接沟通，而不是经过人类转述。**

你的 Agent 知道你的完整上下文（报错信息、代码、环境、已尝试方案），它能把这些信息结构化打包。

朋友的 Agent 收到完整上下文后，能精准分析并给出建议。

**你和朋友依然负责传递（微信发个消息），但打包和解读由 Agent 完成，信息不再丢失。**

## 怎么用

### 真实场景：Docker 容器启动失败

**1. 你的 Agent 遇到了问题**

你在运行 Docker 项目，PostgreSQL 容器一直重启失败。你的 Agent 尝试了几个方案都不行。

你对 Agent 说：
> "帮我把这个问题打包，我找老王帮忙看看"

**2. Agent 自动打包完整上下文**

Agent 收集并整理：
- 问题描述：PostgreSQL 容器反复重启
- 环境信息：Docker Desktop 版本、系统版本、镜像版本
- 完整报错：`initdb: error: directory exists but is not empty...`
- 已尝试方案：清理卷 ✅、重建容器 ✅、未检查 volume 配置 ❌
- 自动过滤敏感信息（API Key、密码等）

生成一段结构化的 Markdown 文本。

**3. 你复制发给老王**

就像平时发消息一样，微信/飞书/邮件都可以。你不需要理解这段文本的技术细节。

**4. 老王粘贴给他的 Agent**

老王把你发的文本粘贴给他的 Agent。Agent 自动识别这是一个「协作请求」，读取完整的上下文信息。

**5. Agent 分析并生成回复**

老王的 Agent 基于完整信息分析：
> "问题根因是 volume 挂载到了根目录，导致 lost+found 目录冲突。建议在 docker-compose.yml 中将挂载点改为 /var/lib/postgresql/data/pgdata，并设置环境变量 PGDATA..."

生成结构化的「协作回复」。

**6. 老王把回复发回给你**

你粘贴给自己的 Agent。Agent 解读回复，用通俗的语言告诉你：
> "老王的 Agent 找到问题了。你需要修改 docker-compose.yml 文件，我现在帮你改..."

问题解决。

---

### 简化流程

```
你："帮我打包问题"
   ↓
Agent 自动收集并打包完整上下文
   ↓
你复制发给朋友（微信/飞书/邮件）
   ↓
朋友粘贴给他的 Agent → 自动分析 → 生成回复
   ↓
朋友把回复发回 → 你的 Agent 解读并执行
```

**你和朋友只需要复制粘贴，技术细节由 Agent 处理。**

## 为什么选择 Agent Link

### 信息零损耗
Agent 知道你的完整对话上下文，能自动收集：报错信息、环境配置、代码片段、已尝试的方案。不再需要你手动翻聊天记录、复制粘贴、来回确认"还需要什么信息"。

### 你依然掌控一切
- **你决定找谁**：基于对人的信任选择求助对象
- **你看得到内容**：Agent 打包的内容在对话中直接可见，不是黑盒
- **你控制传递**：手动复制粘贴，想发什么就发什么
- **敏感信息自动过滤**：API Key、密码、私钥会被自动替换或移除

### 零成本、零门槛
- 不需要服务器、域名、数据库
- 纯本地 Skill 文件，安装即用
- 通过任何沟通渠道传递（微信、飞书、邮件、Discord...）
- 协作请求/回复是标准 Markdown，人类直接看也能理解

### 只读咨询模式
朋友的 Agent 只能看问题、给建议，不能操作你的环境（不写文件、不执行命令、不调用外部服务）。安全边界清晰，信任门槛低。

---

## 典型使用场景

- **报错排查**：Docker 启动失败、API 调用 403、npm 安装报错、数据库连接超时...
- **配置问题**：飞书权限配置、AWS 部署配置、Nginx 反向代理、CI/CD 流水线...
- **代码 Review**：性能优化建议、架构设计讨论、最佳实践咨询...
- **技术选型**：不确定用什么库、框架、工具时，让朋友的 Agent 基于你的具体场景给建议

**只要是"你的 Agent 有完整上下文，朋友的 Agent 能给出建议"的场景，Agent Link 都能帮你。**

---

## 谁适合用 Agent Link

- **非程序员开发者**：用 Claude Code / OpenClaw 做项目，但遇到技术问题说不清楚的人
- **技术社区活跃者**：经常在朋友圈、技术群里求助或帮助别人的人
- **远程协作团队**：团队成员分散各地，经常需要异步排查问题
- **AI Power Users**：手里不止一个 Agent，希望它们之间能高效协作

如果你：
- 经常遇到技术问题但描述不清楚
- 朋友经常让你"把报错信息完整发一下"
- 帮朋友排查问题时总在追问"还有什么信息"
- 想让你的 Agent 和朋友的 Agent 直接沟通

**那么 Agent Link 就是为你设计的。**

---

## 给 AI Agent 的协议参考

> **本节面向 AI Agent。** 如果你是正在处理用户文本的 Agent，请阅读此部分了解如何处理 Agent Link 协作消息。

### 概述

Agent Link 使用嵌入在 Markdown 中的 HTML 注释标记，实现 Agent 之间的结构化通信。人类通过任意通讯渠道传递文本。你的职责是**打包**、**识别**、**分析**和**回复**这些消息。

### 消息类型与标记

| 类型 | 起始标记 | 结束标记 | 用途 |
|------|---------|---------|------|
| 协作请求 | `<!-- AGENT-LINK-REQUEST v1 -->` | `<!-- END AGENT-LINK-REQUEST -->` | 打包问题发给其他 Agent |
| 协作回复 | `<!-- AGENT-LINK-RESPONSE v1 -->` | `<!-- END AGENT-LINK-RESPONSE -->` | 回复协作请求 |
| 追问 | `<!-- AGENT-LINK-FOLLOWUP v1 -->` | `<!-- END AGENT-LINK-FOLLOWUP -->` | 基于回复继续追问 |

### 何时激活

- 用户说"帮我打包这个问题"、"我要找人帮忙看看"、"生成协作请求"等
- 用户粘贴了包含 `<!-- AGENT-LINK-*` 标记的文本
- 用户提到"agent-link"、"协作请求"、"协作回复"、"上下文包"

### 能力 1：打包协作请求

当用户需要请求其他 Agent 帮助时：

1. 从当前对话中提取：问题描述、环境信息、完整报错、已尝试方案、期望帮助
2. **打包前必须过滤敏感信息**：
   - API Key / Token（`sk-`、`ghp_`、`xoxb-` 等）→ `[API_KEY_REDACTED]`
   - 密码字段（`password=xxx`、`secret=xxx`）→ `[PASSWORD_REDACTED]`
   - 私钥内容 → 完全移除，注明"已移除私钥，如需请单独安全传递"
   - 本地绝对路径 → 替换为相对路径
   - 内部 IP / 内部域名 → `[INTERNAL_HOST]`
   - 日志中的用户名 / 邮箱 → 脱敏处理
3. 按格式输出（参见英文版 Capability 1 中的模板）
4. 提示用户："我帮你整理了以下协作请求，复制发给你的朋友即可。"

### 能力 2：识别并分析协作请求

当用户粘贴包含 `<!-- AGENT-LINK-REQUEST v1 -->` 的文本时：

1. 识别标记，解析各分节内容
2. 基于自身知识分析问题，给出诊断和建议
3. 按格式生成协作回复（参见英文版 Capability 2 中的模板）
4. 提示用户："复制这段回复发回给对方。"

### 能力 3：解读协作回复

当用户粘贴包含 `<!-- AGENT-LINK-RESPONSE v1 -->` 的文本时：

1. 解析回复内容
2. 结合之前的问题上下文，整合对方建议
3. 用通俗语言告诉用户：诊断结论、推荐的下一步、哪些需要手动操作、哪些 Agent 可以直接执行
4. 如果能直接执行某些建议（修改代码、调整配置），主动提出

### 能力 4：追问

当用户说"还有问题"、"方案试了不行"、"继续追问"时：

1. 结合之前的请求和回复，整理新信息
2. 按格式生成追问（参见英文版 Capability 4 中的模板）
3. 提示用户传递给对方

### 安全边界

这是一个**只读咨询**协议：
- 允许：文本问答、只读分析、返回建议和操作步骤
- 不允许：写对方的文件、执行对方的命令、调用对方的外部工具、访问对方的本地资源
- 如果解决问题需要凭证，只说明"需要 XX 类型的凭证"，不要求对方提供实际值

### 展示名

首次使用时询问用户："你希望在协作中怎么称呼？（比如你的名字或昵称）"

读取优先级：
1. `~/.agent-link/config.json` 中的 `displayName` 字段
2. 环境变量 `AGENT_LINK_DISPLAY_NAME`
3. 系统用户名
4. "匿名"

首次获取后保存到 `~/.agent-link/config.json`：
```json
{"displayName": "Kenny"}
```

---

## 安装

Agent Link 是一个 OpenClaw Skill，安装后你的 Agent 即具备协作能力。

（安装方式待发布后更新）

## 项目状态

**开发中** — MVP v1（异步协作上下文包）

## 文档

- [MVP v1 方案](./docs/mvp-v1.md) — 完整方案和格式规范
- [产品方案](./docs/product-spec.md) — 产品愿景
- [决策记录](./docs/decisions.md) — 关键决策及理由

## 许可证

MIT
