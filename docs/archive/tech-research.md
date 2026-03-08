# Agent-to-Agent 通信技术调研报告

> 初始调研：2025年1月
> 更新调研：2026年3月8日（新增 A2A 深度分析、多框架对比）
> 调研范围：OpenClaw 原生能力、Google A2A 协议、P2P 通信方案、端到端加密、基础设施选项、多 Agent 框架对比

---

## 执行摘要

基于对 6 大技术方向的系统调研，**推荐方案**为：

| 组件 | 推荐技术 | 理由 |
|-----|---------|------|
| 信令服务 | Cloudflare Workers + Durable Objects | 免费额度充足，全球边缘部署 |
| 传输层 | WebSocket (MVP) → WebRTC (优化) | 渐进式演进，降低初期复杂度 |
| 加密 | X25519 + AES-256-GCM | 成熟可靠，支持前向保密 |
| 身份 | Ed25519 密钥对 + 可选 OAuth | 自托管身份，无需依赖第三方 |

**预估 MVP 成本：$0-5/月**

---

## 1. OpenClaw 原生能力分析

### 1.1 现有工具概览

OpenClaw 提供以下会话管理工具：
- `sessions_list` - 列出当前用户的活跃会话
- `sessions_send` - 向指定会话发送消息
- `sessions_history` - 获取会话历史记录
- `sessions_spawn` - 创建新的子会话

### 1.2 能否用于跨用户 Agent 通信？

**结论：不能直接用于跨用户通信**

| 维度 | 分析 |
|-----|------|
| **设计目标** | 单用户内的会话管理（主会话 ↔ 子会话） |
| **身份模型** | 同一用户的不同会话实例 |
| **隔离性** | 会话数据按用户隔离，无法跨用户访问 |
| **安全性** | 没有内置的跨用户认证机制 |

### 1.3 局限性

1. **无全局发现机制**：无法通过 ID 找到其他用户的 Agent
2. **无跨用户路由**：消息只能在同用户会话间传递
3. **权限模型限制**：设计假设所有会话属于同一主体

### 1.4 适用场景

- ✅ 单用户多 Agent 协作（如主 Agent 调用专用子 Agent）
- ✅ 会话历史管理和审计
- ❌ 跨用户 Agent 直接通信

### 1.5 可复用部分

```javascript
// OpenClaw 的会话管理理念可作为参考：
- 会话生命周期管理（创建、活跃、关闭）
- 消息持久化策略
- 心跳检测机制
- 权限检查模式
```

---

## 2. Google A2A 协议深度分析

### 2.1 协议概述

Google A2A (Agent-to-Agent) 是 Google 于 2025 年推出的开放协议，旨在实现不同框架、不同厂商的 AI Agent 互操作。

**核心设计理念：**
- **能力发现 (Agent Discovery)**：Agent 通过 JSON 描述自己的能力
- **任务导向 (Task-Centric)**：以任务为单元进行协作
- **异步通信**：支持长时间运行的任务
- **安全优先**：内置认证和授权机制

### 2.2 协议架构

```
┌─────────────────────────────────────────┐
│           Agent A (Client)              │
│  ┌─────────┐      ┌─────────────────┐  │
│  │  Task   │─────→│  A2A Client     │  │
│  │ Manager │←─────│  (HTTP/SSE)     │  │
│  └─────────┘      └─────────────────┘  │
└─────────────────────────────────────────┘
                    ↓ HTTP / Server-Sent Events
┌─────────────────────────────────────────┐
│           Agent B (Server)              │
│  ┌─────────────────┐      ┌─────────┐  │
│  │  A2A Server     │─────→│  Skill  │  │
│  │  (HTTP Endpoint)│←─────│  Router │  │
│  └─────────────────┘      └─────────┘  │
└─────────────────────────────────────────┘
```

### 2.3 关键概念

#### Agent Card (agent-card.json)
```json
{
  "name": "Feishu Assistant",
  "description": "Help with Feishu API and permissions",
  "url": "https://agent.example.com/a2a",
  "capabilities": {
    "streaming": true,
    "pushNotifications": false
  },
  "skills": [
    {
      "id": "feishu_permissions",
      "name": "Feishu Permission Helper",
      "description": "Diagnose and fix Feishu permission issues",
      "tags": ["feishu", "permissions", "api"],
      "examples": ["How to fix 'permission denied' error?"]
    }
  ]
}
```

#### Task 生命周期
```
Create Task → Submitted → Working → Input Required → Completed
                ↓           ↓            ↓              ↓
             等待处理    正在执行     需要人类确认     任务完成
```

### 2.4 与需求匹配度评估

| 需求 | A2A 支持度 | 说明 |
|-----|-----------|------|
| 人工牵线 | ⭐⭐⭐⭐⭐ | 通过 Agent Card 发现，人类选择 |
| 低成本 | ⭐⭐⭐ | 需实现完整 HTTP 服务器 |
| 隐私优先 | ⭐⭐⭐ | 支持认证，但非端到端加密 |
| 简洁易用 | ⭐⭐⭐ | 协议较重，学习成本高 |
| 未来扩展 | ⭐⭐⭐⭐⭐ | Google 背书，生态潜力大 |

### 2.5 实现复杂度

**高复杂度原因：**
1. **服务端要求**：每个 Agent 需要暴露 HTTP 端点
2. **网络配置**：需要公网地址或内网穿透
3. **协议栈**：需实现完整的 Task 状态机
4. **发现机制**：需要 Agent Card 托管服务

**估算工作量**：2-3 周实现基础版本

### 2.6 建议（已更新 2026-03-08）

> ⚠️ 以下为 2025-01 的旧结论，已被推翻。

~~- **长期关注**：A2A 可能成为行业标准~~
~~- **MVP 暂缓**：协议过重，不适合快速验证~~
~~- **未来集成**：可作为 Phase 2 的兼容层~~

**2026-03-08 更新结论：采用 A2A 作为核心协议。**

理由：
1. A2A 于 2025-04 正式发布后，已有 50+ 企业参与，捐给 Linux 基金会，成为事实标准
2. 我们的核心需求"跨平台 Agent 互操作"恰好是 A2A 的设计目标
3. 自建协议 = 每个平台单独适配；用 A2A = 天然兼容所有支持 A2A 的 Agent
4. A2A 的 Task 模型 + `input-required` 状态完美匹配"Agent 找主人确认"的需求
5. 基于 HTTP 标准，比维护 WebSocket 长连接更简单
6. JavaScript SDK 已有官方实现可参考

详见 [技术架构 v2](./tech-arch.md) 和 [决策记录](./decisions.md)。

---

## 3. 其他 Agent 通信协议

### 3.1 MCP (Model Context Protocol)

**简介**：Anthropic 推出的开放标准，用于连接 AI 系统与外部数据源/工具。

**核心特点：**
- 客户端-服务器架构
- 基于 JSON-RPC 2.0
- 资源、提示词、工具三类原语

**适用性分析：**
| 维度 | 评估 |
|-----|------|
| 设计目标 | 工具/数据源接入，非 Agent 间通信 |
| 通信模式 | 请求-响应，无持续会话 |
| 匹配度 | ⭐⭐ 不适合直接 Agent 对话 |

**结论**：MCP 更适合作为 Agent 的工具扩展协议，而非 Agent 间通信协议。

### 3.2 LangChain Agent 协作

**简介**：LangChain 提供多种 Agent 协作模式：
- `AgentExecutor`：单 Agent 运行
- `Multi-Agent`：多 Agent 编排（如 Supervisor、Hierarchical）

**架构示例：**
```python
# LangGraph Multi-Agent
from langgraph.graph import StateGraph

builder = StateGraph(State)
builder.add_node("researcher", research_agent)
builder.add_node("writer", writer_agent)
builder.add_edge("researcher", "writer")
```

**适用性分析：**
| 维度 | 评估 |
|-----|------|
| 运行环境 | 同一进程/代码库内 |
| 跨机器 | 不支持原生分布式 |
| 匹配度 | ⭐⭐ 适合单用户多 Agent，不适合跨用户 |

**结论**：LangChain 的协作机制是代码层面的编排，非网络通信协议。

### 3.3 AutoGen Agent 通信

**简介**：微软开源的多 Agent 对话框架。

**通信模式：**
- **ConversableAgent**：基于消息的对话
- **GroupChat**：多 Agent 群组讨论
- **CodeExecutor**：代码执行隔离

**关键特性：**
```python
# AutoGen 的代理通信
assistant = ConversableAgent("assistant")
user_proxy = UserProxyAgent("user")

# 启动对话
user_proxy.initiate_chat(assistant, message="Help me...")
```

**适用性分析：**
| 维度 | 评估 |
|-----|------|
| 通信方式 | 内存消息队列 |
| 跨进程 | 支持（需配置） |
| 跨用户 | 无原生支持 |
| 匹配度 | ⭐⭐⭐ 架构可参考，但需自建传输层 |

**可借鉴点：**
- Agent 角色定义模式
- 消息路由机制
- 人类介入触发器设计

### 3.4 协议对比总结

| 协议 | 定位 | 跨用户 | 复杂度 | 成熟度 |
|-----|------|-------|--------|--------|
| Google A2A | 企业级互操作 | ✅ | 高 | 新兴 |
| MCP | 工具接入 | ❌ | 中 | 新兴 |
| LangChain | 编排框架 | ❌ | 低 | 成熟 |
| AutoGen | 多 Agent 对话 | ⚠️ | 中 | 成熟 |

~~**结论**：现有协议均不完全匹配需求，需自建轻量级方案。~~

**2026-03-08 更新结论**：Google A2A 协议已成熟，且完全匹配跨平台 Agent 互操作需求，决定采用 A2A 作为核心协议。详见 [决策记录](./decisions.md)。

---

## 4. P2P 通信方案

### 4.1 WebRTC (Web Real-Time Communication)

#### 技术概述

WebRTC 是浏览器原生支持的实时通信技术，包含三大核心组件：
- **MediaStream**：音视频捕获
- **RTCPeerConnection**：P2P 连接管理
- **RTCDataChannel**：任意数据传输

#### DataChannel 特性

```javascript
// WebRTC DataChannel 示例
const pc = new RTCPeerConnection({
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
});

const channel = pc.createDataChannel('a2a', {
  ordered: true,        // 有序传输
  maxRetransmits: 3     // 重传次数
});

channel.onmessage = (event) => {
  const message = JSON.parse(event.data);
  handleMessage(message);
};
```

#### 连接建立流程

```
Agent A                          Agent B
  │                                │
  ├── createOffer() ──────────────→│
  │←─────────────── createAnswer()─┤
  │                                │
  ├── ICE candidates ─────────────→│
  │←────────────── ICE candidates ─┤
  │                                │
  ════════ DTLS Handshake ═════════
  ════════ SCTP Association ═══════
  │                                │
  ◄──────── DataChannel Open ─────►
```

#### NAT 穿透成功率

| 场景 | 成功率 | 说明 |
|-----|-------|------|
| 双方公网 | 100% | 直接连接 |
| 一方 NAT | ~85% | STUN 通常可打洞 |
| 双方 NAT (对称型) | ~40% | 可能需要 TURN |
| 企业防火墙 | ~30% | 可能阻断 UDP |

#### 优缺点

| 优点 | 缺点 |
|-----|------|
| 真正的 P2P，延迟最低 | 打洞复杂，成功率非 100% |
| 浏览器/Node.js 原生支持 | 需要信令服务器协调 |
| DataChannel 支持任意数据 | 连接建立时间较长（1-3s） |
| 内置 DTLS 加密 | 企业网络可能阻断 |

### 4.2 Libp2p

#### 技术概述

Libp2p 是 Protocol Labs 开发的模块化 P2P 网络栈，IPFS 基于此构建。

#### 核心模块

```javascript
// Libp2p 配置示例
import { createLibp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';

const node = await createLibp2p({
  transports: [webSockets()],
  connectionEncryption: [noise()],
  streamMuxers: [yamux()],
});

// 监听协议
await node.handle('/a2a/1.0.0', ({ stream }) => {
  pipe(stream.source, async function (source) {
    for await (const msg of source) {
      console.log('Received:', msg);
    }
  });
});
```

#### 关键特性

| 特性 | 说明 |
|-----|------|
| 多传输 | TCP, UDP, WebSocket, WebRTC 等 |
| 内容路由 | DHT 发现 |
| NAT 穿透 | 自动 STUN/TURN/中继 |
| 身份系统 | 基于公钥的 PeerID |

#### 适用性评估

| 维度 | 评分 | 说明 |
|-----|------|------|
| 功能丰富度 | ⭐⭐⭐⭐⭐ | 企业级 P2P 栈 |
| 易用性 | ⭐⭐⭐ | 学习曲线陡峭 |
| 包体积 | ⭐⭐ | 约 500KB+ (browser) |
| 匹配度 | ⭐⭐⭐ | 功能过剩，过于复杂 |

**结论**：Libp2p 适合大规模 P2P 应用，对于简单 A2A 通信过于重型。

### 4.3 其他 P2P 方案

| 方案 | 特点 | 适用性 |
|-----|------|--------|
| **Simple-Peer** | WebRTC 简化封装 | ⭐⭐⭐⭐ 适合快速原型 |
| **PeerJS** | 带免费云服务 | ⭐⭐⭐ 依赖第三方 |
| **Socket.io P2P** | Socket.io 的 P2P 扩展 | ⭐⭐⭐ 已停止维护 |
| **NKN** | 区块链 P2P 网络 | ⭐⭐ 过度设计 |

### 4.4 NAT 穿透方案详解

#### STUN (Session Traversal Utilities for NAT)

```
Agent A (NAT后)          STUN Server          Agent B (NAT后)
    │                        │                      │
    ├── getPublicAddr() ────→│                      │
    │←──── return 1.2.3.4 ────┤                      │
    │                                               │
    │         通过信令交换公网地址                     │
    │◄──────────────────────────────────────────────→│
    │                                               │
    ═════════════ Direct P2P Connection ═════════════
```

**公共 STUN 服务器：**
- `stun:stun.l.google.com:19302`
- `stun:stun.cloudflare.com:3478`
- `stun:openrelay.metered.ca:80`

#### TURN (Traversal Using Relays around NAT)

当 STUN 失败时，通过中继转发：

```
Agent A ←──────── TURN Server ────────→ Agent B
         (Relay, 增加延迟和成本)
```

**免费 TURN 选项：**
- Metered.ca：每月免费 50GB
- Twilio：试用额度
- 自建：coturn 服务器 ($5/月 VPS)

#### 穿透策略建议

```
尝试顺序：
1. STUN 直连 (免费，延迟最低)
2. TURN 中继 (付费或自建，可靠性最高)
3. 回退到 WebSocket 中继 (MVP 阶段推荐)
```

### 4.5 P2P 方案对比

| 方案 | 延迟 | 可靠性 | 复杂度 | 成本 | 推荐场景 |
|-----|------|-------|--------|------|---------|
| WebRTC DataChannel | 最低 | 中 | 中 | 低 | Phase 2 优化 |
| Libp2p | 低 | 高 | 高 | 低 | 大规模去中心化 |
| Simple-Peer | 最低 | 中 | 低 | 低 | 快速原型 |
| WebSocket Relay | 中 | 高 | 低 | 极低 | MVP 首选 |

---

## 5. 端到端加密

### 5.1 密钥交换协议

#### X25519 (Elliptic Curve Diffie-Hellman)

```javascript
// X25519 密钥交换示例
import nacl from 'tweetnacl';

// 每方生成临时密钥对
const aliceKeypair = nacl.box.keyPair();
const bobKeypair = nacl.box.keyPair();

// 共享密钥计算
const aliceShared = nacl.scalarMult(
  aliceKeypair.secretKey,
  bobKeypair.publicKey
);

const bobShared = nacl.scalarMult(
  bobKeypair.secretKey,
  aliceKeypair.publicKey
);

// aliceShared === bobShared
```

**特性：**
- 密钥长度：32 字节
- 计算速度：极快（现代 CPU < 1μs）
- 安全性：128-bit 安全级别
- 前向保密：支持（使用临时密钥）

#### Kyber (CRYSTALS-Kyber)

后量子加密算法，NIST 标准化：

```javascript
// 使用 CRYSTALS-Kyber (通过 wasm 或 native)
import { kyber } from '@noble/post-quantum';

const { publicKey, secretKey } = kyber.keygen();
const { cipherText, sharedSecret } = kyber.encapsulate(publicKey);
const decrypted = kyber.decapsulate(cipherText, secretKey);
```

**对比：**
| 算法 | 密钥大小 | 性能 | 量子安全 | 建议 |
|-----|---------|------|---------|------|
| X25519 | 32B | 极快 | ❌ | MVP 首选 |
| Kyber-768 | 1184B | 快 | ✅ | 未来考虑 |
| X25519+Kyber | 1216B | 快 | ✅ | 混合方案 |

### 5.2 消息加密方案

#### AES-256-GCM

```javascript
import crypto from 'crypto';

function encryptMessage(plaintext, key, nonce) {
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();
  return { encrypted, authTag };
}

function decryptMessage(ciphertext, key, nonce, authTag) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}
```

**参数：**
- Key：32 字节（来自 X25519 共享密钥）
- Nonce：12 字节（每次唯一，可递增）
- Auth Tag：16 字节（完整性校验）

#### ChaCha20-Poly1305

AES-GCM 的替代方案，在移动端更快：

```javascript
const cipher = crypto.createCipheriv(
  'chacha20-poly1305',
  key,
  nonce,
  { authTagLength: 16 }
);
```

### 5.3 前向保密 (PFS) 实现

#### 双棘轮算法 (Double Ratchet)

Signal 协议使用的密钥更新机制：

```
初始握手：X25519 交换根密钥
    ↓
┌─────────────────────────────────────┐
│         Root Chain                  │
│  每次回复生成新密钥对 → 更新链密钥    │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│      Message Chain                  │
│  每条消息派生新消息密钥               │
└─────────────────────────────────────┘
```

**简化版实现（适用于 A2A）：**

```javascript
class SessionCipher {
  constructor(sharedSecret) {
    this.rootKey = sharedSecret;
    this.messageKeys = [];
  }
  
  // 每 N 条消息或每 M 分钟轮换密钥
  rotateKeyIfNeeded() {
    if (this.messageCount > 100 || timeSinceRotation > 300000) {
      this.rootKey = hkdf(this.rootKey, 'rotation');
      this.messageCount = 0;
    }
  }
  
  getMessageKey() {
    this.rotateKeyIfNeeded();
    const messageKey = hkdf(this.rootKey, `msg-${this.messageCount}`);
    this.messageCount++;
    return messageKey;
  }
}
```

### 5.4 身份验证

#### Ed25519 签名

```javascript
import nacl from 'tweetnacl';

// 长期身份密钥（Agent 首次运行时生成）
const identityKeypair = nacl.sign.keyPair();

// 签名消息
function signMessage(message, secretKey) {
  return nacl.sign.detached(
    new TextEncoder().encode(message),
    secretKey
  );
}

// 验证签名
function verifyMessage(message, signature, publicKey) {
  return nacl.sign.detached.verify(
    new TextEncoder().encode(message),
    signature,
    publicKey
  );
}
```

#### 握手流程

```
Agent A                              Agent B
   │                                    │
   ├── IdentityPubKeyA + Signature ───→│
   │                                    │
   │←────── IdentityPubKeyB + Signature─┤
   │                                    │
   ═════ X25519 临时密钥交换 ═══════════
   │                                    │
   ◄════ 双向验证签名，建立加密通道 ═════►
```

### 5.5 加密方案推荐

| 组件 | 推荐算法 | 理由 |
|-----|---------|------|
| 密钥交换 | X25519 | 快速、安全、广泛支持 |
| 对称加密 | AES-256-GCM | 硬件加速，Node.js 原生支持 |
| 签名 | Ed25519 | 紧凑、快速、安全 |
| 密钥派生 | HKDF-SHA256 | 标准 KDF |
| PFS | 简化双棘轮 | 每 100 条消息轮换 |

---

## 6. 基础设施选项

### 6.1 Cloudflare Workers

#### 定价

| 层级 | 请求数 | CPU 时间 | 价格 |
|-----|-------|---------|------|
| Free | 100,000/天 | 10ms/请求 | $0 |
| Paid | 10M/月 | 50ms/请求 | $5/月 |

#### WebSocket 支持

Cloudflare Durable Objects 支持 WebSocket：

```javascript
// Durable Object 作为 WebSocket 协调器
export class A2ARelay {
  constructor(state, env) {
    this.state = state;
    this.sessions = new Map();
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader === 'websocket') {
      const [client, server] = Object.values(new WebSocketPair());
      await this.handleSession(server);
      return new Response(null, { status: 101, webSocket: client });
    }
  }

  async handleSession(ws) {
    ws.accept();
    ws.addEventListener('message', async (msg) => {
      // 转发给对端
      const peer = this.getPeer(ws);
      peer.send(msg.data);
    });
  }
}
```

#### 优缺点

| 优点 | 缺点 |
|-----|------|
| 全球边缘节点，延迟低 | Free 计划有日限额 |
| 零运维，自动扩缩容 | Durable Objects 有冷启动 |
| 免费额度充足 | 调试相对困难 |
| 内置 DDoS 防护 | 长时间连接有限制 |

**成本估算（MVP）：$0/月**

### 6.2 Fly.io

#### 定价

| 规格 | CPU | 内存 | 价格 |
|-----|-----|------|------|
| shared-cpu-1x | 1x | 256MB | $1.94/月 |
| shared-cpu-2x | 2x | 512MB | $3.88/月 |
| dedicated-cpu-1x | 1x | 2GB | $31.87/月 |

加上带宽：$0.02/GB（出站）

#### 部署示例

```dockerfile
# Dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]
```

```yaml
# fly.toml
app = "a2a-relay"
primary_region = "hkg"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = false
  auto_start_machines = true

[[services]]
  protocol = "tcp"
  internal_port = 8080
  
  [[services.ports]]
    port = 80
    handlers = ["http"]
  
  [[services.ports]]
    port = 443
    handlers = ["tls", "http"]
```

#### 优缺点

| 优点 | 缺点 |
|-----|------|
| 原生 WebSocket 支持 | 需要一定运维知识 |
| Docker 部署简单 | 需要信用卡 |
| 就近调度，延迟低 | 超出免费额度后计费 |
| 持久化存储可选 |

**成本估算（MVP）：$2-5/月**

### 6.3 自建 VPS

#### 推荐配置

| 用途 | 配置 | 价格 |
|-----|------|------|
| 轻量中继 | 1核1G | $3-5/月 |
| 生产环境 | 2核2G | $10-15/月 |

#### 推荐厂商

- **Vultr**：$5/月，按小时计费
- **Linode**：$5/月，稳定可靠
- **DigitalOcean**：$6/月，生态丰富
- **Hetzner**：€4.51/月，欧洲低价

#### 部署架构

```
┌─────────────────────────────────────┐
│           VPS (Ubuntu 22.04)        │
│  ┌─────────────────────────────┐   │
│  │      Nginx (SSL/TLS)        │   │
│  │    - 反向代理                │   │
│  │    - 负载均衡                │   │
│  └─────────────────────────────┘   │
│              ↓                      │
│  ┌─────────────────────────────┐   │
│  │    Node.js Relay Server     │   │
│  │    - WebSocket 处理          │   │
│  │    - 连接码管理              │   │
│  │    - 消息转发                │   │
│  └─────────────────────────────┘   │
│              ↓                      │
│  ┌─────────────────────────────┐   │
│  │       Redis (可选)           │   │
│  │    - 会话状态缓存            │   │
│  │    - 连接码过期              │   │
│  └─────────────────────────────┘   │
└─────────────────────────────────────┘
```

#### 优缺点

| 优点 | 缺点 |
|-----|------|
| 完全控制 | 需要运维投入 |
| 数据自主 | 单点故障风险 |
| 长期成本低 | 安全责任自负 |
| 可深度定制 | 需要监控告警 |

**成本估算（MVP）：$5/月**

### 6.4 Serverless 数据库/KV 存储

#### Cloudflare KV

```javascript
// 存储会话元数据
await env.A2A_KV.put(`session:${code}`, JSON.stringify({
  creator: 'alice@example.com',
  createdAt: Date.now(),
  expiresAt: Date.now() + 600000
}), { expirationTtl: 600 });
```

**定价**：Free 计划 1GB 存储，10M 读/天，1M 写/天

#### Upstash Redis

```javascript
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_URL,
  token: process.env.UPSTASH_REDIS_TOKEN
});

// 设置带过期时间的连接码
await redis.setex(`a2a:code:${code}`, 600, sessionId);
```

**定价**：Free 计划 10,000 命令/天

#### 对比

| 服务 | 免费额度 | 适用场景 |
|-----|---------|---------|
| Cloudflare KV | 1GB, 10M 读/天 | 会话元数据 |
| Upstash Redis | 10K 命令/天 | 连接码临时存储 |
| Fly.io Postgres | 3GB (sidecar) | 持久化历史记录 |

### 6.5 基础设施对比表

| 选项 | 月成本 | 运维负担 | 可靠性 | 扩展性 | 推荐度 |
|-----|-------|---------|--------|--------|--------|
| Cloudflare Workers | $0 | 无 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| Fly.io | $2-5 | 低 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| 自建 VPS | $5 | 中 | ⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ |
| AWS Lambda | $0-10 | 低 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ |

---

## 7. 综合对比与推荐

### 7.1 各维度评分汇总

| 方案 | 安全性 | 可靠性 | 成本 | 复杂度 | 开发周期 | 总分 |
|-----|-------|-------|------|--------|---------|------|
| **WebSocket + CF Workers** | 4 | 4 | 5 | 5 | 5 | **23** |
| WebRTC P2P | 5 | 3 | 5 | 3 | 3 | 19 |
| Google A2A | 4 | 4 | 3 | 2 | 2 | 15 |
| Libp2p | 5 | 4 | 4 | 2 | 2 | 17 |
| 自建 VPS | 4 | 3 | 4 | 3 | 3 | 17 |

*评分：1-5，5 为最佳*

### 7.2 推荐方案（⚠️ 以下为旧方案，已被 v2 架构替代）

> 2026-03-08 更新：MVP 架构已切换到基于 A2A 协议的方案。
> 详见 [技术架构 v2](./tech-arch.md)。

#### MVP 阶段（旧方案）

```
┌─────────────────────────────────────────────────────────┐
│                    推荐架构                              │
├─────────────────────────────────────────────────────────┤
│                                                         │
│   [Agent A] ←──WebSocket──→ [Cloudflare Workers]        │
│      ↑                           (Durable Objects)      │
│   E2EE (X25519+AES)                ↓                    │
│      ↑                      信令转发/连接码管理          │
│   [Agent B] ←──WebSocket───────┘                        │
│                                                         │
│   本地存储：~/.openclaw/a2a/sessions/                   │
│   身份密钥：Ed25519 (首次生成)                           │
│   会话密钥：X25519 临时密钥 (每次会话)                    │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**关键决策：**
1. **传输层**：WebSocket over HTTPS（简单可靠）
2. **基础设施**：Cloudflare Workers（免费、全球、零运维）
3. **加密**：X25519 密钥交换 + AES-256-GCM 加密
4. **身份**：Ed25519 自签名（不依赖 OAuth）

#### Phase 2 优化

添加 WebRTC DataChannel 作为可选传输：

```
Agent A ←──── WebRTC (尝试) ────→ Agent B
   ↓              ↓                  ↓
成功：P2P直连    失败：回退到 WebSocket Relay
```

#### Phase 3 去中心化

- 基于 DHT 的 Agent 发现
- 社区中继节点网络
- 可选的区块链身份锚定

### 7.3 架构图（文字描述）

```
┌──────────────────────────────────────────────────────────────┐
│                         客户端层                              │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐      │
│  │  OpenClaw   │    │  OpenClaw   │    │  OpenClaw   │      │
│  │   Agent A   │    │   Agent B   │    │   Agent C   │      │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘      │
│         │                  │                  │              │
│         └──────────────────┼──────────────────┘              │
│                            │                                 │
│                    WebSocket/WSS                             │
└────────────────────────────┼─────────────────────────────────┘
                             │
┌────────────────────────────┼─────────────────────────────────┐
│                      边缘网络层 (CF Workers)                  │
│                            │                                 │
│         ┌──────────────────┴──────────────────┐              │
│         ↓                                     ↓              │
│  ┌─────────────┐                    ┌─────────────────┐      │
│  │  HTTP Router │                   │  Durable Object │      │
│  │  /api/*     │──────────────────→│  Session Relay  │      │
│  └─────────────┘                    └─────────────────┘      │
│                                              ↓               │
│                                       WebSocket 转发         │
│                                       (仅转发密文)            │
└──────────────────────────────────────────────────────────────┘
                             │
                             ↓ 加密流量（服务器不可读）
┌──────────────────────────────────────────────────────────────┐
│                       数据存储层                              │
│                                                              │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐      │
│  │  Cloudflare │    │   Local     │    │  Optional   │      │
│  │     KV      │    │   Storage   │    │   Export    │      │
│  │ (连接码映射) │    │ (会话历史)   │    │ (经验分享)   │      │
│  └─────────────┘    └─────────────┘    └─────────────┘      │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 7.4 风险提示与规避

| 风险 | 影响 | 概率 | 规避方法 |
|-----|------|------|---------|
| **WebSocket 被企业防火墙阻断** | 高 | 中 | 提供 HTTP 长轮询 fallback |
| **Cloudflare 服务中断** | 高 | 低 | 准备 Fly.io 备用部署 |
| **密钥泄露** | 高 | 低 | 本地加密存储，定期轮换 |
| **中间人攻击** | 中 | 低 | 证书固定 + 签名验证 |
| **会话劫持** | 中 | 低 | 短有效期连接码 + 绑定 IP |
| **消息丢失** | 中 | 中 | 客户端 ACK 机制 + 重试 |
| **存储超限** | 低 | 中 | 自动清理过期会话 |

### 7.5 开发里程碑（修订版）

| 周次 | 目标 | 关键技术 |
|-----|------|---------|
| Week 1 | 信令服务 | CF Workers + Durable Objects |
| Week 2 | 加密握手 | X25519 + Ed25519 |
| Week 3 | OpenClaw Skill | 工具封装 + 本地存储 |
| Week 4 | 官网 + 文档 | 落地页 + 接入指南 |
| Week 5 | 测试优化 | 压力测试 + 边界 case |
| Week 6 | 发布准备 | 安全审计 + 演示视频 |

---

## 8. 附录

### 8.1 参考资源

- [Google A2A 协议规范](https://google.github.io/A2A/)
- [WebRTC 官方文档](https://webrtc.org/getting-started/overview)
- [Libp2p 文档](https://docs.libp2p.io/)
- [Signal 协议规范](https://signal.org/docs/)
- [Cloudflare Workers 定价](https://workers.cloudflare.com/pricing)

### 8.2 术语表

| 术语 | 解释 |
|-----|------|
| A2A | Agent-to-Agent，Agent 间通信 |
| E2EE | End-to-End Encryption，端到端加密 |
| PFS | Perfect Forward Secrecy，完美前向保密 |
| STUN | Session Traversal Utilities for NAT |
| TURN | Traversal Using Relays around NAT |
| DHT | Distributed Hash Table，分布式哈希表 |
| MVP | Minimum Viable Product，最小可行产品 |

### 8.3 决策记录

| 日期 | 决策 | 理由 |
|-----|------|------|
| 2025-01 | 使用 WebSocket 而非 WebRTC | MVP 简单优先，后续可升级 |
| 2025-01 | 选择 Cloudflare Workers | 免费、全球、零运维 |
| 2025-01 | X25519+AES 加密方案 | 成熟、快速、广泛支持 |
| 2025-01 | 自托管 Ed25519 身份 | 不依赖第三方 OAuth |

---

*以上为 2025-01 初始调研内容。以下为 2026-03-08 补充调研。*

---

## 9. 2026-03 补充调研：多 Agent 框架对比

### 9.1 调研背景

需求变更：从"仅支持 OpenClaw"扩展为"OpenClaw 优先，兼容 Claude Code、CodeEx 等"。需要重新评估通信协议选型。

### 9.2 Google A2A 协议深度分析（2025-04 发布后）

A2A 已从"新兴协议"变为"事实标准"：
- **50+ 企业参与**：Google, Salesforce, SAP 等
- **捐给 Linux 基金会**，社区治理
- **SDK 可用**：Python, JavaScript, Java, Go, .NET

#### A2A 核心架构更新

三层架构：
1. **数据模型层**（协议无关）：Task, Message, Part, Artifact, AgentCard
2. **操作层**（抽象）：11 个操作（SendMessage, GetTask, CancelTask 等）
3. **协议绑定**：JSON-RPC 2.0, gRPC, HTTP/REST

#### Agent Card 详细结构

```json
{
  "id": "agent-unique-id",
  "name": "飞书权限助手",
  "description": "擅长诊断和修复飞书 API 权限问题",
  "version": "1.0.0",
  "provider": { "name": "Kenny", "url": "..." },
  "capabilities": {
    "streaming": true,
    "pushNotifications": false,
    "multiTurn": true
  },
  "skills": [
    {
      "id": "feishu-permissions",
      "description": "诊断飞书权限配置问题"
    }
  ],
  "securitySchemes": [
    { "type": "apiKey", "in": "header", "name": "X-API-Key" }
  ]
}
```

#### 三种消息投递模式

| 模式 | 机制 | 适用场景 |
|-----|------|---------|
| **同步** | 请求-响应（blocking: true） | 快速问答 |
| **流式** | SSE（SendStreamingMessage） | 实时对话 |
| **异步推送** | Webhook（Push Notifications） | 长时间任务（小时/天级别） |

#### input-required 状态

A2A 原生支持"Agent 找主人确认"：
```
Task 状态: WORKING → INPUT_REQUIRED → WORKING → COMPLETED
```
- Agent 设状态为 `INPUT_REQUIRED`，附带需要确认的问题
- 客户端收到状态变更，展示给主人
- 主人回复后，发送新 Message 继续 Task

### 9.3 各框架跨用户协作能力对比

| 框架 | 跨用户支持 | 人类介入 | 通信模式 | 适合我们吗？ |
|-----|-----------|---------|---------|------------|
| **Google A2A** | ✅ 专门设计 | input-required | Task + Message | ✅ 最匹配 |
| MCP | ❌ Agent↔Tool | Elicitation | 工具调用 | ❌ 定位不同 |
| AutoGen | ❌ 单进程 | UserProxy | 群组聊天 | ❌ 不跨用户 |
| CrewAI | ❌ 单进程 | human_input 标志 | 角色委派 | ❌ 不跨用户 |
| LangGraph | ❌ 单进程 | Breakpoints | 状态图 | ❌ 不跨用户 |
| OpenAI Swarm | ❌ 实验性 | 基本 | 顺序交接 | ❌ 非生产级 |

**结论**：只有 Google A2A 是为跨用户/跨组织 Agent 协作设计的标准协议。

### 9.4 A2A 的已知限制及解决方案

| 限制 | 影响 | 解决方案 |
|-----|------|---------|
| Client-Server 不对称 | 我们需要双方平等对话 | Gateway 中转，或双方互为 Client/Server |
| 需要公网 HTTP endpoint | 本地 Agent 无法直接暴露 | 通过 Gateway 代理 |
| 无内置端到端加密 | 隐私敏感场景 | Phase 2 在 A2A 之上叠加 E2EE 层 |
| 无连接码/链接机制 | 我们需要简单建联 | 自建 Gateway 提供连接码 → 会话路由 |

### 9.5 A2A + MCP 互补关系

```
A2A: Agent ←→ Agent（横向，跨用户协作）
MCP: Agent ←→ Tool（纵向，能力扩展）
```

- Agent 用 **MCP** 连接自己的工具和数据源
- Agent 用 **A2A** 与其他 Agent 协作
- 两者不冲突，可同时使用

### 9.6 最终结论

**采用 Google A2A 作为核心通信协议**，通过自建 Gateway 补充连接码/链接机制和本地 Agent 代理能力。

详细架构见 [技术架构 v2](./tech-arch.md)。
