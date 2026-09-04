# Linux 原生部署

本文适用于 Web 服务、bridge 和 QQ/NapCat 运行在同一台 Linux 服务器或工作站。NapCat/QQ 的图形环境、发行版依赖和安装方式会随官方版本变化，请先参考 <https://napneko.github.io/> 完成 NapCat 安装。

## 前置条件

- Node.js 20 或更高版本；
- 官方当前支持的 Linux QQ/NapCat 构建，并能打开 NapCat WebUI；
- OneBot HTTP Server 在 NapCat 中已启用；
- 项目插件已复制到 NapCat 插件目录并启用。

```bash
node --version
npm --version
```

NapCat 需要的桌面、字体、显示服务或容器运行参数以官方文档为准。建议 QQ/NapCat 使用独立普通用户运行，不要用 root 运行 QQ。

## 安装项目

示例目录为 `/opt/qq-miniapp-auth`：

```bash
sudo mkdir -p /opt/qq-miniapp-auth
sudo chown -R "$USER":"$USER" /opt/qq-miniapp-auth
cd /opt/qq-miniapp-auth
```

复制项目文件后创建配置：

```bash
cp .env.example .env
nano .env
npm ci --omit=dev
```

同机原生部署的关键配置：

```ini
HOST=127.0.0.1
PORT=8787
NAPCAT_API_URL=http://127.0.0.1:3000
NAPCAT_TOKEN=OneBot中配置的Token
NAPCAT_WEBUI_API_URL=http://127.0.0.1:6099/api
NAPCAT_WEBUI_CONFIG=/实际/NapCat/config/webui.json
NAPCAT_OPEN_AUTH_PLUGIN_URL=http://127.0.0.1:6099/plugin/qq-miniapp-openauth/api
NAPCAT_OPEN_AUTH_PLUGIN_TOKEN=插件config.json中的Token
BRIDGE_URL=http://127.0.0.1:9010
BRIDGE_PORT=9010
```

将 `.env` 权限限制为服务用户：

```bash
chmod 600 .env
```

## 安装插件

退出 QQ/NapCat 后，在项目根目录执行：

```bash
mkdir -p "/path/to/NapCat/plugins/qq-miniapp-openauth"
cp -R napcat-openauth-plugin/. "/path/to/NapCat/plugins/qq-miniapp-openauth/"
mkdir -p "/path/to/NapCat/config/plugins/qq-miniapp-openauth"
```

先将 `/path/to/NapCat` 替换为实际 NapCat 目录，再执行命令。

在 `config/plugins/qq-miniapp-openauth/config.json` 写入插件 token，并在 NapCat WebUI 插件管理中启用插件。若当前版本要求第三方插件白名单，按该版本 NapCat 官方方式启用 `qq-miniapp-openauth`。重启 NapCat 后验证 `/status`，具体响应见 [NapCat 文档](../napcat/install-and-config.md#4-验证插件)。

## 手动启动

```bash
cd /opt/qq-miniapp-auth
npm start
```

访问 <http://127.0.0.1:8787/>，健康检查：

```bash
curl http://127.0.0.1:8787/api/health
```

## systemd 常驻运行

项目提供模板 `deploy/qq-miniapp-auth.service.example`。先创建一个只运行 Web/bridge 的系统用户：

```bash
sudo useradd --system --home-dir /opt/qq-miniapp-auth --shell /usr/sbin/nologin qqauth
sudo chown -R qqauth:qqauth /opt/qq-miniapp-auth
sudo cp deploy/qq-miniapp-auth.service.example /etc/systemd/system/qq-miniapp-auth.service
sudo systemctl daemon-reload
sudo systemctl enable --now qq-miniapp-auth
```

确认模板中的 `WorkingDirectory`、`EnvironmentFile` 和 `/usr/bin/node` 与服务器实际路径一致。如果 NapCat 使用其他用户运行，网络端口可以共用，但 NapCat 配置文件和插件目录的读权限必须允许 NapCat 用户访问。

常用命令：

```bash
sudo systemctl status qq-miniapp-auth
sudo journalctl -u qq-miniapp-auth -f
sudo systemctl restart qq-miniapp-auth
sudo systemctl stop qq-miniapp-auth
```

只部署一个 systemd 实例，不要再手动运行 `npm start`。

## 反向代理（可选）

公网只代理 Web：

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

不要把 NapCat 的 `3000`、`6099` 或项目 bridge 的 `9010` 暴露到公网。项目不创建也不读取 Unix socket 文件。
