# Agent Link 技术架构（v2）

> 更新时间：2026-03-08
> 重大变更：从自建 WebSocket 协议切换到基于 Google A2A 的架构

## 核心原则

- **开放标准**：基于 Google A2A 协议，不发明私有协议
- **多平台兼容**：OpenClaw 优先，兼容 Claude Code、CodeEx 等
- **低成本**：MVP 阶段月成本 <$10
- **隐私安全**：Gateway 不存储对话内容；消息发出前自动过滤敏感信息（API Key、密码等）

---

## 整体架构

```
┌───────────────────┐                              ┌───────────────────┐
│   主人 A 的环境     │                              │   主人 B 的环境     │
│                   │                              │                   │
│  主人 A (人类)     │                              │  主人 B (人类)     │
│    ↕ 随时介入      │                              │    ↕ 随时介入      │
│                   │                              │                   │
│  Agent A          │         A2A 协议              │  Agent B          │
│  ┌─────────────┐  │    (HTTP + SSE/JSON-RPC)     │  ┌─────────────┐  │
│  │ agent-link  │  │◄────────────────────────────►│  │ agent-link  │  │
│  │   -core     │  │                              │  │   -core     │  │
│  └──────┬──────┘  │                              │  └──────┬──────┘  │
│         │         │                              │         │         │
│  ┌──────┴──────┐  │                              │  ┌──────┴──────┐  │
│  │ 平台适配层   │  │                              │  │ 平台适配层   │  │
│  │ (OpenClaw/  │  │                              │  │ (Claude Code│  │
│  │  CC/CodeEx) │  │                              │  │  /OpenClaw) │  │
│  └─────────────┘  │                              │  └─────────────┘  │
└───────────────────┘                              └───────────────────┘
                          ▲               ▲
                          │               │
                          ▼               ▼
                 ┌────────────────────────────┐
                 │      A2A Gateway           │
                 │   (Cloudflare Workers)     │
                 │                            │
                 │  - 连接码 → 会话路由        │
                 │  - A2A 消息中转             │
                 │  - Agent Card 托管          │
                 │  - 不存储对话内容            │
                 └────────────────────────────┘
```

### 为什么需要 Gateway？

标准 A2A 协议要求 Agent Server 暴露 HTTP endpoint。但大多数个人 Agent（OpenClaw、Claude Code）运行在本地，没有公网地址。

Gateway 的作用：
1. **为本地 Agent 提供公网可达的 A2A endpoint**
2. **通过连接码做会话路由**（替代 IP/域名发现）
3. **托管临时 Agent Card**（让对方知道这个 Agent 的能力）

当双方 Agent 都有公网地址时，可以绕过 Gateway 直连。

---

## A2A 协议适配

### Google A2A 核心概念映射

| A2A 概念 | Agent Link 中的含义 |
|---------|-------------------|
| **Agent Card** | Agent 的能力名片（我擅长什么、怎么联系我） |
| **Task** | 一次协作会话（从建联到结束） |
| **Message** | Agent 之间的一条消息（包含 Parts） |
| **Part** | 消息内容单元（TextPart / FilePart / DataPart） |
| **Artifact** | 协作产出物（解决方案、总结报告等） |
| **input-required** | Agent 需要主人确认/补充信息 |

### Task 生命周期（对应协作流程）

```
主人 A 说"帮我找老王的 Agent 协作"
    ↓
[SUBMITTED] → Agent A 通过 Gateway 创建 Task，生成协作链接
    ↓
主人 A 分享链接给主人 B → 主人 B 把链接丢给 Agent B
    ↓
[ACCEPTED] → Agent B 通过 Gateway 加入 Task
    ↓
[WORKING] → 两个 Agent 通过 A2A Message 来回对话
    ↓                    ↓
    ↓              [INPUT_REQUIRED] → Agent 暂停，找主人确认
    ↓                    ↓             主人回复后继续
    ↓              [WORKING] ← 继续对话
    ↓
[COMPLETED] → 问题解决，生成 Artifact（总结报告），通知双方主人
```

### A2A 消息格式

```json
// Agent A 发送消息给 Agent B
{
  "jsonrpc": "2.0",
  "method": "SendMessage",
  "params": {
    "taskId": "task-uuid",
    "message": {
      "role": "agent",
      "parts": [
        {
          "type": "text",
          "text": "我查看了飞书的权限配置，发现问题出在通讯录读取权限未开启..."
        }
      ]
    }
  }
}
```

```json
// Agent 请求主人确认（设 Task 为 input-required）
{
  "status": {
    "state": "input-required",
    "message": "需要你确认：是否开启通讯录读取权限？这会让应用能看到组织架构。"
  }
}
```

---

## 模块设计

### 1. agent-link-core（核心协议库）

平台无关的 TypeScript 库，实现 A2A 客户端/服务端协议。

```
agent-link-core/
├── src/
│   ├── a2a-client.ts      # A2A Client 实现（发送 Task/Message）
│   ├── a2a-server.ts      # A2A Server 实现（接收 Task/Message）
│   ├── agent-card.ts      # Agent Card 生成和解析
│   ├── task-manager.ts    # Task 生命周期管理
│   ├── message.ts         # Message/Part 构建和解析
│   ├── gateway-client.ts  # Gateway 连接（注册、心跳、消息中转）
│   ├── link-parser.ts     # 协作链接解析（自动识别 URL）
│   └── types.ts           # 类型定义
├── package.json
└── tsconfig.json
```

**核心 API：**

```typescript
class AgentLink {
  // 创建协作会话，返回协作链接
  async createSession(topic?: string): Promise<{ link: string; code: string }>

  // 通过链接或连接码加入会话
  async joinSession(linkOrCode: string): Promise<void>

  // 发送消息给对方 Agent
  async sendMessage(content: string): Promise<void>

  // 请求主人确认（暂停协作，等主人回复）
  async requestHumanInput(question: string): Promise<string>

  // 主人补充信息（注入到下一轮对话）
  async injectHumanMessage(content: string): Promise<void>

  // 获取协作状态
  getStatus(): SessionStatus

  // 关闭会话
  async closeSession(): Promise<{ summary: string }>

  // 事件监听
  on(event: 'message' | 'human-input-needed' | 'completed' | 'error', handler): void
}
```

### 2. 平台适配层

每个平台一个薄包装，只做"翻译"：

#### OpenClaw Skill

```
skill-openclaw/
├── SKILL.md              # OpenClaw Skill 描述文件
├── src/
│   ├── index.ts          # Skill 入口，注册命令和自然语言触发
│   └── adapter.ts        # OpenClaw ↔ agent-link-core 适配
└── package.json
```

- 自然语言触发："帮我找人协作"、"加入 xxx"
- 自动识别粘贴的协作链接
- 状态卡片渲染
- 主人消息注入

#### Claude Code Skill（推荐）

Claude Code 也支持 Skill（SKILL.md），对用户来说最简单——把文件放到 `~/.claude/skills/agent-link/` 即可。

```
skill-claude-code/
├── SKILL.md              # Claude Code Skill 描述文件（prompt + 工具声明）
├── src/
│   ├── index.ts          # Skill 运行入口
│   └── adapter.ts        # Claude Code ↔ agent-link-core 适配
└── package.json
```

#### Claude Code MCP Server（高级）

对需要更深度集成的用户，也提供 MCP Server 方式：

```
mcp-claude-code/
├── src/
│   ├── index.ts          # MCP Server 入口
│   └── tools.ts          # 暴露为 MCP Tools
└── package.json
```

暴露的 MCP Tools：
- `agent_link_create` - 创建协作会话
- `agent_link_join` - 加入协作会话
- `agent_link_send` - 发送消息
- `agent_link_status` - 查看状态
- `agent_link_close` - 关闭会话

#### 其他平台

未来按需添加，核心逻辑都在 agent-link-core 中。

### 3. A2A Gateway（服务端）

```
gateway/
├── src/
│   ├── index.ts          # Cloudflare Worker 入口
│   ├── session.ts        # Durable Object: 会话管理
│   ├── agent-card.ts     # 临时 Agent Card 托管
│   ├── routes.ts         # HTTP 路由
│   └── types.ts          # 类型定义
├── wrangler.toml
└── package.json
```

**API 设计：**

```
# 创建会话（返回连接码和协作链接）
POST /api/sessions
→ { code: "A3F9K2", link: "https://link.agent.ai/s/A3F9K2" }

# 加入会话
POST /api/sessions/:code/join
Body: { agentCard: {...} }
→ { taskId: "uuid", peerAgentCard: {...} }

# A2A 消息中转（标准 A2A JSON-RPC）
POST /api/sessions/:code/a2a
Body: { jsonrpc: "2.0", method: "SendMessage", params: {...} }
→ A2A 标准响应

# SSE 订阅（接收对方消息）
GET /api/sessions/:code/events?participantId=xxx
→ SSE stream

# 协作链接落地页
GET /s/:code
→ HTML 引导页面

# 健康检查
GET /health
→ { status: "ok" }
```

### 4. 协作链接落地页（Website）

```
website/
├── index.html            # 产品首页
├── join.html             # 协作链接落地页
└── styles.css
```

**落地页内容**（当有人打开 `https://link.agent.ai/s/A3F9K2`）：

```
┌─────────────────────────────────────────┐
│                                         │
│   🤝 Kenny 的 Agent 邀请你协作           │
│                                         │
│   话题：飞书权限问题                      │
│                                         │
│   把下面这段话发给你的 AI 助手就行了：     │
│                                         │
│   ┌─────────────────────────────────┐   │
│   │ 请帮我加入这个协作会话：          │   │
│   │ https://link.agent.ai/s/A3F9K2 │   │
│   │                        [复制]   │   │
│   └─────────────────────────────────┘   │
│                                         │
│   支持：OpenClaw · Claude Code · CodeEx │
│                                         │
└─────────────────────────────────────────┘
```

---

## 敏感信息安全

### 问题

两个 Agent 协作时，可能不小心把主人的敏感信息发给对方：
- API Key / Secret Token（如 `sk-proj-xxx`、`ghp_xxx`）
- 数据库密码、连接字符串
- `.env` 文件内容
- SSH 私钥
- 内部 IP / 域名
- 个人身份信息（身份证号、银行卡号等）

### 解决方案：消息安全过滤层

在 agent-link-core 的消息发送管道中加入安全过滤：

```
Agent 生成消息 → 安全过滤层 → 发送给对方
                    │
                    ├── 正则匹配已知敏感格式
                    ├── 检测 Key/Token 模式
                    ├── 检测文件路径中的凭证文件
                    └── 拦截或脱敏后继续
```

**过滤规则（内置）：**

| 类型 | 匹配模式 | 处理方式 |
|-----|---------|---------|
| API Key | `sk-`, `ghp_`, `gho_`, `AKIA`, `Bearer ` 等前缀 | 拦截，通知主人 |
| 密码字段 | `password=`, `secret=`, `token=` 等键值对 | 脱敏为 `***` |
| 环境变量 | `.env` 文件格式（`KEY=VALUE`） | 拦截，通知主人 |
| 私钥 | `-----BEGIN.*PRIVATE KEY-----` | 拦截，通知主人 |
| 连接字符串 | `mysql://`, `postgres://`, `redis://` 含密码部分 | 密码部分脱敏 |

**处理策略：**
1. **拦截**：消息不发送，通知主人 "检测到消息中包含疑似 API Key，已阻止发送。确认是否继续？"
2. **脱敏**：自动替换为 `[REDACTED]`，消息继续发送
3. **放行**：主人明确确认后可放行（支持单次放行和白名单）

**可配置性：**
- 主人可以自定义额外的过滤规则
- 可设置过滤级别：严格（拦截所有疑似）/ 标准（拦截高置信度）/ 宽松（仅拦截明确敏感）
- 可设置白名单（某些特定格式不过滤）

### Prompt 级防护

除了正则过滤，还在 Skill 的 system prompt 中明确告知 Agent：

```
重要安全规则：
1. 在协作对话中，绝对不要分享以下信息：
   - API Key、Token、密码等凭证
   - .env 文件内容
   - SSH 密钥
   - 数据库连接字符串（含密码部分）
2. 如果解决问题需要用到凭证，只说"需要 XX 类型的凭证"，让对方主人自行操作
3. 分享报错信息时，注意脱敏（去除路径中的用户名、内部 IP 等）
```

---

## 展示名机制

### 问题

协作时需要展示"Kenny 的 Agent"这样的名称，这个名字从哪来？

### 方案：首次使用时询问，之后记住

```
用户第一次使用 Agent Link 时：
    ↓
Agent："你希望在协作中怎么称呼？比如你的名字或昵称"
    ↓
用户："Kenny"
    ↓
Agent 保存到本地配置：~/.agent-link/config.json
    ↓
之后所有协作都显示为"Kenny 的 Agent"
```

### 展示名来源（优先级从高到低）

| 来源 | 示例 | 说明 |
|-----|------|------|
| 本地配置文件 | `~/.agent-link/config.json` 中的 `displayName` | 用户首次使用时设置 |
| 环境变量 | `AGENT_LINK_DISPLAY_NAME=Kenny` | 适合 CI/自动化场景 |
| 系统用户名 | `os.userInfo().username` | 兜底方案 |
| 随机 ID | `Agent-A3F9K2` | 最终兜底，匿名场景 |

### 配置文件

```json
// ~/.agent-link/config.json
{
  "displayName": "Kenny",
  "securityLevel": "standard",
  "customFilters": []
}
```

### 隐私考虑

- 展示名是用户主动设置的，不自动采集真实姓名
- 用户可以随时修改
- 不同协作可以用不同展示名（未来功能）

---

## 人类介入机制

### Agent 找主人确认

```
协作对话进行中...
    ↓
Agent B 不确定某个操作是否要执行
    ↓
Agent B 设 Task 状态为 input-required
    ↓
主人 B 收到通知："你的 Agent 想确认：是否同意开启 XX 权限？"
    ↓
主人 B 回复："可以，开吧"
    ↓
Agent B 收到回复，Task 状态恢复为 working，继续对话
```

### 主人主动补充信息

```
主人 A 想到一个重要细节
    ↓
主人 A 对 Agent A 说："对了，错误码是 10003，补充给对方"
    ↓
Agent A 把信息带入下一条消息发给 Agent B
```

### 信息同步规则

| 信息类型 | 同步给对方 Agent | 示例 |
|---------|----------------|------|
| 技术细节 | ✅ | "错误码是 10003" |
| 决策偏好 | ✅ | "优先简单方案" |
| 授权确认 | ✅ | "可以开启这个权限" |
| 私人情绪 | ❌ | "好烦啊" |

---

## 架构演进路线

### Phase 1: MVP（当前目标）

```
Agent A ←─ A2A over HTTP ─→ Gateway ←─ A2A over HTTP ─→ Agent B
```

- 所有通信经过 Gateway 中转
- 基于标准 A2A 协议
- 连接码 + 协作链接建联
- HTTPS 传输加密（非 E2EE）

### Phase 2: 直连优化

```
Agent A ←──── A2A 直连 ────→ Agent B
                ↑
          有公网地址时直连
          否则回退到 Gateway
```

- Agent Card 中声明公网 endpoint
- Gateway 仅作 fallback

### Phase 3: 能力发现

- Agent Card 公开注册表
- 按能力搜索可协作的 Agent
- 信任评级系统

---

## 部署方案

| 组件 | 部署平台 | 成本 |
|-----|---------|------|
| A2A Gateway | Cloudflare Workers + Durable Objects | $0/月（免费额度） |
| 协作链接落地页 | Cloudflare Pages | $0/月 |
| Agent Card 存储 | Durable Objects 内存 | $0/月 |
| agent-link-core | npm 包，客户端运行 | 无服务端成本 |

**总成本：$0/月（MVP 阶段）**

---

## 与旧方案的对比

| 维度 | 旧方案（v1） | 新方案（v2） |
|-----|------------|------------|
| 通信协议 | 自建 WebSocket + 自定义消息 | Google A2A（HTTP + JSON-RPC + SSE） |
| 加密方式 | X25519 + AES-256-GCM（自建） | HTTPS 传输加密（标准） |
| 平台支持 | 仅 OpenClaw | OpenClaw + Claude Code + CodeEx + ... |
| 连接方式 | `/link join CODE` | 协作链接（粘贴即连） |
| 人类介入 | 未实现 | A2A input-required 状态原生支持 |
| 维护成本 | 需维护 WebSocket 长连接 | 标准 HTTP，无状态连接 |
| 生态兼容 | 孤立系统 | 与 A2A 生态互通 |

---

## 相关文档

- [决策记录](./decisions.md) - 关键决策及理由
- [技术调研](./tech-research.md) - 协议调研和对比
- [MVP 方案](./mvp-v1-final.md) - MVP 冻结方案
- [产品方案](./product-spec.md) - 产品设计
