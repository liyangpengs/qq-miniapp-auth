# HTTP API

Web 服务默认地址为 `http://127.0.0.1:8787`。浏览器请求会收到 HttpOnly 的 `qqma_session` cookie；后续轮询必须携带同一个 cookie，其他浏览器不能读取该任务。

## 获取 QQ 登录二维码

```http
POST /api/qq/login/qrcode
```

也支持 `GET`。成功返回 `200`，示例字段：

```json
{
  "ok": true,
  "taskId": "任务ID",
  "status": "pending",
  "state": "waiting_scan",
  "qrImage": "data:image/png;base64,...",
  "expiresAt": 0,
  "task": { "id": "任务ID", "kind": "napcat-login" }
}
```

二维码来自 NapCat WebUI 的 `QQLogin/GetQQLoginQrcode`，服务只负责转换成浏览器可显示的图片，不生成假二维码，也不会跳转到 NapCat WebUI。

同一浏览器重复请求会复用任务；其他浏览器在当前工作流结束前收到 `409 WORKFLOW_BUSY`。

## 轮询扫码状态

```http
GET /api/qq/login/status/{taskId}
```

也支持 `POST /api/qq/login/status/{taskId}` 和 `POST /api/qq/login/refresh/{taskId}`（刷新二维码）。`state` 的含义：

| state | 含义 |
| --- | --- |
| `waiting_scan` | 等待用户扫码 |
| `scanned` | 已扫码，等待手机确认 |
| `confirmed` | 已确认登录，QQ 已登录 |
| `cancelled` | 用户取消或拒绝 |
| `expired` | 二维码或任务过期 |
| `failed` | NapCat 返回错误 |

成功时响应还包含 `user`。只有 `state=confirmed` 后才能获取小程序 code。

## 获取当前用户信息

```http
GET /api/user
```

返回 NapCat OneBot `get_login_info` 的用户数据；OneBot 不可用时会尝试 NapCat WebUI 的 `QQLogin/GetQQLoginInfo`。如果其他浏览器占用工作流，返回 `409 WORKFLOW_BUSY`。

## 通过 appId 获取小程序授权 code

```http
POST /api/qq/miniapp/code
Content-Type: application/json

{"appId":"1112386029"}
```

`appId` 允许 3-128 个 ASCII 字母、数字、下划线或短横线。请求必须来自已经完成扫码登录的同一浏览器 session。接口先快速创建任务，然后轮询：

```http
GET /api/qq/miniapp/status/{taskId}
```

成功响应包含真实 code，并自动注销 QQ：

```json
{
  "ok": true,
  "status": "success",
  "code": "真实的qq.login授权code",
  "logoutStatus": "success",
  "released": true
}
```

`logoutStatus=failed` 表示 code 已取得但 NapCat 注销失败；服务会阻止下一位用户开始工作流，直到自动重试注销成功。`login_required` 表示 QQ 尚未登录。

## 错误码

- `WORKFLOW_BUSY`：唯一 NapCat 正被其他浏览器使用；
- `WORKFLOW_REQUIRED` / `LOGIN_REQUIRED`：尚未完成当前浏览器的扫码登录；
- `LOGOUT_REQUIRED`：上一位用户注销未完成；
- `404`：任务不存在，或任务属于其他浏览器 session；
- `502`：NapCat、插件或 bridge 返回错误。

## 内部 bridge 接口

项目 Web 会调用本机 bridge，普通业务客户端不应直接暴露它：

```http
POST /api/miniapp/login/start
GET  /api/miniapp/login/status/{taskId}
POST /api/qq/logout
GET  /health
```

bridge 默认监听 `127.0.0.1:9010`，可通过 `BRIDGE_TOKEN` 加 Bearer token。项目完全使用 HTTP，不需要 `BRIDGE_SOCKET`、Unix socket 或 Windows named pipe。

