<p align="center">
  <img src="docs/logo.png" alt="ew-o1 logo" width="128" height="128" />
</p>

# Electronic Writer 01 (ew-o1)

一个类 NotebookLM 的 AI 写作工具，特化用于尼尔·盖曼的「园丁法」(Gardening Method) 创作流程。

支持自带 AI Key、多对话流管理，帮助写作者像园丁一样培育故事——播种灵感、观察生长、修剪枝叶。

## 技术栈

- **运行时**: Cloudflare Workers (D1 + R2 + AI Gateway + AI Search)
- **框架**: Hono + Vite SSR + React 19
- **路由**: TanStack Router (文件路由 + SSR)
- **AI**: Vercel AI SDK (`ai` + `@ai-sdk/react`) + Cloudflare AI Gateway
- **样式**: Tailwind CSS v4
- **数据库**: Drizzle ORM + D1 (SQLite)
- **Monorepo**: Nx + pnpm workspaces

## 快速开始

```bash
# 安装依赖
pnpm install

# 启动开发服务器
pnpm dev

# 构建
pnpm build

# 部署到 Cloudflare Workers
pnpm deploy
```

## 配置

复制环境变量模板：

```bash
cp .env.example .env
```

在 `apps/web/wrangler.toml` 中填入你的 Cloudflare 资源 ID，然后设置密钥：

```bash
cd apps/web
wrangler secret put OPENAI_API_KEY
```

## 项目结构

```
ew-o1/
├── apps/web/              # 主应用 (Hono + Vite SSR + CF Worker)
│   ├── src/
│   │   ├── main.tsx       # Worker 入口
│   │   ├── server/        # API 路由 + SSR
│   │   └── client/        # React 客户端
│   └── wrangler.toml      # Cloudflare 绑定配置
├── libs/
│   ├── db/                # Drizzle schema (D1)
│   └── utils/             # 共享工具
├── drizzle/               # 数据库迁移
├── nx.json                # Nx 配置
└── biome.json             # Lint + Format
```

## 常用命令

| 命令 | 说明 |
|------|------|
| `pnpm dev` | 启动开发服务器 |
| `pnpm build` | 构建所有应用 |
| `pnpm deploy` | 部署到 Cloudflare |
| `pnpm lint` | 代码检查 |
| `pnpm drizzle generate` | 生成数据库迁移 |
| `pnpm drizzle migrate` | 执行迁移 |

## License

本项目采用双许可证发布：

- [MIT License](./LICENSE-MIT)
- [Apache License 2.0](./LICENSE-APACHE)

你可以选择其中任一许可证使用本项目。
