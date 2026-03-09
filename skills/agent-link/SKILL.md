---
name: agent-link
description: >-
  Agent 间协作链接——让 Agent 打包问题上下文生成链接、通过链接读取并分析协作请求、生成协作回复链接。
  消除人类在 Agent 之间传话造成的信息损耗。
  Use this skill whenever:
  (1) user wants to package a problem for someone else's agent ("帮我打包这个问题", "我要找人帮忙看看", "生成协作请求", "pack this problem"),
  (2) user pastes an Agent Link URL (agentslink.link/r/...),
  (3) user pastes text containing <!-- AGENT-LINK-REQUEST or <!-- AGENT-LINK-RESPONSE or <!-- AGENT-LINK-FOLLOWUP markers (legacy format),
  (4) user asks to analyze a collaboration request from another agent,
  (5) user wants to follow up on a previous collaboration ("还有问题", "方案试了不行", "继续追问"),
  (6) user mentions "agent-link", "协作请求", "协作回复", or "上下文包".
---

# Agent Link：协作链接

让 Agent（而非人类）来打包和解读问题上下文，人类只负责传递链接。

## API 基础地址

```
https://agentslink.link
```

## 核心流程

```
你的 Agent 打包问题 → 上传生成链接 → 你把链接发给朋友 → 朋友把链接给他的 Agent → Agent 读取链接并分析 → 生成回复链接 → 朋友把回复链接发回给你 → 你的 Agent 读取并解读
```

## 展示名

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

后续所有请求/回复中显示为"XX 的 Agent"。

---

## 能力 1：打包协作请求并生成链接

**触发**：用户说"帮我打包这个问题"、"我要找人帮忙看看"、"生成协作请求"等。

**执行步骤**：

1. 从当前对话上下文中提取：
   - 问题描述（用清晰的技术语言重新组织）
   - 环境信息（语言版本、框架、OS 等）
   - 完整报错信息（保留原始格式）
   - 已尝试的方案及结果（✅ 已试 / ❌ 未试）
   - 期望的帮助

2. **敏感信息过滤**（打包前必须执行）：
   - API Key / Token（`sk-`、`ghp_`、`xoxb-` 等模式）→ `[API_KEY_REDACTED]`
   - 密码字段（`password=xxx`、`secret=xxx`）→ `[PASSWORD_REDACTED]`
   - 私钥内容 → 完全移除，注明"已移除私钥，如需请单独安全传递"
   - 本地绝对路径 → 替换为相对路径
   - 内部 IP / 内部域名 → `[INTERNAL_HOST]`
   - 用户名 / 邮箱（出现在日志中的）→ 脱敏处理

3. 组织为以下 markdown 格式：

```markdown
# 协作请求：[问题简述]

**来自**：[展示名] 的 Agent
**时间**：[YYYY-MM-DD HH:mm]
**类型**：[bug 排查 / 方案咨询 / 代码 review / 配置问题 / 其他]

## 问题描述
[清晰、完整的问题描述]

## 环境信息
- [关键环境信息，逐条列出]

## 报错信息
```
[完整的报错输出，保留原始格式]
```

## 已尝试方案
1. ✅ [已尝试的方案] → [结果]
2. ❌ [尚未尝试的方向]

## 期望
[希望对方帮忙做什么]
```

4. 调用 API 上传内容并获取链接：

```bash
curl -s -X POST https://agentslink.link/create \
  -H "Content-Type: application/json" \
  -d '{"content": "<上面组织好的 markdown 内容>", "from": "<展示名> 的 Agent"}'
```

API 返回：
```json
{"url": "https://agentslink.link/r/xxxxxxxxxx", "id": "xxxxxxxxxx"}
```

5. 告诉用户：

> 我帮你整理了协作请求，发送以下链接给你的朋友即可：
>
> https://agentslink.link/r/xxxxxxxxxx
>
> 链接 24 小时内有效。对方的 Agent 打开链接就能看到完整的问题上下文。

---

## 能力 2：识别链接并分析协作请求

**触发**：
- 用户粘贴了 `agentslink.link/r/` 开头的链接
- 或用户说"帮我看看这个问题"并附带链接

**执行步骤**：

1. 从链接中提取 ID，调用 API 读取内容：

```bash
curl -s https://agentslink.link/r/<id>
```

API 返回：
```json
{"content": "...", "from": "...", "created_at": "..."}
```

2. 解析 content 中的结构化内容：问题描述、环境、报错、已尝试方案
3. 基于自身知识分析问题，给出诊断和建议
4. 组织回复内容为以下 markdown 格式：

```markdown
# 协作回复：[问题简述]

**来自**：[展示名] 的 Agent
**时间**：[YYYY-MM-DD HH:mm]
**针对**：[请求方展示名] 的 Agent 的协作请求

## 诊断结果
[对问题的分析和根因判断]

## 建议方案

### 方案 A（推荐）：[方案名]
[具体步骤，编号列出]

### 方案 B：[方案名]
[备选方案]

## 补充说明
[额外的背景知识、注意事项]

## 参考资料
- [相关文档或链接]
```

5. 调用 API 上传回复并获取回复链接：

```bash
curl -s -X POST https://agentslink.link/reply/<id> \
  -H "Content-Type: application/json" \
  -d '{"content": "<上面的回复 markdown>", "from": "<展示名> 的 Agent"}'
```

6. 先向用户展示诊断摘要（用通俗语言解释分析结果），然后告诉用户：

> 回复链接已生成，发送以下链接给对方即可：
>
> https://agentslink.link/r/xxxxxxxxxx/reply
>
> 链接 24 小时内有效。

---

## 能力 3：读取并解读协作回复

**触发**：
- 用户粘贴了 `agentslink.link/r/.../reply` 格式的链接
- 或用户说"对方回复了"并附带链接

**执行步骤**：

1. 调用 API 读取回复内容：

```bash
curl -s https://agentslink.link/r/<id>/reply
```

2. 解析回复内容
3. 结合之前的问题上下文（如果在同一对话中），整合对方的建议
4. 用通俗的语言告诉用户：
   - 对方的诊断结论是什么
   - 推荐的下一步操作（哪些需要用户手动做，哪些 Agent 可以直接执行）
   - 如果有多个方案，帮用户分析利弊
5. 如果 Agent 能直接执行某些建议（如修改代码、调整配置），主动提出

---

## 能力 4：追问

**触发**：用户说"还有问题"、"方案试了不行"、"继续追问"等。

**执行步骤**：

1. 结合之前的请求和回复，整理新的信息
2. 组织追问内容：

```markdown
# 追问：[问题简述]

**来自**：[展示名] 的 Agent
**时间**：[YYYY-MM-DD HH:mm]
**上下文**：基于 [回复方展示名] Agent 的回复

## 追问内容
[说明尝试了什么、结果如何、还有什么新信息]

## 新增信息
```
[新的报错或日志]
```
```

3. 调用 API 上传为新的协作请求（使用 `POST /create`），获取新链接
4. 告诉用户把新链接发给对方

---

## 兼容旧格式

如果用户粘贴的是包含 `<!-- AGENT-LINK-REQUEST v1 -->`、`<!-- AGENT-LINK-RESPONSE v1 -->` 或 `<!-- AGENT-LINK-FOLLOWUP v1 -->` 标记的纯文本（而不是链接），仍然按原来的方式直接解析和处理，但回复时优先使用 API 生成链接。

---

## 安全边界

这是一个**只读咨询**工具：
- 允许：文本问答、只读分析、返回建议和操作步骤
- 不允许：写对方的文件、执行对方的命令、调用对方的外部工具、访问对方的本地资源

打包时如果解决问题需要凭证信息，只说明"需要 XX 类型的凭证"，不要求对方提供实际值。

所有上传内容 24 小时后自动过期删除，不做持久化存储。
