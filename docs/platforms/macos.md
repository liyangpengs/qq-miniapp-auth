# macOS 原生部署

本文适用于 Web 服务、bridge 和 QQ/NapCat 在同一台 macOS 电脑运行的情况。项目的 Node.js 部分支持 macOS；NapCat/QQ 的 macOS 可用性必须以 NapCat 当前官方版本为准。请先查看 <https://napneko.github.io/> 是否有适配你当前 QQ 版本的构建。

## 前置条件

- macOS 版本符合当前 QQ/NapCat 构建要求；
- Node.js 20 或更高版本，可从 <https://nodejs.org/> 安装，也可使用 Homebrew；
- NapCat WebUI 可访问 `http://127.0.0.1:6099/webui/`；
- OneBot HTTP Server 监听 `127.0.0.1:3000`；
- 插件已安装、启用并重启 NapCat。

```bash
node --version
npm --version
```

## 安装项目

在项目目录执行：

```bash
cp .env.example .env
nano .env
npm ci
```

macOS 常见 NapCat 配置目录可能位于：

```text
~/Library/Application Support/QQ/NapCat/config/
```

请以实际安装目录为准，在 `.env` 中明确写出路径（路径包含空格时不需要在 `.env` 中加 shell 引号）：

```ini
HOST=127.0.0.1
PORT=8787
NAPCAT_API_URL=http://127.0.0.1:3000
NAPCAT_TOKEN=OneBot中配置的Token
NAPCAT_WEBUI_API_URL=http://127.0.0.1:6099/api
NAPCAT_WEBUI_CONFIG=/Users/你的用户名/Library/Application Support/QQ/NapCat/config/webui.json
NAPCAT_OPEN_AUTH_PLUGIN_URL=http://127.0.0.1:6099/plugin/qq-miniapp-openauth/api
NAPCAT_OPEN_AUTH_PLUGIN_TOKEN=插件config.json中的Token
BRIDGE_URL=http://127.0.0.1:9010
BRIDGE_PORT=9010
```

## 安装插件

完全退出 QQ/NapCat 后执行，路径按实际位置替换：

```bash
mkdir -p "/实际/NapCat/plugins/qq-miniapp-openauth"
cp -R napcat-openauth-plugin/. "/实际/NapCat/plugins/qq-miniapp-openauth/"
mkdir -p "/实际/NapCat/config/plugins/qq-miniapp-openauth"
```

在插件 `config.json` 写入 token，并在 NapCat WebUI 插件管理中启用 `qq-miniapp-openauth`。如果该版本要求第三方插件白名单，按官方方式启用插件 ID；不要修改 QQ 的 `resources/app/package.json`。重启 NapCat 后使用 [NapCat 验证步骤](../napcat/install-and-config.md#4-验证插件)。

## 启动和访问

```bash
npm start
```

浏览器打开 <http://127.0.0.1:8787/>，检查服务：

```bash
curl http://127.0.0.1:8787/api/health
```

停止时在终端按 `Ctrl+C`。可以用 launchd 或 PM2 守护 `start-all.js`，但只能运行一个项目实例：

```bash
pm2 start start-all.js --name qq-miniapp-auth
pm2 save
```

## macOS 注意事项

- 系统防火墙只需允许本机应用通信；不要把 `3000`、`6099`、`9010` 公开到公网。
- NapCat 和 Node 服务可以使用不同 macOS 用户，但配置文件和插件目录必须可读。
- 项目使用 HTTP bridge，不使用 Unix socket，不需要创建 `bridge.sock`。

