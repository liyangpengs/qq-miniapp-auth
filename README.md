# QQ 小程序授权服务

本项目基于本机 NapCat，提供真实的 QQ 扫码登录和 QQ 小程序 OpenAuth 授权
接口，不生成模拟二维码或模拟授权码。

## 功能

- 获取 NapCat 生成的真实 QQ 登录二维码；
- 轮询 `waiting_scan`、`scanned`、`confirmed`、`cancelled` 和 `expired` 状态；
- 通过 OneBot 查询当前 QQ 账号信息；
- 通过 NapCat 插件调用 `NodeMiscService.loginWithAppId(appId)`；
- 只有 NapCat 原生注销成功后才返回真实的 `qq.login` 授权码；
- 对没有 `NodeIKernelLoginService.offline()` 的 NapCat 4.18.x 版本，使用
  `NodeIQQNTWrapperSession.offLine()` 备用方案，并重启 NapCat worker 清理内存中的登录状态；
- 同一 NapCat 账号一次只允许一个工作流，任务取消、超时或授权码获取成功后自动释放。

## 运行结构

```text
API 调用方 -> API :8787 -> 项目 bridge :9010
                              -> NapCat 插件 :6099
                              -> NapCat OneBot :3000
```

只应对调用方开放 `8787` 端口。`3000`、`6099` 和 `9010` 应保持在本机或受保护的
内网中。本项目不使用 Unix socket、Windows named pipe 或 `.sock` 文件。

## 安装和配置

1. 安装 QQ 和 NapCat，并启用 NapCat WebUI 与 OneBot HTTP Server。
2. 按对应平台文档安装 `napcat-openauth-plugin`。
3. 复制 `.env.example` 为 `.env`，填写 NapCat 和插件的 token。
4. 安装依赖并启动 Web 服务和 bridge：

```bash
npm ci
npm start
```

API 默认地址为 <http://127.0.0.1:8787>，项目不再提供浏览器前端页面。

四个业务接口都要求在 `X-API-Signature` 请求头中传入 `API_SIGNING_SECRET` 配置的固定值。
默认值为 `qq-miniapp-auth-default-signing-secret`；`/api/health` 不要求签名。
签名采用普通字符串全等比较，不使用 HMAC、哈希、时间戳或其他加密/签名算法。

任务和工作流的默认有效期都是 2 分钟（`120000` 毫秒）。如需调整，可配置
`TASK_TTL_MS` 和 `WORKFLOW_TTL_MS`。

## API 快速开始

```http
POST /api/qq/login/qrcode
```

响应中的 `task.id` 是后续请求使用的任务标识，不需要 cookie。四个公开业务接口始终
返回 HTTP `200`，调用方通过 `ok` 字段判断成功或失败。二维码获取和状态查询接口返回
任务对象，小程序 code 和注销接口只返回操作结果。

```http
POST /api/qq/login/status
POST /api/qq/miniapp/code
POST /api/qq/logout
```

`POST /api/qq/login/status` 请求体使用 `{"taskId":"..."}` 轮询状态。设置
`"refresh":true` 可以强制刷新二维码；带结尾斜杠的 `/api/qq/login/status/` 也兼容支持。

对于小程序 code 和注销接口，不存在或已经过期的任务统一返回：

```json
{"ok":false,"code":"TASK_EXPIRED","status":"expired"}
```

这两个接口不会返回任务详情、二维码图片或用户信息。

小程序授权接口默认会等待授权完成并执行 QQ 注销：

```http
POST /api/qq/miniapp/code
Content-Type: application/json

{"taskId":"{login-task-id}","appId":"1112386029"}
```

`1112386029` 是经典 QQ 农场小程序的 `appId` 示例。完整请求和响应格式请查看
[API 文档](docs/api.md)。

## 部署文档

- [NapCat 安装与配置](docs/napcat/install-and-config.md)
- [Windows 原生部署](docs/platforms/windows.md)
- [Linux 原生部署](docs/platforms/linux.md)
- [macOS 原生部署](docs/platforms/macos.md)
- [Docker 部署](docs/deploy/docker.md)
- [宝塔部署](docs/deploy/baota.md)
- [HTTP API 参考](docs/api.md)

## 验证

```bash
npm test
```

测试使用 HTTP 模拟服务，不会连接真实 NapCat。生产环境需要真实的 NapCat WebUI、
OneBot 服务和 OpenAuth 插件。
