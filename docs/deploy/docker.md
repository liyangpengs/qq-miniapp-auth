# Docker 部署

Docker 只运行本项目的 Web 和 bridge。QQ/NapCat 仍运行在宿主机，因为普通 Node 容器不能替代 QQ 图形客户端，也不能自动拥有 NapCat 的 QQ 会话。

## 拓扑

```text
浏览器 --> 容器:8787
             ├--> 容器 bridge:9010
             └--> 宿主机 NapCat:3000/6099
```

容器内的 `BRIDGE_URL` 必须是 `http://127.0.0.1:9010`，因为 bridge 和 Web 在同一个容器中。不要把它改成宿主机地址。

## 前置条件

- Docker Engine 或 Docker Desktop；
- Docker Compose v2（命令为 `docker compose`）；
- 宿主机已安装、启动并登录 NapCat；
- 宿主机 NapCat 已安装本项目插件并启用；
- NapCat OneBot HTTP 和 WebUI 对容器网络可达。

先按 [NapCat 安装与配置](../napcat/install-and-config.md) 在宿主机完成 QQ、OneBot 和插件配置。

## 配置宿主机 NapCat 网络

原生部署可以把 NapCat 绑定在 `127.0.0.1`。Docker 容器访问宿主机时，NapCat 不能只监听宿主机回环地址：

- Windows/macOS Docker Desktop：使用 `host.docker.internal`，并让 NapCat 监听宿主机可达的私网地址；
- Linux Compose：本项目已通过 `extra_hosts` 提供 `host.docker.internal` 到宿主机的映射；如果发行版不支持，请把 `.env.docker` 中的 NapCat 地址改为宿主机私网 IP。

只允许 Docker 私网或防火墙白名单访问 `3000` 和 `6099`，同时保留 OneBot/WebUI token。不要直接把这两个端口发布到公网。

## 启动

Linux/macOS：

```bash
cp .env.docker.example .env.docker
nano .env.docker
docker compose up -d --build
```

PowerShell：

```powershell
Copy-Item .env.docker.example .env.docker
notepad .env.docker
docker compose up -d --build
```

`.env.docker` 的关键值：

```ini
HOST=0.0.0.0
PORT=8787
NAPCAT_API_URL=http://host.docker.internal:3000
NAPCAT_WEBUI_API_URL=http://host.docker.internal:6099/api
NAPCAT_OPEN_AUTH_PLUGIN_URL=http://host.docker.internal:6099/plugin/qq-miniapp-openauth/api
NAPCAT_TOKEN=宿主机OneBotToken
NAPCAT_OPEN_AUTH_PLUGIN_TOKEN=宿主机插件Token
NAPCAT_WEBUI_TOKEN=宿主机WebUI token
BRIDGE_URL=http://127.0.0.1:9010
```

容器默认不能读取宿主机的 `webui.json`，因此 Docker 部署建议直接填写 `NAPCAT_WEBUI_TOKEN`。如果必须使用 `NAPCAT_WEBUI_CONFIG`，需要把宿主机配置文件以只读 volume 挂载到容器，并将变量设置为容器内路径。

Compose 只发布 `8787:8787`。不要新增 `3000`、`6099` 或 `9010` 的 `ports`，也不要启动第二个 Compose 副本；工作流锁保存在单个 Node 进程内存中。

## 检查和停止

```bash
docker compose ps
docker compose logs -f qq-miniapp-auth
curl http://127.0.0.1:8787/api/health
```

浏览器访问 <http://127.0.0.1:8787/>。停止并删除容器：

```bash
docker compose down
```

更新项目：

```bash
docker compose up -d --build
```

不要把 `.env.docker` 提交到仓库；其中包含 OneBot、WebUI 和插件 token。生产环境应在反向代理后使用 HTTPS，并限制 `8787` 的访问来源。
