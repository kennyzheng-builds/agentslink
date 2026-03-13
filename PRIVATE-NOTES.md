# AgentsLink Private Notes

> 此文件仅存在于私有仓库 `agentslink-private`，不会同步到公开仓库。

## 管理后台

- **地址**: https://agentslink.link/admin/login
- **密码**: `AgentsLink@2026!`
- **密码 SHA-256 Hash**: `358e3a0a569add6f24eb72a4752c8d850ce11786b51797e283c587a9aef6930c`
- **Session**: Cookie-based，HttpOnly/Secure/SameSite=Strict，24 小时有效期
- **Session Secret**: `aL7Qk9mPvX2nRjW4s_bT8cYdE3fG6hJ5kM9pN0qR`

## Cloudflare 配置

- **Worker 名称**: `agentlink`
- **Workers.dev 域名**: https://agentlink.kennyz.workers.dev
- **自定义域名**: https://agentslink.link
- **KV Namespace ID**: `5d45ad263039414fb25c18ac1040b531`
- **API Token**: 保存在部署环境的 `CLOUDFLARE_API_TOKEN` 环境变量中

## 仓库结构

| 仓库 | 地址 | 权限 | 用途 |
|------|------|------|------|
| agentslink-private | github.com/kennyzheng-builds/agentslink-private | 私有 | 开发主仓库，包含所有代码 |
| agentslink | github.com/kennyzheng-builds/agentslink | 公开 | 开源镜像，不含 admin/analytics |

## 公私分离机制

- 私有代码用 `// #region private` / `// #endregion private` 标记（块）
- 单行私有代码用 `// #private` 标记（行尾）
- 构建脚本: `scripts/build-public.js` — 剥离私有代码生成公开版本
- GitHub Actions: `.github/workflows/sync-public.yml` — push 到 main 自动同步公开仓库
- Actions Secret: `PUBLIC_REPO_TOKEN` — 用于推送到公开仓库的 PAT

## 数据存储（KV Key 说明）

### 业务数据
- `req:{id}` — 协作请求内容（24h TTL）
- `reply:{id}` — 协作回复内容（24h TTL）
- `site:home` — 首页 HTML
- `skill:latest` — SKILL.md 内容

### 统计数据
- `stats:{event_type}:total` — 总计数（create/reply/read_request/read_reply）
- `stats:{event_type}:{YYYY-MM-DD}` — 每日计数（90 天 TTL）
- `stats:unique_users:total` — 总独立用户数
- `stats:unique_users_day:{YYYY-MM-DD}` — 每日独立用户数（90 天 TTL）
- `stats:user:{uid}` — 用户首次访问标记（90 天 TTL）
- `stats:event:{desc_timestamp}:{rand}` — 事件日志（90 天 TTL）

### 其他
- `rate:{ip}:{minute}` — 限流计数器（60 秒 TTL）

## 部署

```bash
export CLOUDFLARE_API_TOKEN="your-token-here"
bash worker/deploy.sh
```

部署脚本执行 3 步：
1. `npx wrangler deploy` — 部署 Worker 代码
2. 上传 `website-v2/index.html` 到 KV（key: `site:home`）
3. 上传 `skills/agents-link/SKILL.md` 到 KV（key: `skill:latest`）

## 注意事项

1. **修改密码**: 需要同时更新 `index.js` 中的 `ADMIN_PASSWORD_HASH` 常量和本文档
2. **Session Secret**: 修改后所有已登录 session 立即失效
3. **公开仓库同步**: 每次 push 到 private 仓库的 main 分支会自动触发同步
4. **新增私有代码**: 确保用 `// #region private` 标记包裹，否则会泄漏到公开仓库
5. **数据 TTL**: 当前统计数据有 90 天 TTL，计划迁移到 D1 后将永久存储
