# QQ Miniapp Auth

这是一个连接 NapCat 的真实 QQ 扫码登录和 QQ 小程序授权服务。它提供：

- NapCat 生成的 QQ 登录二维码；
- 登录状态轮询，可区分等待扫码、已扫码、已确认、已取消和过期；
- 当前登录 QQ 信息获取；
- 输入小程序 `appId` 后获取真实的 `qq.login` 授权 `code`；
- 获取 code 后通过 NapCat 原生 `NodeIKernelLoginService.offline()` 注销当前 QQ；
- 多浏览器访问时的单 NapCat 全局串行锁。

## 运行架构

项目只负责 Web 服务和 HTTP bridge，QQ/NapCat 仍然运行在宿主机上：

| 服务 | 默认地址 | 作用 |
| --- | --- | --- |
| Web | `http://127.0.0.1:8787` | 浏览器页面和公开 API |
| 项目 bridge | `http://127.0.0.1:9010` | 调用 NapCat OpenAuth 插件和注销接口 |
| NapCat OneBot HTTP | `http://127.0.0.1:3000` | 获取当前 QQ 信息 |
| NapCat WebUI | `http://127.0.0.1:6099/webui/` | 生成二维码、轮询扫码状态 |

`npm start` 会同时启动 Web 和 bridge。不要启动多个项目副本，也不要同时配置多个 NapCat 实例，否则串行锁无法保证。项目不使用 Unix socket、Windows named pipe 或 `.sock` 文件。

## 按部署方式阅读

先完成 NapCat 安装、插件和 OneBot 配置，再选择一种项目部署方式：

- [NapCat 安装与配置](docs/napcat/install-and-config.md)
- [Windows 原生部署](docs/platforms/windows.md)
- [Linux 原生部署](docs/platforms/linux.md)
- [macOS 原生部署](docs/platforms/macos.md)
- [Docker 部署](docs/deploy/docker.md)
- [宝塔部署](docs/deploy/baota.md)
- [HTTP API 参考](docs/api.md)

Docker 和宝塔文档与 Windows、Linux、macOS 原生文档分开存放。`docs/README.md` 提供目录索引和配置关系图。

## 最小配置

复制 `.env.example` 为 `.env`，至少填写 OneBot token、NapCat WebUI token（或 `NAPCAT_WEBUI_CONFIG`）以及插件 token：

```ini
HOST=127.0.0.1
PORT=8787
NAPCAT_API_URL=http://127.0.0.1:3000
NAPCAT_TOKEN=你的OneBotToken
NAPCAT_WEBUI_API_URL=http://127.0.0.1:6099/api
NAPCAT_WEBUI_CONFIG=NapCat配置目录/webui.json
NAPCAT_OPEN_AUTH_PLUGIN_URL=http://127.0.0.1:6099/plugin/qq-miniapp-openauth/api
NAPCAT_OPEN_AUTH_PLUGIN_TOKEN=插件配置中的token
BRIDGE_URL=http://127.0.0.1:9010
BRIDGE_PORT=9010
```

Windows 安装脚本会复制插件并生成或复用插件 token；Linux/macOS 按 NapCat 文档手动复制插件。详细配置不要从 README 猜路径，以对应平台文档为准。

## 快速启动

```bash
npm ci
npm start
```

打开 `http://127.0.0.1:8787/`。页面会直接显示 NapCat 返回的二维码，不会把浏览器跳转到 NapCat WebUI。健康检查地址为 `GET /api/health`。

## 安全边界

- 生产环境只对外暴露 Web 的 `8787`，不要公开 `3000`、`6099`、`9010`。
- OneBot、WebUI、插件和 bridge 都应使用 token；反向代理使用 HTTPS。
- 只运行一个 `start-all.js` 实例，并确保 NapCat 只有一个正在工作的 QQ 账号。
- 不要修改 QQ 的 `resources/app/package.json`，也不要直接杀 QQ 进程；注销由 NapCat 插件调用原生 `offline()` 完成。
- `appId` 和授权 code 都是真实值，服务端不会生成 mock 数据。

## 验证顺序

1. NapCat WebUI 可以打开，OneBot HTTP Server 已启用。
2. 插件状态接口返回 `ready: true` 且包含 `loginWithAppId`。
3. `GET /api/health` 返回 `bridgeConfigured: true`。
4. 浏览器创建二维码任务并扫码确认。
5. 输入小程序 `appId`，轮询任务直到 `status=success`，确认返回 `code` 和 `logoutStatus=success`。

