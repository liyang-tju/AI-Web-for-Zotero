# Chemistry Agent 远端部署

这份部署包将前端、FastAPI、RDKit、上下文压缩和独立账号一起部署到 Linux 服务器。现在提供的是部署材料；需要你准备服务器和域名后再上线。

## 服务器准备

服务器需要安装 Docker Engine 和 Docker Compose v2，能够连接 PyPI、Docker Hub、DeepSeek API 和 tokenizer 下载站点。当前按 Linux amd64 验证构建；仅运行一个应用实例，SQLite 数据使用持久化卷。

准备一个域名，例如 `chemistry.your-domain.com`，将 DNS 的 A 记录指向服务器公网 IP，并放行 TCP 80、443；可选放行 UDP 443。Caddy 根据域名自动申请及续期 HTTPS 证书，网页和 API 使用同一个 HTTPS 地址。应用自己的 8765 端口不对外发布。

## 首次部署

将 `chemistry-agent-deploy.zip` 上传到服务器，解压到一个新的应用目录，在该目录内执行：

```bash
cp .env.server.example .env.server
chmod 600 .env.server
nano .env.server
```

填写 `SITE_HOST` 和 `DEEPSEEK_API_KEY`。前者只填写实际域名，例如 `chemistry.your-domain.com`；后者使用你自己的 Key。真实配置不要放入代码仓库、镜像或分享给普通用户。

```bash
docker compose --env-file .env.server up -d --build
docker compose --env-file .env.server ps
```

首次构建会安装 Python 依赖并下载校验过的 tokenizer 数据。应用以非 root 用户运行，根文件系统只读，数据库写入 `agent_data` 数据卷。`caddy_data` 和 `caddy_config` 保存证书与代理配置状态。服务配置了健康检查与自动重启。

如果 Docker Hub 或本地配置的镜像加速器不可用，可以取消 `.env.server.example` 中两个备用镜像变量的注释并写入真实 `.env.server`，使用同一批 Docker 官方镜像在 Amazon ECR Public 的分发地址。本次本地验证使用了这两个公开镜像源，没有修改 Docker Desktop 的全局镜像配置。

## 开通账号

由拥有服务器管理权限的人创建账号，不提供公开注册入口：

```bash
docker compose --env-file .env.server exec app python -m chemistry_agent.users create alice
docker compose --env-file .env.server exec app python -m chemistry_agent.users create bob
```

按终端提示输入两次密码，密码不回显。用户名为 3–32 位字母、数字、下划线、点或连字符，统一转成小写；密码为 12–256 个字符。不要把密码写进命令行参数。

用户打开 `https://你的域名/`，使用自己的用户名和密码登录。每个人只能查看和继续自己的会话；摘要、工具结果和运行记录跟随会话归属隔离。猜到其他会话或运行 ID 也无法访问。Key 留在服务端；所有用户当前共用同一个 DeepSeek 计费账户，暂未实现分账号配额或计费。

登录状态使用 HttpOnly、Secure、SameSite=Lax Cookie，默认有效 12 小时。服务端只保存密码的随机盐 scrypt 哈希和登录令牌的 SHA256 摘要；退出登录、停用账号或重置密码会使对应令牌失效。登录失败有按账号和来源 IP 的次数限制。写请求校验浏览器 Origin。

账号管理：

```bash
docker compose --env-file .env.server exec app python -m chemistry_agent.users list
docker compose --env-file .env.server exec app python -m chemistry_agent.users reset-password alice
docker compose --env-file .env.server exec app python -m chemistry_agent.users disable alice
docker compose --env-file .env.server exec app python -m chemistry_agent.users enable alice
```

重置密码和启用/停用操作都会注销该账号原有的登录令牌，需要重新登录。管理员 CLI 不会启动第二个应用实例，也不会重置正在运行的 agent 任务。

## 旧数据与备份

新服务器默认从空数据库开始。部署包不包含本机 `.env`、账号、对话、摘要或任何测试数据库。

如果另行迁移了旧的单用户数据库，原有会话不会自动对新账号开放。先启动新版服务完成表结构升级，再明确将无主的旧会话归给某一个账号：

```bash
docker compose --env-file .env.server exec app python -m chemistry_agent.users claim-legacy alice
```

此命令只给 `owner_id` 为空的旧会话设置归属，不更改正文、工具结果或摘要。已归属其他用户的会话不受影响。

在服务运行时创建一致的 SQLite 快照，包括 WAL 中已经提交的数据：

```bash
docker compose --env-file .env.server exec app python -m chemistry_agent.backup /data/backups/agent-backup-001.sqlite3
docker compose --env-file .env.server cp app:/data/backups/agent-backup-001.sqlite3 ./agent-backup-001.sqlite3
```

备份工具拒绝覆盖已有文件，每次选一个新的文件名。备份包含用户资料和研究内容，应作为私有数据保管。恢复备份需要停服操作，避免替换正在使用的数据库。

## 更新与查看状态

保留服务器上的真实 `.env.server` 文件及数据卷，替换应用源码，然后执行：

```bash
docker compose --env-file .env.server up -d --build
docker compose --env-file .env.server logs --tail=100 app caddy
```

普通重新构建和容器重建不会删除数据卷。不要使用 `docker compose down -v`，除非你明确希望删除账号、会话和证书等持久化数据。单库只支持一个应用进程，不要把 `app` 扩成多个副本或配置多个 Uvicorn worker。

## 本机验证登录模式

本地日常运行继续默认使用原来的单用户模式，避免升级后把现有研究记录隐藏。想测试独立账号时，可用单独的测试数据库：

```powershell
$env:CHEMISTRY_DATABASE_PATH = 'data/accounts-test.sqlite3'
$env:CHEMISTRY_AUTH_ENABLED = 'true'
$env:CHEMISTRY_COOKIE_SECURE = 'false'
$env:CHEMISTRY_PORT = '18766'
.\.venv\Scripts\python.exe -m chemistry_agent.users create alice
.\.venv\Scripts\python.exe -m chemistry_agent
```

访问 `http://127.0.0.1:18766/` 测试。这个例子只监听本机，HTTP 测试时才关闭 Secure Cookie。生产 Compose 固定启用认证和 Secure Cookie，依赖 Caddy 的 HTTPS 入口。

`CHEMISTRY_TRUSTED_PROXY_IPS=*` 只用于应用端口没有对外发布的 Compose 网络，使应用识别 Caddy 转发的 HTTPS 和客户端地址；如果独立发布应用端口，应按实际代理地址设置可信范围。

参考：[Docker 持久化卷](https://docs.docker.com/engine/storage/volumes/)、[Compose 环境变量](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/)、[Caddy 自动 HTTPS](https://caddyserver.com/docs/automatic-https)。
