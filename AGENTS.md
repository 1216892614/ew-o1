# EW-O1 Agent Instructions

## Cloudflare 资源命名规范

所有 Cloudflare 资源使用 `ew-` 前缀：

| 资源类型 | 命名 | 说明 |
|----------|------|------|
| D1 Database | `ew-d1` | 主数据库 |
| R2 Bucket | `ew-r2` | 对象存储 |
| AI Gateway | `ew-ai-gateway` | AI 请求网关（需在 dashboard 手动创建） |
| AI Search | `ew-ai-search` | AI 搜索实例 |
| Worker | `ew-o1` | 主 Worker |
| KV Namespace | `ew-kv` | 如需 KV 使用此命名 |

命名模板：`ew-{资源类型简称}`

## 已创建资源

- D1: `ew-d1` (id: `e37fe27b-761b-4b79-b1bd-b46e5ebd0323`, region: APAC)
- R2: `ew-r2` (Standard storage class)
- AI Gateway: `ew-ai-gateway` (需在 Cloudflare Dashboard 手动创建)

## Secrets

| Secret | 用途 |
|--------|------|
| `BIGBIGDOG_AI_KEY` | dogapi.cc 多模型 API (Claude/GPT/Grok/MiniMax) |
| `DEEPSEEK_AI_KEY` | DeepSeek 官方 API (经 AI Gateway) |

## 模型路由

`POST /api/chat` 通过 `body.model` 字段选择模型：

- DeepSeek 官方模型 (`deepseek-v4-pro`, `deepseek-v4-flash`, `deepseek-v4-flash-free`) → DeepSeek API via AI Gateway
- 其他所有模型 → BigBigDog API (`https://www.dogapi.cc/v1`)

模型注册表在 `apps/web/src/shared/models.ts`。

## 代码规范

- **禁止使用 `any`**（除非泛型 `extends` 中需要特殊变换，如 `T extends Record<string, any>`）
- **禁止使用 `useContext`** — 全局状态使用 jotai atom，不使用 React Context
- 状态管理: **jotai**（atom-based，SSR/client 两端均需 `<Provider>`）
- ORM: drizzle-orm（D1 adapter）
- 前后端通讯: tRPC（`/trpc/*`）
- AI 流式通讯: Vercel AI SDK Data Stream Protocol（`/api/chat`）

## UI 组件库约定

- **Tooltip**: 使用 `react-tooltip`（非 daisyUI 的 `tooltip` class）
  - 每个区域放一个 `<Tooltip id="xxx" />` 实例，按钮通过 `data-tooltip-id` + `data-tooltip-content` 绑定
  - 必须加 `className="!z-[9999] !text-xs"` 确保层级正确
  - CSS 已在 `__root.tsx` 中全局导入：`import "react-tooltip/dist/react-tooltip.css"`
- **Toast 通知**: 使用 `react-hot-toast`
  - `<Toaster />` 已挂载在 `__root.tsx`，位置 `bottom-center`
  - 使用方式：`import toast from "react-hot-toast"; toast.success("已完成")`
  - 禁止使用 daisyUI 的 `toast` / `alert` 组件做临时通知
- **Icons**: 使用 `@phosphor-icons/react`（https://phosphoricons.com/）
  - 禁止手写 `<svg>` 图标，所有图标必须从 Phosphor 导入
  - 用法：`import { IconName } from "@phosphor-icons/react"`
  - 尺寸用 className `size-4` / `size-5`，权重用 `weight="bold"` / `"fill"` 等

## 数据架构 — R2/D1 同步模型

```
R2 (持久化，源真)              D1 (热缓存 + 本地状态)
─────────────────────          ──────────────────────
docs/                          notebooks 表
  {notebookname}/              files 表
    ew-o1.toml                 (content 列 = 按需加载)
    {filename}.md
```

**R2 路径扁平**: `docs/{notebookname}/{filename}.md`，无 tag 子目录。
Tag/分类仅存在于 `ew-o1.toml` 元数据，无分类归入"未分类"。

### 同步触发时机

| 操作 | 方向 | 说明 |
|------|------|------|
| 打开 notebook | R2 → D1 | 读 `ew-o1.toml` → 同步 notebook 元信息 + 文件列表 |
| 修改 notebook 元信息 | D1 → R2 | 修改 color/icon/description → 写回 `ew-o1.toml` |
| 打开文件 | R2 → D1 | 读 `.md` 内容 → 缓存到 `files.content` |
| 修改文件（确认后） | D1 → R2 | `files.content` 写回 R2 对应 key |

### 仅存在于 D1 的概念（不同步到 R2）

| 概念 | 说明 |
|------|------|
| **notebook 归档** | `notebooks.archived = true`，仅 D1 标记，R2 无感知 |
| **文件删除** | 不真删 R2 文件，仅将 tag 改为"垃圾箱"分类 |

### ew-o1.toml 格式

```toml
[meta]
description = "项目描述"
color = "#6366f1"
icon = "notebook"

[[files]]
filename = "readme.md"
tag = "文档"

[[files]]
filename = "notes.md"
# 没有 tag → 归入"未分类"
```

### 关键约束

- 空 notebook（无 ew-o1.toml）不报错，返回空列表
- 空文件（R2 不存在对应 .md）不报错，返回空字符串
- `files.dirty = true` 表示本地有未同步修改
- 每次确认修改即刻同步回 R2（不做批量延迟）
- `archived` 只存 D1，`ew-o1.toml` 中不含此字段
- 删除文件 = 移入"垃圾箱" tag，R2 文件不动


## 数据架构 — 对话树持久化 (.chat)

```
R2 (冷同步)                          D1 (热写)
─────────────────────                ──────────────────────
docs/{notebookname}/.chat/           chat_trees 表
  {sessionId}.json                   (tree_data JSON blob)
```

### 对话树数据模型

对话是一棵 tree：
- **Node** = 用户输入（nanoid 标识）
- **Track** = LLM 输出（挂载在 node 上）
- 编辑输入 → 创建同级 sibling node（fork）
- 每个 track 持久化: model, temperature, thinkingLevel

URL 路由: `/notebook/$id?session=xxx&leaf=nodeId`
- `leaf` 参数定位到最深处的 node
- 自动修正规则:
  - 无 leaf → 选择最深最后一个 node
  - leaf 不是末端且后续无分叉 → 自动推进到最后
  - leaf 后有分叉 → 保持，各分叉选最后一个

### 同步触发时机

| 事件 | D1 热写 | R2 冷同步 |
|------|---------|-----------|
| 用户输入（node 创建） | ✅ `chatTree.saveTree` | ❌ |
| LLM 输出结束（track 完成） | ✅ `chatTree.saveTree` | ✅ `chatTree.syncToR2` |
| 打开 notebook | ❌ | ✅ `chatTree.syncFromR2` → D1 |

### 压缩（Compression）

- **软压缩**: 汇总早期消息为 system context，原消息保留可查看
- **硬压缩**: 汇总后删除原消息节点，不可恢复
- 压缩记录存储在 session 的 `compressions[]` 数组中
- LLM 构建 messages 时自动应用最新压缩

### D1 表结构 (chat_trees)

| 列 | 类型 | 说明 |
|----|------|------|
| id | TEXT PK | session nanoid |
| notebook_id | TEXT FK | 所属 notebook |
| title | TEXT | 对话标题 |
| model | TEXT | 默认模型 |
| tree_data | TEXT | JSON blob: `{nodes: ChatNode[], compressions: ChatCompression[]}` |
| created_at | INTEGER | 创建时间 |
| updated_at | INTEGER | 最后活动 |
| r2_synced_at | INTEGER | 最后 R2 同步时间 |
| dirty | INTEGER | 是否有未同步修改 |
## tRPC 路由

| 路径 | 方法 | 说明 |
|------|------|------|
| `notebook.list` | query | 列出所有 notebook |
| `notebook.syncFromR2` | mutation | 扫描 R2 发现所有 notebook |
| `notebook.get` | query | 获取单个 notebook |
| `notebook.create` | mutation | 创建 notebook |
| `notebook.open` | mutation | **打开 notebook → R2 同步 manifest** |
| `notebook.update` | mutation | 修改元信息 → 回写 R2 ew-o1.toml |
| `notebook.archive` | mutation | 归档/取消归档（仅 D1） |
| `notebook.delete` | mutation | 删除 notebook |
| `file.list` | query | 列出 notebook 下文件（可按 tag 过滤） |
| `file.read` | query | **打开文件 → R2 拉取到 D1** |
| `file.write` | mutation | 写入文件内容（标记 dirty） |
| `file.sync` | mutation | **确认修改 → D1 回写 R2** |
| `file.create` | mutation | 创建新文件 |
| `file.delete` | mutation | 移入"垃圾箱" tag（不删 R2） |
| `chatTree.list` | query | 列出 notebook 下所有对话 |
| `chatTree.get` | query | 获取完整对话树 |
| `chatTree.create` | mutation | 创建新对话 session |
| `chatTree.saveTree` | mutation | **热写 D1（user input / output finish）** |
| `chatTree.syncToR2` | mutation | **冷同步到 R2** |
| `chatTree.syncFromR2` | mutation | **R2 → D1 恢复对话** |
| `chatTree.delete` | mutation | 删除对话（含 R2） |


## AI Search 集成

每个 notebook 有独立的 AI Search 实例（Workers binding），用于全文检索文件内容。

### 绑定配置

```toml
[[ai_search_namespaces]]
binding = "AI_SEARCH"
namespace = "default"
remote = true
```

### 索引时机

| 事件 | 动作 |
|------|------|
| `notebook.open` | 索引所有未索引的非归档文件 |
| `file.sync` | 重新索引该文件（删旧建新） |
| `file.delete` | 从索引移除 |

### ChatSession DO — Function Calling

ChatSession 支持多轮工具调用：

| 工具 | 描述 |
|------|------|
| `file_view` | 查看文件（支持 file_id 或文件名，输出总是包含 file_id） |
| `file_content_edit` | 编辑文件内容（仅 file_id，需先 view 获取 hash） |
| `file_modify` | 修改文件属性：重命名、分类 tag、归档（仅 file_id） |
| `directory_show` | 查看/搜索文件目录（不传 query 列出全部，传 query 搜索） |
| `web_search` | 搜索互联网（SearXNG 容器） |
| `web_page_read` | 读取网页内容为 Markdown（CF Browser） |
| `done` | 声明任务完成，结束工具调用循环 |

循环逻辑：LLM 每轮可调用工具，DO 执行后将结果作为 tool message 回传，直到 `done` 被调用或达到 10 轮上限。工具循环结束后，强制进行一轮无工具的最终调用，让 LLM 生成文字报告告知用户结果。

响应结束后自动查询 AI Search，返回相关文件片段作为 `refs`。

### 系统提示词

- 中文写作工具身份
- `file_content_edit` 和 `file_modify` 只接受 file_id（不接受文件名）
- 编辑前必须先查看（hash 验证）
- 文件不存在可在 file_content_edit 中新建（new_filename + new_content）
- 每轮工具调用都应给出结果说明
- 工具调用结束后最后一轮必须生成文字报告
- 任务完成必须调用 done

## 开发流程

- `pnpm dev` 启动本地开发
- `pnpm deploy` 部署到 Cloudflare Workers
- 使用 `wrangler secret put <KEY>` 设置密钥
- D1 migration: `drizzle/` 目录下的 SQL 文件
