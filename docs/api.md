# HTTP API 接口文档

公开 Web API 只有四个业务接口，所有接口都返回 HTTP `200`，调用方通过 `ok` 字段
判断成功或失败。二维码状态接口返回任务对象；小程序 code 和注销接口只返回操作结果，
不会返回任务详情。

四个业务接口都要求在 `X-API-Signature` 请求头中传入 `API_SIGNING_SECRET` 配置的固定值。
默认值为 `qq-miniapp-auth-default-signing-secret`，生产环境应修改。诊断接口
`GET /api/health` 不要求签名。签名只进行字符串直接比较，不使用 HMAC、哈希、时间戳、
随机数或其他加密/签名算法。

服务默认地址为 `http://127.0.0.1:8787`。二维码接口返回的 `task.id` 是调用方后续请求
使用的任务标识，不创建也不要求 cookie。

## 1. 获取登录二维码

```http
POST /api/qq/login/qrcode
X-API-Signature: qq-miniapp-auth-default-signing-secret
```

示例响应：

```json
{
  "ok": true,
  "task": {
    "id": "login-task-id",
    "type": "qq-login",
    "status": "waiting_scan",
    "qrImage": "data:image/png;base64,...",
    "expiresAt": 1700000000000
  }
}
```

## 2. 查询扫码状态并刷新二维码

```http
POST /api/qq/login/status
Content-Type: application/json
X-API-Signature: qq-miniapp-auth-default-signing-secret

{"taskId":"login-task-id"}
```

每次请求都会向 NapCat 查询最新状态和二维码。如果 NapCat 返回了新的二维码，响应中的
`task.qrUrl` 或 `task.qrImage` 会同步更新。

如需强制让 NapCat 生成新的二维码，请传入 `refresh: true`：

```http
POST /api/qq/login/status/
Content-Type: application/json
X-API-Signature: qq-miniapp-auth-default-signing-secret

{"taskId":"login-task-id","refresh":true}
```

刷新后任务状态会重置为 `waiting_scan`，二维码会被替换，任务有效期也会重新计算。
带结尾斜杠的地址只是兼容写法，参数仍然必须放在 JSON 请求体中。

`task.status` 可能是以下值：

| 状态 | 含义 |
| --- | --- |
| `waiting_scan` | 等待用户扫码 |
| `scanned` | 已扫码，等待用户确认 |
| `confirmed` | QQ 登录已确认 |
| `cancelled` | 任务已取消 |
| `expired` | 任务已超过有效期 |
| `failed` | NapCat 返回错误 |

任务对象还可能包含 `scanned`、`confirmed` 和 `cancelled` 标记。公开状态响应不包含用户
资料，只有 `confirmed` 状态才能请求小程序授权 code。

## 3. 获取小程序授权 code 并注销登录

```http
POST /api/qq/miniapp/code
Content-Type: application/json
X-API-Signature: qq-miniapp-auth-default-signing-secret

{"taskId":"login-task-id","appId":"1112386029"}
```

接口默认会等待 OpenAuth 授权完成，然后注销 QQ，并确认 NapCat worker 已经退出登录，
最终只返回操作结果和真实授权码：

```json
{
  "ok": true,
  "code": "real-qq-login-code"
}
```

响应不会包含登录任务、二维码图片、用户信息或内部小程序任务。`appId` 必须是长度
3-128 位、仅包含 ASCII 字母、数字、下划线或短横线的字符串。

## 4. 取消任务或注销登录

```http
POST /api/qq/logout
Content-Type: application/json
X-API-Signature: qq-miniapp-auth-default-signing-secret

{"taskId":"login-task-id-or-miniapp-task-id"}
```

对于等待扫码或已扫码的登录任务，接口会取消二维码任务。对于已经确认登录或小程序
任务，接口会注销 QQ 并释放工作流。成功时只返回：

```json
{"ok":true}
```

此接口不会返回二维码图片或任务详情。

已过期、已取消以及已经完成 code/注销的任务会立即从内存任务缓存中删除。之后再次使用
旧任务 ID 时会统一返回 `TASK_EXPIRED`，本地不会保留失效任务数据。

## 错误响应

所有公开 API 错误仍然返回 HTTP `200`，并且 `ok` 为 `false`。

签名缺失或错误时分别返回 `SIGNATURE_REQUIRED` 或 `INVALID_SIGNATURE`。

对于 `/api/qq/miniapp/code` 和 `/api/qq/logout`，不存在或过期的任务不会返回任务详情：

```json
{
  "ok": false,
  "code": "TASK_EXPIRED",
  "status": "expired",
  "error": "Task not found or expired"
}
```

- `WORKFLOW_BUSY`：已有其他任务正在占用唯一的 NapCat 工作流；
- `LOGIN_REQUIRED`：提供的登录任务尚未确认；
- `LOGOUT_REQUIRED`：上一位用户尚未完成 QQ 注销；
- `TASK_EXPIRED`：任务 ID 不存在或任务已经过期；
- 其他上游或参数校验错误也会通过 `ok: false` 返回。

`GET /api/health` 是诊断接口，不属于四个业务接口，也不要求签名。bridge 接口属于
内部接口，不是公开客户端 API。
