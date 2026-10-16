# ANON MCP

将 [ANON](../anon/README.md) 的项目 HTTP API 暴露为本地 **stdio MCP server**。使用 TypeScript 和官方 [MCP SDK](https://ts.sdk.modelcontextprotocol.io/)，无需修改 ANON，也不直接连接数据库。

工具从 ANON 的 `docs/openapi.yaml` 生成，当前提供 **142 个工具**。已结合 `docs/api.md`、`docs/plugin-development.md`、后端鉴权中间件和路由实现确认接入方式。完整映射见 [工具目录](docs/tools.md)。

## 为什么使用 MCP

ANON 已为脚本提供绑定单个项目的 `anonk_` API 密钥，适合通过 MCP 暴露可发现、带参数 schema 的实时操作。密钥仅在本地进程中读取；后端继续执行 scope、角色和数据可见性检查。

Skill 更适合补充「活动前检查清单」「汇总待办后生成周报」等工作流程，但本身不提供统一的工具调用协议。因此此仓库先实现 MCP，后续可在其上增加工作流 skill。

## 快速开始

需要 Node.js **22+** 和可访问的 ANON 实例。

```bash
npm ci
npm run build
cp .env.example .env
```

在 ANON「我的 → API 密钥」为目标项目创建密钥，选择需要的权限点，然后编辑 `.env`：

```dotenv
ANON_BASE_URL=http://localhost:4000
ANON_API_KEY=anonk_这里替换为真实密钥
ANON_MODULES=project,todos,dashboard,announcements
ANON_READ_ONLY=false
```

`ANON_BASE_URL` 是实例源地址，也接受以 `/api` 结尾的地址；使用前端反向代理地址亦可。生产部署使用 HTTPS。密钥只展示一次；到期或撤销后需替换配置并重启。

```bash
npm start
```

此命令从当前目录的 `.env` 读取配置，随后等待 stdin 上的 MCP JSON-RPC；终端没有欢迎输出是正常行为。stdout 专供协议通信，启动错误写入 stderr。

## MCP 客户端配置

对使用 `mcpServers` 配置结构的客户端，可加入以下条目。将两处路径改成当前仓库的**绝对路径**；由客户端启动进程，不需要预先运行 `npm start`。

```json
{
  "mcpServers": {
    "anon": {
      "command": "node",
      "args": [
        "--env-file=/absolute/path/anon-mcp/.env",
        "/absolute/path/anon-mcp/dist/index.js"
      ]
    }
  }
}
```

客户端也可通过进程环境直接传入 `ANON_BASE_URL`、`ANON_API_KEY` 等变量，此时省略 `--env-file` 参数。项目 ID 自动从 `/api/open/me` 获取，调用者不能通过工具参数切换项目。多个项目可分别配置多个 MCP 进程和密钥。

## 使用方式

先调用 `anon_get_open_me` 查看项目、实时权限与有效期，然后调用业务工具。参数统一使用 `path`、`query`、`body` 分组；仅传所需分组。

查询未完成待办：

```json
{
  "name": "anon_get_todos",
  "arguments": { "query": { "status": "open", "sort": "dueAt", "order": "asc" } }
}
```

创建待办：

```json
{
  "name": "anon_post_todos",
  "arguments": {
    "body": { "title": "确认场地设备", "dueAt": "2026-10-20T18:00:00+08:00" }
  }
}
```

完成待办并附上备注：

```json
{
  "name": "anon_post_todos_todo_id_complete",
  "arguments": {
    "path": { "todoId": "替换为待办ID" },
    "body": { "completionNote": "已确认" }
  }
}
```

工具参数按 schema 校验，非法参数不会发送到 ANON。工具可见不表示具有执行权限；实际授权由 ANON 每次请求决定。时间使用带时区的 ISO 8601，财务金额以元提交。

成功结果通过 `structuredContent` 和 JSON 文本同时返回：JSON 接口为 `{status, data}`，CSV 为 `{status, contentType, text}`，图片/文件为 `{status, contentType, base64}`。失败设置 `isError: true`，保留 ANON 的 `error.code`、消息与 HTTP 状态。客户端还可读取 `anon://guide` 资源。

## 配置

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `ANON_BASE_URL` | `http://localhost:4000` | ANON 实例源地址 |
| `ANON_API_KEY` | 必填 | `anonk_` + 64 位十六进制，不接受登录 JWT |
| `ANON_MODULES` | 空，全部模块 | 逗号分隔的模块白名单，见工具目录；身份/健康工具始终开放 |
| `ANON_READ_ONLY` | `false` | 设为 `true` 时仅开放 GET，并拒绝写调用 |
| `ANON_PROJECT_ID` | 自动获取 | 可选，额外验证密钥所属项目 |
| `ANON_TIMEOUT_MS` | `30000` | 每个 HTTP 请求的超时，范围 100–300000 毫秒 |

常用模块：`project,todos,dashboard,announcements,finance,materials,physical,work-modules,work-sheet,stage-rundowns,stage-signups,lostfound`。模块名无效会在启动时报错，避免误配后意外开放全部工具。

## 文件与接口范围

支持 JSON、CSV、multipart 上传与项目域内的二进制下载。上传字段使用 `{filename, mimeType?, base64}`，多个附件用数组；内容是不带 `data:` 前缀的标准 Base64。每个文件最多 20 MiB，每次最多 10 个附件；JSON 请求体最多 2 MiB，单次响应最多 8 MiB。MCP 客户端可能另有限制，较大文件请使用 ANON 页面。

接口范围沿用 ANON API 密钥边界：不提供用户登录、密钥管理、项目创建/全量列表、全局 `/api/files` 下载、后台或 cron。另排除密码查看与自定义工具启动令牌接口；这些属于独立的凭证流程。平台账号普通接口仍按后端的加密模式契约使用。

401 表示密钥失效，403 检查项目、scope、实时角色权限，429 稍后重试。不会自动重试写操作，也不跟随 HTTP 重定向；超时或取消后，先核实写入结果再重试。

## 开发与 API 同步

```bash
npm run typecheck  # TypeScript 检查
npm test           # 构建、契约和 stdio 协议测试，无需真实 ANON 或数据库
npm run watch      # 持续编译；另由客户端启动生成的 dist/index.js
npm run sync:api   # 从 ../anon/docs/openapi.yaml 更新快照和工具目录
npm run check:api  # 检查快照及目录是否与上游一致
```

上游不在相邻目录时可传入规范路径：`npm run sync:api -- /path/to/anon/docs/openapi.yaml`。运行时只依赖仓库内的规范快照，移动此仓库后仍可运行。同步后需重新测试、重启进程；规范与代码有差异时，以 ANON 的实际路由及 `docs/api.md` 为准。

`src/catalog.ts` 转换规范并筛选工具，`src/client.ts` 处理鉴权与 HTTP，`src/server.ts` 提供 MCP 协议，`tests/` 覆盖模拟后端契约和真实子进程握手。`resources/anon-openapi.yaml` 为 ANON 的 MIT 许可规范快照，许可与原作者署名见 [LICENSE](LICENSE)。

`.env` 已被忽略，不要提交真实密钥。当前仓库的 `AGENTS.md` 保留原样。
