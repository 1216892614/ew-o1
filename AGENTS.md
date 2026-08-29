# ew-o1

NotebookLM 风格的 AI 知识工作空间。用户上传/编辑文档，AI 以 agent 方式深度阅读、搜索、修改文档，支持联网检索。

## 核心概念 — Notebook

项目最大单位是 **notebook**。一个 notebook 对应 R2 上的一个目录：

```
docs/{notebook_name}/
  ew-o1.toml              # notebook 元信息 + 文件注册表
  {filename}.md           # markdown 文件
  .chat/
    {session_id}.jsonl    # chat session 记录
```

### 元信息 (ew-o1.toml)

```toml
[meta]
name = "研究笔记"
description = "关于 LLM 的阅读记录"
color = "#6366f1"
icon = "notebook"
updated_at = 2025-06-15T08:30:00Z

[[files]]
filename = "transformer-paper.md"
id = "f_abc123"
tag = "论文"

[[files]]
filename = "attention-notes.md"
id = "f_def456"
tag = "笔记"
```

元信息字段：
- **name** — notebook 显示名称
- **description** — 描述
- **color** — 主题色
- **icon** — 图标标识
- **updated_at** — 最后编辑时间

文件注册 (`[[files]]` array)：
- **filename** — 文件名 (对应目录下的 .md 文件)
- **id** — 生成的唯一文件 ID，用于所有 API 引用
- **tag** — 文件分类类型 (无 tag 归入"未分类")

## 产品布局

```
┌─────────────┬────────────────────────┬───────────────────┐
│  File Panel │     Agent Chat         │   Monaco Editor   │
│  (左侧)     │     (中间)              │   (右侧，按需)     │
├─────────────┼────────────────────────┼───────────────────┤
│ • 文件目录树  │ • 持久化多轮 agent 会话 │ • 文件内容编辑     │
│ • 批量操作    │ • 流式输出 + 工具调用   │ • 语法高亮        │
│ • active 开关 │ • 工具结果内嵌展示      │ • 行号 + diff     │
│   选择注入会话 │ • 多 session 切换      │                   │
└─────────────┴────────────────────────┴───────────────────┘
```

- **File Panel**: 目录树，每个文件有 active switch 控制是否注入当前会话上下文。支持批量勾选/反选、拖拽排序。
- **Agent Chat**: 中心区域，持久化 agent 对话。服务端 TanStack AI `generate()` + tool loop，客户端 TanStack Virtual 虚拟滚动 + Streamdown 流式 Markdown 渲染。
- **Monaco Editor**: 右侧按需展开，编辑选中文件。

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 服务端 AI | `@tanstack/ai` + adapters | `generate()`, tool calling, `maxIterations` agent loop |
| 流式 Markdown | `streamdown` | 流式 Markdown 渲染，支持代码高亮、数学公式 |
| 虚拟滚动 | `@tanstack/react-virtual` | 对话消息列表虚拟化 |
| 前端框架 | React 19 + TanStack Router | SPA, file-based routing |
| 数据请求 | `@tanstack/react-query` + tRPC | 类型安全 RPC + 缓存 |
| 样式 | Tailwind CSS 4 + daisyUI 5 | utility-first + component classes |
| 拖拽 | `@dnd-kit/core` + `@dnd-kit/sortable` | 文件排序、批量操作 |
| 编辑器 | `@monaco-editor/react` | 文件内容编辑 |
| 状态管理 | jotai | atom-based, 无 Context |
| ORM | drizzle-orm (D1 adapter) | schema + migrations |
| 存储 | Cloudflare R2 | 文件持久化主载体 |
| 数据库 | Cloudflare D1 | 热缓存 + 元数据 |
| RAG | Cloudflare AI Search | 文件全文检索、语义搜索 |
| 网页阅读 | Cloudflare Browser Rendering | markdown 模式 |
| 运行时 | Cloudflare Workers | Hono server |

### AI 架构说明

```
客户端                              服务端
─────────────────────              ──────────────────────
React + fetch SSE                   Hono /api/chat
  Streamdown (流式 md 渲染)            ↓
  tree path 解析 + leaf 导航        ChatSessionDO (Durable Object)
              ←─── SSE ───→          @tanstack/ai chat()
                                     tools + maxIterations(5)
                                     openai adapter → dogapi.cc/deepseek
                                     SQLite 树形节点存储 (热缓存)
                                     → R2 JSONL 持久化 (冷存储)
```

- **Durable Object**: `ChatSessionDO` — 每个 session 一个实例，SQLite `nodes` 表存储树形消息，`chat()` 生成流式回复，完成后 flush 到 R2
- **服务端**: `@tanstack/ai` 的 `chat()` + `toolDefinition()` + `maxIterations(5)` 实现 agent loop，`toServerSentEventsResponse()` 转 SSE
- **客户端**: fetch SSE → 解析 `TEXT_MESSAGE_CONTENT` delta → React state → Streamdown 渲染 markdown
- **模型路由**: DeepSeek 模型 → AI Gateway → DeepSeek API; 其他 → dogapi.cc (OpenAI 兼容)

### 对话树结构

消息以树形结构存储，每个节点有 `parentId` 指向父节点：

```
null
 └─ UserNode (id=u1, parentId=null)  "你好"
     ├─ AssistantNode (id=a1, parentId=u1)  "你好！"
     │   └─ UserNode (id=u2, parentId=a1)  "继续"
     │       └─ AssistantNode (id=a2, parentId=u2)  "好的..."
     └─ AssistantNode (id=a3, parentId=u1)  "嗨！" (retry 版本)
```

- **UserNode**: 记录用户输入 + 使用的模型/参数快照
- **AssistantNode**: 记录完整 agent loop timeline (thinking, tool_call, text)
- **版本切换**: 同一 parentId 下的同 role 兄弟节点 = 版本 (编辑/重试)
- **路径解析**: 从 leaf 节点向上回溯到 root 得到一条对话路径
- **默认分支**: 无 leaf 指定时取最新分支 (每层最右子节点)

共享类型定义: `apps/web/src/shared/chat-types.ts`

路由: `/notebook/$id?leaf=<nanoid>` — leaf 参数定位对话分支

### 持久化模型

| 层 | 存储 | 角色 |
|---|---|---|
| DO SQLite `nodes` 表 | Durable Object | 热缓存，实时读写 |
| R2 `.chat/{sessionId}.jsonl` | R2 Bucket | 冷存储，agent loop 完成后整体写入 |
| D1 `sessions` 表 | D1 Database | session 元信息 (name, model, lastMessageAt) |

D1 不存消息体。DO SQLite 自动从旧 `messages` 表迁移到 `nodes` 表。

### 已安装 Skills

| Skill | 用途 | 路径 |
|-------|------|------|
| `tanstack-ai` | 服务端 agent loop | `.agents/skills/tanstack-ai/` |
| `tanstack-virtual` | 虚拟滚动 | `.agents/skills/tanstack-virtual/` |
| `tanstack-query` | 数据请求 + 缓存 | `.agents/skills/tanstack-query/` |
| `streamdown` | 流式 Markdown 渲染 | `.agents/skills/streamdown/` |
| `trpc` | 类型安全 RPC | `.agents/skills/trpc/` |
| `daisyui` | UI 组件库 | `.agents/skills/daisyui/` |
| `jotai` | 状态管理 | `.agents/skills/jotai/` |
| `tanstack-router` | 路由 | `.agents/skills/tanstack-router/` |

**规则**: 实现前必须加载对应 skill，查阅 API 签名。不自造已有 skill 覆盖的功能。

## Agent 工具定义

服务端 agent loop 支持以下工具，通过 TanStack AI `tools` 配置注册：

### search_file

通过文件内容（仅 active 文件）或文件名搜索文件。

**参数**: `{ query: string, mode?: "content" | "name" }`

**返回**: 搜索结果列表
```ts
{
  results: Array<{
    file_id: string
    filename: string
    summary: string   // content 模式: 匹配 chunk; name 模式: 文件开头
    relevance?: number
  }>
}
```

**实现**: content 模式走 AI Search binding; name 模式走 D1 LIKE 查询。

### read_file

通过 file_id 阅读文件。不传行号返回元信息 + 开头；传行号 range 返回对应内容。

**参数**: `{ file_id: string, line_start?: number, line_end?: number }`

**返回**:
```ts
{
  file_id: string
  filename: string
  total_lines: number
  content: string      // 包含行号前缀
}
```

**约束**: 单次最多返回 200 行。

**副作用**: 每次调用会在 session 上记录该文件的当前 content hash。

### edit_file

修改文件名称和类型。

**参数**: `{ file_id: string, new_filename?: string, new_tag?: string }`

**返回**: `{ success: boolean, file_id: string }`

### edit_content

通过 diff patch 修改文件内容。

**参数**: `{ file_id: string, patches: Array<{ start_line: number, end_line: number, content: string }> }`

**返回**: `{ success: boolean, file_id: string }`

### Hash 校验机制

edit_file 和 edit_content 不接受显式 hash 参数。校验流程：

1. `read_file` 每次调用时，在 session 上记录 `{ file_id → content_hash }`
2. `edit_file` / `edit_content` 执行时，向上查找该 session 中最近一次 `read_file` 记录的 hash
3. 对比当前文件实际 hash — 若不一致，工具调用失败，返回错误提示 agent 需要重新 `read_file`
4. 若 session 中无该文件的 read 记录，同样失败（必须先读后写）

这保证 agent 始终基于最新内容做编辑，防止盲写和冲突。

### web_search

使用 SearXNG + DuckDuckGo 进行网络搜索。

**参数**: `{ query: string, max_results?: number }`

**返回**: `{ results: Array<{ title: string, url: string, snippet: string }> }`

### web_page_read

通过 URL 使用 Cloudflare Browser Rendering (markdown 模式) 阅读页面。

**参数**: `{ url: string }`

**返回**: `{ title: string, content: string }`  (content 为 markdown)

## 数据架构 — D1 热缓存

R2 路径结构见「核心概念」章节。D1 作为热缓存层：

| 表 | 职责 |
|---|---|
| `notebooks` | notebook 元信息镜像 (name, color, icon, description, archived, updated_at) |
| `files` | 文件索引 + 按需缓存的 content，含 dirty 标记 |
| `sessions` | 对话 session 元信息 (name, model_id, model_name, last_message_at) |

对话消息存储在 DO SQLite (热缓存) + R2 `.chat/{session_id}.jsonl` (冷存储)，不存 D1。

### 同步模型

| 操作 | 方向 | 触发 |
|------|------|------|
| 打开 notebook | R2 → D1 | 读 `ew-o1.toml` 同步元信息 + 文件列表 |
| 修改元信息 | D1 → R2 | 写回 `ew-o1.toml` |
| 打开文件 | R2 → D1 | 缓存到 `files.content` |
| 修改文件 | D1 → R2 | 即刻同步 |
| agent loop 完成 | DO SQLite → R2 | 整体 flush 到 `.chat/{session_id}.jsonl` |

### 关键约束

- 空 notebook（无 ew-o1.toml）返回空列表，不报错
- `files.dirty = true` 表示未同步修改
- 删除文件 = 移入"垃圾箱" tag，R2 文件不动
- `notebooks.archived` 仅存 D1，不写回 toml

## Cloudflare 资源

| 资源类型 | 命名 | Binding | 说明 |
|----------|------|---------|------|
| D1 Database | `ew-d1` | `DB` | 主数据库 (id: `e37fe27b-761b-4b79-b1bd-b46e5ebd0323`) |
| R2 Bucket | `ew-r2` | `R2` | 对象存储 |
| AI Gateway | `ew-ai-gateway` | `CF_AI_GATEWAY_ID` | AI 请求网关 |
| AI Search | `ew-ai-search` | `AI_SEARCH` | 语义搜索 |
| Durable Object | `ChatSessionDO` | `CHAT_DO` | 聊天会话状态持久化 |
| Worker | `ew-o1` | — | 主 Worker |
| Browser | — | `BROWSER` | 网页渲染 |
| Workers AI | — | `AI` | 嵌入/生成 |

命名规范:
- **资源名**: `ew-{资源类型简称}` (e.g. `ew-d1`, `ew-r2`)
- **Binding 名**: 大写 SCREAMING_SNAKE (e.g. `CHAT_DO`, `AI_SEARCH`)
- 新增资源一律以 `ew-` 前缀命名，binding 保持语义明确的大写缩写

## Secrets

| Secret | 用途 |
|--------|------|
| `BIGBIGDOG_AI_KEY` | dogapi.cc 多模型 API (Claude/GPT/Grok/MiniMax) |
| `DEEPSEEK_AI_KEY` | DeepSeek 官方 API (经 AI Gateway) |

## 模型路由

通过 `body.model` 字段选择：
- DeepSeek 模型 → DeepSeek API via AI Gateway
- 其他模型 → BigBigDog API (`https://www.dogapi.cc/v1`)

## 代码风格 — Clean Code

- **禁止行间注释** — 代码本身即文档，通过命名表达意图
- **命名详尽** — 变量/函数名称完整描述其职责，不怕长
  - `fetchNotebookFilesFromR2AndSyncToD1` 优于 `syncFiles`
  - `isFileActiveInCurrentSession` 优于 `isActive`
- **小函数组合** — 每个函数只做一件事，通过组合构建复杂逻辑
- **禁止 `any`** (泛型 extends 除外)
- **禁止 `useContext`** — 全局状态用 jotai atom
- **Icons**: 仅限 `@phosphor-icons/react` — 禁止 `lucide-react` 等其他图标库，禁止手写 svg
- **Tooltip**: `react-tooltip` (非 daisyUI)
- **Toast**: `react-hot-toast`
- AI 服务端: `@tanstack/ai` generate + tools（查阅 `.agents/skills/tanstack-ai/`）
- 流式渲染: `streamdown`（查阅 `.agents/skills/streamdown/`）
- 虚拟滚动: `@tanstack/react-virtual`（查阅 `.agents/skills/tanstack-virtual/`）
- 数据请求: tRPC + `@tanstack/react-query`（查阅 `.agents/skills/trpc/`, `.agents/skills/tanstack-query/`）
- **实现前必须加载对应 skill** — 不确定 API 签名时先读 skill 文档，禁止凭记忆编造

## 开发流程

```bash
pnpm dev          # 本地开发
pnpm deploy       # 部署到 Workers
pnpm drizzle      # D1 migration
wrangler secret put <KEY>  # 设置密钥
```
