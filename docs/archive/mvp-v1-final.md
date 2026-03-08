# Agent Link MVP v2.0 方案

> 状态：方案已确认，待开发
> 更新时间：2026-03-08
> 重大变更：从自建 WebSocket 协议切换到 Google A2A 协议；链接优先的连接体验；多平台支持

---

## 一句话价值

让不同平台的 Agent（OpenClaw / Claude Code / CodeEx）直接协作解决问题——人类只需分享一个链接。

---

## 核心流程（三步）

```
1. 人分享链接 → 2. Agent 自主对话 → 3. 人确认收尾
```

| 阶段 | 人类做什么 | Agent 做什么 |
|-----|-----------|-------------|
| **分享** | 把协作链接发给对方 | 生成链接，自动识别并加入 |
| **对话** | 随时查看、补充信息、确认决策 | 直接沟通、解决问题、需要时找主人确认 |
| **确认** | 验收结果 | 生成总结、通知双方主人 |

---

## 连接体验（链接优先）

### 推荐流程

```
1. 主人 A："帮我和老王的 Agent 协作一下飞书权限的问题"
2. Agent A 生成协作链接：https://link.agent.ai/s/A3F9K2
3. 主人 A 把链接微信发给老王
4. 老王把链接粘贴给他的 Agent
5. 老王的 Agent 自动识别链接，自动加入协作
6. 两个 Agent 开始对话解决问题
```

### 连接方式（按推荐度排序）

| 方式 | 示例 | 场景 | 用户操作 |
|-----|------|------|---------|
| **协作链接（推荐）** | `https://link.agent.ai/s/A3F9K2` | 微信/钉钉分享 | 复制粘贴给 Agent |
| **连接码** | `A3F9K2` | 口述/电话 | 告诉 Agent "加入 A3F9K2" |
| **命令（兜底）** | `/link join A3F9K2` | 高级用户 | 手动输入命令 |

### 关键设计

- **Agent 自动识别链接**：用户粘贴 `https://link.agent.ai/s/A3F9K2`，Agent 应自动识别这是协作邀请并发起连接
- **落地页引导**：打开链接后显示引导页，告诉用户"把这段话发给你的 AI 助手"
- **跨平台提示**：落地页标注"支持 OpenClaw · Claude Code · CodeEx"

---

## 人类介入设计

### Agent 找主人确认

Agent 在协作中遇到不确定的事，可以暂停并找主人确认：

```
Agent B 对话中发现需要开启某个权限
    ↓
Agent B：🟡 "需要你确认：是否开启通讯录读取权限？"
    ↓
主人 B 回复："可以，开吧"
    ↓
Agent B 继续对话，把确认信息带给 Agent A
```

**触发条件：**

| 条件 | Agent 行为 |
|-----|-----------|
| 需要外部授权 | 暂停，通知主人 |
| 涉及敏感操作 | 暂停，等待批准 |
| 不确定的决策 | 暂停，请求确认 |
| 对话陷入僵局 | 通知，建议人工介入 |

### 主人主动补充信息

主人随时可以向自己的 Agent 补充信息：

```
主人 A："对了，错误码是 10003，补充给对方"
    ↓
Agent A 把信息带入下一条消息发给 Agent B
```

### 信息同步规则

| 信息类型 | 同步给对方 | 示例 |
|---------|----------|------|
| 技术细节 | ✅ | "错误码是 10003" |
| 决策偏好 | ✅ | "优先简单方案" |
| 新线索 | ✅ | "我发现日志里有报错" |
| 闲聊/情绪 | ❌ | "好烦啊" |

---

## 自然语言交互

| 意图 | 用户说法示例 |
|-----|------------|
| 发起协作 | "帮我找人协作" / "我要求助" / "创建协作会话" |
| 接受协作 | 粘贴链接 / "加入 A3F9K2" |
| 查看状态 | "协作进度怎么样了" / "现在什么状态" |
| 补充信息 | "告诉对方错误码是 10003" |
| 结束会话 | "结束协作" / "关闭会话" |

---

## 主窗口状态卡片

```
┌─────────────────────────────────────┐
│ 🤝 与 老王的 Agent 协作中            │
│                                     │
│ 话题：飞书权限问题                    │
│ 进度：诊断问题 ✓ → 尝试方案A ✗ →     │
│       尝试方案B [进行中]             │
│                                     │
│ 💬 最近：对方发现权限配置问题         │
│ ⚠️ 需要你：确认是否开启通讯录读取权限 │
│                                     │
│ [查看完整对话] [补充信息] [结束]      │
└─────────────────────────────────────┘
```

---

## 技术架构

基于 Google A2A 协议，通过自建 Gateway 补充连接码/链接机制。

```
Agent A ←─ A2A (HTTP/SSE) ─→ Gateway (CF Workers) ←─ A2A (HTTP/SSE) ─→ Agent B
```

| 组件 | 选型 | 成本 |
|-----|------|------|
| 通信协议 | Google A2A（HTTP + JSON-RPC + SSE） | - |
| A2A Gateway | Cloudflare Workers + Durable Objects | $0/月 |
| 协作链接落地页 | Cloudflare Pages | $0/月 |
| 核心库 | agent-link-core（TypeScript npm 包） | - |
| OpenClaw 适配 | openclaw-skill（Skill 插件） | - |
| Claude Code 适配 | mcp-server（MCP Server） | - |

详细架构见 [技术架构 v2](./tech-arch.md)。

---

## 多平台支持

| 平台 | 接入方式 | 优先级 |
|-----|---------|-------|
| **OpenClaw** | Skill 插件 | P0（MVP 首发） |
| **Claude Code** | Skill（推荐）或 MCP Server | P0（同步支持） |
| **CodeEx** | 待调研 | P2 |
| **其他 A2A 兼容 Agent** | 直连 Gateway | 天然支持 |

> Claude Code 和 OpenClaw 都支持 Skill 机制，目标用户都是小白，所以两个平台都优先用 Skill 接入——用户只需把文件放到 skills 目录就行。MCP Server 作为高级选项保留。

---

## Task 状态机

```
[创建] → [待加入] → [协作中] → [待确认/input-required] → [已完成]
             ↓          ↓              ↓
          [过期]      [超时]         [取消]
```

| 状态 | A2A 对应 | 触发条件 | 处理 |
|-----|---------|---------|------|
| 待加入 | SUBMITTED | 生成链接，等对方加入 | 10 分钟过期 |
| 协作中 | WORKING | 双方 Agent 对话中 | - |
| 待确认 | INPUT_REQUIRED | Agent 需要主人确认 | 通知主人 |
| 已完成 | COMPLETED | 问题解决 | 生成总结 |
| 过期 | CANCELED | 连接码超时 | 通知创建者 |
| 超时 | CANCELED | 30 分钟无消息 | 提醒后关闭 |
| 取消 | CANCELED | 任一方主人说"结束" | 立即关闭 |

---

## 敏感信息安全

Agent 协作时**严禁泄露**主人的敏感信息。agent-link-core 内置消息安全过滤层：

| 类型 | 示例 | 处理 |
|-----|------|------|
| API Key / Token | `sk-proj-xxx`, `ghp_xxx` | 拦截，通知主人确认 |
| 密码/凭证 | `password=xxx`, `.env` 内容 | 拦截，通知主人确认 |
| 私钥 | `-----BEGIN PRIVATE KEY-----` | 拦截 |
| 连接字符串密码 | `mysql://user:pass@host` | 密码部分脱敏为 `***` |

同时在 Skill prompt 中明确告知 Agent：不要分享凭证，需要凭证时让主人自行操作。

详细设计见 [技术架构 - 敏感信息安全](./tech-arch.md#敏感信息安全)。

---

## 展示名

协作中显示的名称（如"Kenny 的 Agent"）获取方式：

1. **首次使用时 Agent 主动询问**："你希望在协作中怎么称呼？" → 用户回答 "Kenny"
2. 保存到 `~/.agent-link/config.json`，之后不再询问
3. 兜底：环境变量 `AGENT_LINK_DISPLAY_NAME` → 系统用户名 → 随机 ID

---

## MVP 功能清单

### P0 - 必须实现

- [ ] **agent-link-core**：A2A Client 实现 + Gateway 连接 + 链接解析 + 敏感信息过滤
- [ ] **A2A Gateway**：连接码生成/路由 + A2A 消息中转 + SSE 推送
- [ ] **OpenClaw Skill**：自然语言触发 + 链接自动识别 + 状态卡片
- [ ] **Claude Code Skill**：同 OpenClaw Skill，适配 Claude Code 的 Skill 规范
- [ ] **协作链接落地页**：引导页 + 复制功能 + 跨平台提示
- [ ] **人类介入**：input-required 状态 + 主人消息注入
- [ ] **展示名**：首次使用询问 + 本地持久化
- [ ] **安全过滤**：消息发出前检测并拦截敏感信息

### P1 - 体验优化

- [ ] **Claude Code MCP Server**：高级用户的 MCP Tools 接入方式
- [ ] **完整对话视图**：查看 Agent 间的所有对话
- [ ] **协作总结**：会话结束自动生成总结报告（Artifact）
- [ ] **连接码二维码**：面对面场景
- [ ] **自定义安全过滤规则**：用户可配置额外敏感信息模式

### 不做（MVP 外）

- [ ] 文件/图片传输
- [ ] 多人（>2）协作
- [ ] Agent 能力发现/匹配
- [ ] 端到端加密（Phase 2）
- [ ] Agent Card 公开注册表

---

## 开发里程碑

| 阶段 | 目标 | 交付物 |
|-----|------|--------|
| Week 1 | A2A Gateway + 核心库 | 两个 Node.js 进程能通过 Gateway 互发消息 |
| Week 2 | OpenClaw Skill + 人类介入 | OpenClaw 用户可以完成完整协作流程 |
| Week 3 | 落地页 + 测试 + 发布 | 可公开使用的 MVP |

---

## 命名规范

| 项目 | 命名 |
|-----|------|
| 产品名 | **Agent Link** |
| npm 包 | `agent-link-core` |
| OpenClaw Skill | `agent-link` |
| Claude Code MCP | `agent-link-mcp` |
| Gateway 域名 | `link.agent.ai`（待定） |
| 协作链接格式 | `https://link.agent.ai/s/{code}` |
| 连接码格式 | 6 位字母数字（如 A3F9K2） |

---

## 文档索引

- `docs/decisions.md` - 关键决策记录
- `docs/tech-arch.md` - 技术架构 v2
- `docs/tech-research.md` - 技术调研报告
- `docs/product-spec.md` - 产品方案
- `docs/interaction-details.md` - 交互设计细节
