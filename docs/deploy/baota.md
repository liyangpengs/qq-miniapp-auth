# 宝塔部署

宝塔只负责管理本项目的 Node.js Web/bridge 服务。QQ/NapCat 仍需要在同一台服务器（或网络可达的宿主机）独立安装和运行，安装方式见 [NapCat 安装与配置](../napcat/install-and-config.md)。

## 前置条件

- Linux 服务器和宝塔面板；
- 宝塔 Node.js 版本管理器或系统 Node.js 20+；
- NapCat/QQ 已按官方当前版本方式安装并运行；
- NapCat OneBot HTTP、WebUI 和 `qq-miniapp-openauth` 插件已配置。

检查 Node：

```bash
node --version
npm --version
```

## 上传和安装项目

将项目上传到例如 `/www/wwwroot/qq-miniapp-auth`，在宝塔终端执行：

```bash
cd /www/wwwroot/qq-miniapp-auth
cp .env.example .env
vi .env
npm ci --omit=dev
chmod 600 .env
```

同机 NapCat 使用回环地址：

```ini
HOST=127.0.0.1
PORT=8787
NAPCAT_API_URL=http://127.0.0.1:3000
NAPCAT_TOKEN=OneBotToken
NAPCAT_WEBUI_API_URL=http://127.0.0.1:6099/api
NAPCAT_WEBUI_CONFIG=/实际/NapCat/config/webui.json
NAPCAT_OPEN_AUTH_PLUGIN_URL=http://127.0.0.1:6099/plugin/qq-miniapp-openauth/api
NAPCAT_OPEN_AUTH_PLUGIN_TOKEN=插件Token
BRIDGE_URL=http://127.0.0.1:9010
BRIDGE_PORT=9010
```

如果 NapCat 在另一台机器，把 `NAPCAT_API_URL`、`NAPCAT_WEBUI_API_URL` 和插件 URL 改成私网地址，并用防火墙和 token 限制访问。宝塔反向代理只需要代理本项目的 `8787`。

## 创建宝塔 Node 项目

在“网站”或“Node 项目”中新增项目：

- 项目目录：`/www/wwwroot/qq-miniapp-auth`；
- 启动文件：`start-all.js`；
- 启动方式：生产模式；
- 端口：`8787`；
- Node 版本：20+；
- 进程数：1。

工作目录必须是项目根目录，这样 `dotenv` 才能读取 `.env`。不要分别启动 `server.js` 和 `bridge.js`，也不要在宝塔外再启动一个 `npm start`。

启动后在宝塔日志或终端确认：

```bash
curl http://127.0.0.1:8787/api/health
```

## 添加网站反向代理

在宝塔“网站”中新建域名，然后设置反向代理：

```text
目标 URL: http://127.0.0.1:8787
```

为域名配置 HTTPS。不要把 `3000`、`6099` 或 `9010` 配成公开代理，也不要在安全组放行这些端口。

## 日常操作

```bash
cd /www/wwwroot/qq-miniapp-auth
npm ci --omit=dev
```

在宝塔 Node 项目页面执行启动、重启、停止和查看日志。更新插件后先重启 NapCat，再重启 Node 项目。确保 `.env` 和 NapCat 配置目录的读权限分别属于实际运行用户。

## 故障排查

- `bridgeConfigured: false`：检查 `.env` 是否有 `BRIDGE_URL=http://127.0.0.1:9010`，并确认启动文件是 `start-all.js`。
- 二维码获取失败：检查 NapCat WebUI token/config 路径和 `6099` 监听状态。
- code 获取失败：检查插件 `/status` 的 `ready`、`loginWithAppId` 和插件 token。
- `WORKFLOW_BUSY`：已有浏览器正在占用唯一 NapCat 工作流，等待其完成 code 获取和自动注销。

