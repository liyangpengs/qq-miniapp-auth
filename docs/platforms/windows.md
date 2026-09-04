# Windows 原生部署

本文适用于 Web 服务和 bridge 与 QQ/NapCat 运行在同一台 Windows 电脑的情况。NapCat 安装和 OneBot/插件配置见 [NapCat 安装与配置](../napcat/install-and-config.md)。

## 前置条件

- Windows 10/11 或 NapCat 官方当前支持的版本；
- Node.js 20 或更高版本：<https://nodejs.org/>；
- QQ/NapCat 已按官方文档安装并能打开 `http://127.0.0.1:6099/webui/`；
- NapCat OneBot HTTP Server 已监听 `127.0.0.1:3000`；
- 项目插件已安装并启用。

检查 Node.js：

```powershell
node --version
npm --version
```

## 安装项目

在项目根目录执行：

```powershell
Copy-Item .env.example .env
notepad .env
npm ci
```

`.env` 至少确认以下值：

```ini
HOST=127.0.0.1
PORT=8787
NAPCAT_API_URL=http://127.0.0.1:3000
NAPCAT_TOKEN=OneBot中配置的Token
NAPCAT_WEBUI_API_URL=http://127.0.0.1:6099/api
NAPCAT_WEBUI_CONFIG=D:\lyp-soft\NapCat\config\webui.json
NAPCAT_OPEN_AUTH_PLUGIN_URL=http://127.0.0.1:6099/plugin/qq-miniapp-openauth/api
NAPCAT_OPEN_AUTH_PLUGIN_TOKEN=插件config.json中的Token
BRIDGE_URL=http://127.0.0.1:9010
BRIDGE_PORT=9010
```

如果 NapCat 安装在其他目录，按实际路径修改 `NAPCAT_WEBUI_CONFIG`。WebUI token 也可以直接写入 `NAPCAT_WEBUI_TOKEN`，二者任选其一。

## 安装插件

完全退出 QQ/NapCat 后执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install-napcat-plugin.ps1 -NapCatRoot "D:\lyp-soft\NapCat"
```

脚本执行结束后重启 NapCat，并按 [NapCat 文档](../napcat/install-and-config.md#4-验证插件)验证插件状态。不要在 QQ 运行时覆盖插件文件，也不要修改 QQ 的 `resources\app\package.json`。

## 启动和访问

```powershell
npm start
```

打开 <http://127.0.0.1:8787/>。停止时在同一个终端按 `Ctrl+C`，不要直接结束 QQ 进程。

只启动一份 `npm start`。它会同时启动：

- Web：`127.0.0.1:8787`；
- bridge：`127.0.0.1:9010`。

健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/health
```

应看到 `bridgeConfigured: true`。如果端口已占用，先关闭重复的 `server.js`、`bridge.js` 或 `npm start` 实例。

## 常驻运行

可以使用 Windows 任务计划程序、NSSM 或 PM2 守护 `start-all.js`：

```powershell
pm2 start start-all.js --name qq-miniapp-auth
pm2 save
```

工作目录必须是项目根目录，环境变量从该目录的 `.env` 加载。不要同时让任务计划、PM2 和手工终端各启动一份。

## 更新

```powershell
git pull
npm ci
```

插件更新后完全重启 NapCat；项目更新后重启 `start-all.js`。保留 `.env`，不要把 token 提交到仓库。
