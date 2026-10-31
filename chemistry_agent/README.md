# Chemistry Agent

第一版独立化学 agent 服务，使用 Python 3.11+、LangGraph、FastAPI、SQLite 和 RDKit，模型通过 DeepSeek 官方 Chat Completion API 调用。

目前可用：中文聊天前端、基于已知 SMILES 的分子属性计算和分子相似度比较、用户提供的文献片段分析、多轮会话、工具调用记录和运行状态。所有新增代码都在本目录内。

远端部署和独立账号模式见 [DEPLOYMENT.md](DEPLOYMENT.md)。提供 Docker 镜像、Caddy HTTPS 入口、持久化数据卷，以及管理员创建账号、会话隔离和数据库备份命令。

## 安装与启动（Windows PowerShell）

在本目录打开 PowerShell：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -c constraints.txt -e ".[dev]"
.\.venv\Scripts\python.exe .\scripts\setup_tokenizer.py
Copy-Item .env.example .env
```

编辑 `.env` 中的 `DEEPSEEK_API_KEY`，然后启动：

```powershell
.\.venv\Scripts\python.exe -m chemistry_agent
```

也可以用当前终端的环境变量覆盖 `.env` 配置，例如 `$env:DEEPSEEK_MODEL = "deepseek-v4-pro"`。

打开 <http://127.0.0.1:8765/> 使用前端页面；<http://127.0.0.1:8765/docs> 保留交互式 API 文档。服务默认只监听本机。没有 Key 时页面会提示配置模型，右侧分子工具仍可使用；调用 `/chat` 会明确返回 `503 model_not_configured`。

## 前端页面

- 左侧新建或切换历史会话，刷新后恢复上次打开的会话，也可通过页面的会话链接返回。
- 中间输入问题，Enter 发送，Shift + Enter 换行；支持中文输入法，不会在选字时发送。
- 点击“文献片段”粘贴参考原文，与问题一起提供给模型；模型回答支持 Markdown、列表、表格和代码块。
- 右侧可直接输入 SMILES 计算属性或比较相似度，无需调用模型；对话中产生的工具结果也会显示在此处。
- 对话内展开工具记录查看参数与结果，支持复制回答。失败时保留问题与文献片段，可手动重试。
- 使用了历史摘要或工具结果精简的轮次，会显示“上下文已压缩”或“工具结果已精简”；悬停可查看预计输入 token、摘要覆盖量及保留轮数。
- 窄屏下，会话导航和研究面板通过顶部按钮打开。界面包含键盘焦点管理及减少动画偏好支持。

前端是无构建步骤的 HTML / CSS / JavaScript，由 FastAPI 同源提供，不需要额外启动 Node 服务。静态文件位于 `src/chemistry_agent/web/`；Markdown 渲染使用从原项目复制的本地 markdown-it 资源，其 MIT 许可证保存在 `web/vendor/markdown-it-LICENSE.txt`。模型输出中的原始 HTML 不执行，远程图片不加载，Key 不会传入前端。

## 调用示例

无需 Key 即可运行分子工具：

```powershell
$body = @{ arguments = @{ smiles = "CCO" } } | ConvertTo-Json
Invoke-RestMethod http://127.0.0.1:8765/tools/molecular_properties/invoke `
  -Method Post -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($body))
```

配置 Key 后调用 agent：

```powershell
$body = @{ message = "请用工具计算乙醇 CCO 的分子式、分子量和 LogP。" } | ConvertTo-Json
$reply = Invoke-RestMethod http://127.0.0.1:8765/chat `
  -Method Post -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($body))
$reply

# 传入返回的 session_id 继续同一会话
$body = @{ session_id = $reply.session_id; message = "再比较它和甲醇 CO 的结构相似度。" } | ConvertTo-Json
Invoke-RestMethod http://127.0.0.1:8765/chat `
  -Method Post -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($body))
```

可以额外传 `context` 字符串提供文献片段；片段会随该轮用户消息一起保存在本地会话中，并发送到 DeepSeek。首次 `/chat` 不传 `session_id` 时自动建会话；传入不存在的 ID 返回 404。

| 接口 | 用途 |
| --- | --- |
| `GET /` | 聊天前端页面 |
| `GET /health` | 服务状态、是否已配置 Key、模型名称；不请求 DeepSeek |
| `GET /tools` | 工具说明和参数定义 |
| `POST /tools/{name}/invoke` | 直接执行本地工具，不调用模型 |
| `POST /sessions` | 创建会话，支持 `title` |
| `GET /sessions?limit=20&offset=0` | 查看会话列表 |
| `GET /sessions/{id}` | 查看已完成轮次的完整消息和工具消息；不返回模型推理内容 |
| `POST /chat` | 多轮对话，返回答案、会话 ID、运行 ID、工具结果和累计 token 用量 |
| `GET /runs/{id}` | 查看运行状态、工具结果和错误码 |
| `GET /sessions/{id}/runs` | 按会话查看运行列表，支持 `limit` 和 `offset` |

## 工具

- `molecular_properties`：输入 `smiles`，计算分子式、分子量、精确质量、Crippen LogP、TPSA、氢键供受体数、可旋转键数、环数和形式电荷。数值包含单位和 RDKit 版本来源。
- `molecular_similarity`：输入 `smiles_a`、`smiles_b`，计算 Morgan 指纹（radius=2，2048 bits，不含手性）的 Tanimoto 相似度。该指标不代表生物活性或反应可行性。

新增工具时在 `src/chemistry_agent/tools.py` 中定义 Pydantic 参数模型、计算函数，并注册 `Tool`。模型只可调用已注册工具，参数会在本地校验。

## 上下文压缩

每一次模型请求前都会检查 token 预算，包括工具调用后的继续请求。只压缩发送给模型的副本，SQLite 中的用户正文、助手回复、完整工具结果和思考模式协议字段都不被覆盖或删除。

默认策略：

1. 总窗口为 32,768 tokens，预留 `DEEPSEEK_MAX_TOKENS`（默认 4,096）作为回答空间，可用输入预算为 28,672。
2. 预计输入超过可用预算的 80%（默认约 22,937）时，将较早的完整对话轮次生成摘要；最近 4 个已完成轮次及当前任务继续提供给模型。
3. 摘要增量更新，保存其覆盖的原始消息数量；后续对话与重启后都可复用，不会每次重写全部历史。过长的摘要输入分块处理，每个摘要请求也检查输入和输出预算。
4. 发送给模型的单份工具结果超过 512 tokens 时，保留关键属性、数值和方法，省略过长内容，并明确标记 `_context_compacted`。分子标识符不会被截成不完整结构；原始结果仍可在会话及运行记录中查看。
5. 不拆散 assistant 工具调用与对应 tool 返回，也不截断近期消息中的 DeepSeek 思考协议字段。提供给摘要模型的材料不包含私有推理内容。

摘要是有损记忆，提示词要求保留目标、约束、SMILES、数值、单位、来源、纠错与未解决问题；精确细节仍应核对原文。摘要作为低权限的历史资料发送，不作为系统指令。

`scripts/setup_tokenizer.py` 从 [DeepSeek 官方文档](https://api-docs.deepseek.com/zh-cn/quick_start/token_usage/) 所链接的地址下载 tokenizer 数据，校验固定 SHA256，仅保存 JSON，不执行下载的 Python 代码；可传 `--proxy http://127.0.0.1:7890`。数据位于被 Git 忽略的 `data/deepseek-tokenizer.json`，程序启动时不访问下载站点。离线 tokenizer 加上 15% 及消息封装余量用于请求前估算；实际计费用量以接口返回的 `usage` 为准。文件缺失或不可读时退回更保守的 UTF-8 字节计数，接口会注明计数方式。

配置项可见 `.env.example`：`CHEMISTRY_CONTEXT_WINDOW_TOKENS`、`CHEMISTRY_CONTEXT_TRIGGER_RATIO`、`CHEMISTRY_CONTEXT_RECENT_TURNS`、`CHEMISTRY_CONTEXT_SUMMARY_TOKENS`、`CHEMISTRY_CONTEXT_TOOL_RESULT_TOKENS` 和 `CHEMISTRY_TOKENIZER_PATH`。

摘要失败时返回 `context_summary_failed`，不推进摘要覆盖范围，也不会丢弃历史。若最近保留轮次或当前资料本身已超过硬预算，会返回 `context_budget_exceeded`，应精简本轮资料、调小保留轮数或增大窗口。摘要已成功、后续回答失败时仍可复用摘要，因为它只覆盖此前已完成的历史。

`/chat` 响应和运行记录新增 `context`：包含是否压缩、摘要覆盖量、保留轮数、工具精简数量、压缩前后预计输入、输入预算、tokenizer 模式及摘要调用用量。摘要会产生额外模型调用，其 token 用量计入本轮总 `usage`，同时列在 `context.summary_usage` 中。旧数据库会自动增加摘要表和运行元数据列，原始记录保持不变。

## 配置和运行边界

- `.env.example` 包含全部配置；`.env`、虚拟环境、数据库均被 Git 忽略。Key 只在服务端使用，不写入业务数据库或响应。
- 默认使用 `deepseek-flash`，可通过 `DEEPSEEK_MODEL` 修改。默认关闭 thinking；打开 `DEEPSEEK_THINKING=true` 后会在内部保留并回传 DeepSeek 工具调用协议要求的 `reasoning_content`，公共接口不返回该字段。
- `CHEMISTRY_DATABASE_PATH` 默认为本目录下 `data/agent.sqlite3`；相对路径始终相对此目录解析。SQLite 保存已完成对话和每次运行的状态。
- 模型每轮最多调用 6 轮工具，之后必须总结；单次模型请求默认超时 60 秒，整次运行默认超时 180 秒。错误和截断响应不会混入后续对话，不会自动重试计费请求。
- 以 token 预算替代旧的 120,000 JSON 字符限制；长历史会自动摘要。Token 用量累计已收到用量报告的模型响应及摘要请求；网络断开等情况下未收到的用量无法统计。
- 第一版使用单进程运行。同一会话同时发起两次任务时返回 409；不同会话可并发。重启后将上次未完成的运行标为 `interrupted`，已完成对话可继续。暂不支持运行中断点恢复或后台任务队列。
- 同一数据库有进程锁保护，重复启动服务会失败，不会清除正在运行的任务状态。失败任务保留此前已经执行完成的工具结果。
- 第一版提供独立前端与 HTTP 接口，尚未嵌入 Zotero 界面、自动读取 PDF 或联网检索；可分析主动传入的文献片段。分子工具提供计算描述符，不提供实验验证数据。
- 本地默认是单用户模式（`CHEMISTRY_AUTH_ENABLED=false`），继续只监听本机；远端 Compose 强制启用账号登录和 HTTPS Cookie。账号、会话、摘要及运行记录按所属用户隔离，不提供公开注册入口。

## 测试

```powershell
.\.venv\Scripts\python.exe -m pytest
.\.venv\Scripts\python.exe -m ruff check .
node --test tests/frontend.test.mjs
```

测试使用模拟 DeepSeek HTTP 响应，不需要 Key、不产生模型费用；覆盖真实 RDKit 计算、工具调用往返、连续对话、SQLite 重启、缺失 Key、上游认证/限流/超时、异常工具参数和轮数限制，以及静态资源、Markdown 安全渲染和前端历史消息重建。真实 DeepSeek 联调需要提供有效 Key 后单独进行。

配置 Key 并启动服务后，可另开终端执行真实联调（会调用 DeepSeek API）：

```powershell
.\.venv\Scripts\python.exe .\scripts\smoke_deepseek.py
```

联调依次验证连接、模型调用分子属性工具、带会话历史的分子相似度计算，以及运行记录与会话持久化。结果保存到被 Git 忽略的 `data/live-test-result.json`；脚本不读取或打印 API Key。可用 `--url` 指定服务地址。

真实上下文压缩联调可执行 `.\.venv\Scripts\python.exe .\scripts\smoke_context.py`。该脚本使用独立的合成测试数据库，以较小预算验证摘要、早期事实记忆、重启复用与原文保留，会实际调用 DeepSeek；不改变日常会话数据库或预算配置。报告保存在 `data/context-live-result.json`。

`constraints.txt` 固定本次在 Windows / Python 3.11 上验证的依赖版本；`pyproject.toml` 定义可接受的版本范围。

接口依据：[DeepSeek 入门](https://api-docs.deepseek.com/)、[工具调用](https://api-docs.deepseek.com/guides/tool_calls/)、[Thinking 模式](https://api-docs.deepseek.com/guides/thinking_mode/)、[LangGraph Graph API](https://docs.langchain.com/oss/python/langgraph/graph-api)、[RDKit 文档](https://www.rdkit.org/docs/)。
