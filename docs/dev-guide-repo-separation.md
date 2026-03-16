# 公私仓库分离 — 开发指南

## 仓库结构

| 仓库 | 地址 | 权限 | 用途 |
|------|------|------|------|
| agentslink-private | github.com/kennyzheng-builds/agentslink-private | 私有 | 开发主仓库，包含所有代码 |
| agentslink | github.com/kennyzheng-builds/agentslink | 公开 | 开源镜像，不含 admin/analytics |

**所有开发在私有仓库进行。** 公开仓库由 GitHub Actions 自动同步，不要直接向公开仓库提交。

## Git Remotes

```
origin  → https://github.com/kennyzheng-builds/agentslink-private.git  (日常推送)
public  → https://github.com/kennyzheng-builds/agentslink.git          (仅自动同步用)
```

## 推送流程

```bash
# 日常开发：只推送到私有仓库
git push origin main

# 推送后 GitHub Actions 自动执行：
# 1. 运行 build-public.js 剥离私有代码
# 2. 把干净版本 force-push 到公开仓库
```

**不需要手动推送到 public remote。** 只要 push 到 origin，Actions 会自动同步。

## 私有代码标记

在 `.js` 文件中，用以下标记保护私有代码：

### 块标记（多行）

```javascript
// #region private
const ADMIN_PASSWORD_HASH = '...';
const SESSION_SECRET = '...';
// #endregion private
```

构建时整个块（含标记行）被移除。

### 行标记（单行）

```javascript
trackEvent(env, 'create', request, from); // #private
```

构建时整行被移除。

## 哪些内容是私有的

当前被标记为私有的内容：
- 管理后台常量（密码 hash、session secret）
- 管理后台路由（`/admin/*`）
- Session 和 Analytics 相关辅助函数（`trackEvent`、`hashIP`、`verifySession` 等）
- 管理后台页面渲染函数（`renderLoginPage`、`renderAdminDashboard`）
- API 路由中的 `trackEvent()` 调用

## 构建脚本

`scripts/build-public.js` 的行为：

1. 把项目复制到 `dist/public/`
2. 对所有 `.js` 文件剥离 `// #region private` 块和 `// #private` 行
3. 跳过以下文件/目录：`.git`、`.wrangler`、`dist`、`node_modules`、`scripts`、`.github`、`PRIVATE-NOTES.md`
4. 验证输出中不含泄漏关键词（`ADMIN_PASSWORD_HASH`、`SESSION_SECRET`、`trackEvent` 等）

## 部署（Cloudflare Worker）

```bash
# 需要设置环境变量
export CLOUDFLARE_API_TOKEN="your-token"

# 执行部署（3 步）
bash worker/deploy.sh
```

部署脚本做 3 件事：
1. `npx wrangler deploy` — 部署 Worker 代码
2. 上传 `website-v2/index.html` 到 KV（key: `site:home`）
3. 上传 `skills/agents-link/SKILL.md` 到 KV（key: `skill:latest`）

## 新增私有代码时的注意事项

- 新增的私有代码**必须**用 `// #region private` / `// #endregion private` 包裹
- 单行私有代码可在行尾加 `// #private`
- 不加标记的代码会被同步到公开仓库
- `PRIVATE-NOTES.md` 已在排除列表中，不会同步

## 新增需排除的文件

如果新增了不应同步到公开仓库的文件（非 `.js`，无法用行内标记处理），需要在 `scripts/build-public.js` 的 `EXCLUDE` 集合中添加：

```javascript
const EXCLUDE = new Set([
  '.git',
  '.wrangler',
  'dist',
  'node_modules',
  'scripts',
  '.github',
  'PRIVATE-NOTES.md',
  // 在这里添加新的排除项
]);
```
