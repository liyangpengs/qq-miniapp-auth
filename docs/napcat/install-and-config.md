# NapCat 安装与配置

本项目依赖一个已经运行的 QQ/NapCat 实例。NapCat 负责 QQ 登录二维码、扫码状态和 QQ 内部 OpenAuth 调用；本项目负责把这些能力提供给浏览器和业务 API。

## 1. 安装 QQ 和 NapCat

请以 NapCat 当前版本的官方文档为准：

- 文档：<https://napneko.github.io/>
- 项目：<https://github.com/NapNeko/NapCatQQ>

各平台安装器、QQ 版本要求和插件加载方式会随 NapCat 版本变化，不要使用来源不明的修改版 QQ 文件。

基本流程如下：

1. 安装与当前 NapCat 版本匹配的官方 QQ 客户端。
2. 按官方文档安装 NapCat 并启动 QQ/NapCat。
3. 在 NapCat WebUI 中确认服务已启动，默认地址是 `http://127.0.0.1:6099/webui/`。
4. 先单独确认 NapCat 能正常登录和退出 QQ，再接入本项目。

本项目的自动注销有版本兼容回退：优先调用
`NodeIKernelLoginService.offline()`；NapCat 4.18.x 或部分 QQ wrapper 没有
该方法时，插件会构造当前账号的 session 配置并调用原生
`NodeIQQNTWrapperSession.offLine()`。注销成功后，项目会请求 NapCat
worker 重启并轮询 WebUI 的 `CheckLoginStatus`，确认 `isLogin=false` 后才
向客户端返回小程序 code 或释放给下一位用户。

平台文档中的项目安装步骤：

- [Windows](../platforms/windows.md)
- [Linux](../platforms/linux.md)
- [macOS](../platforms/macos.md)

项目本身的 Node.js 服务支持 Windows、Linux、macOS；但 NapCat/QQ 是否有可用构建，必须以 NapCat 官方当前版本说明为准。若目标平台没有可运行的 NapCat，项目无法凭空生成 QQ 二维码或授权 code。

## 2. 配置 OneBot HTTP Server

打开 NapCat WebUI：

```text
http://127.0.0.1:6099/webui/
```

进入“网络配置”或“Network”，找到“HTTP Server”/“OneBot HTTP Server”，新增并启用一个 HTTP 服务：

```text
Host: 127.0.0.1
Port: 3000
Token: 自定义的长随机字符串
```

保存后重启 NapCat。项目 `.env` 必须使用完全相同的地址和 token：

```ini
NAPCAT_API_URL=http://127.0.0.1:3000
NAPCAT_TOKEN=同一个OneBotToken
```

如果需要直接编辑文件，OneBot 配置通常位于 NapCat 的 `config` 目录，按账号保存为 `onebot11_<QQ号>.json`；公共回退模板为 `onebot11.json`。HTTP Server 的结构类似下面这样（保留你现有配置中的其他字段）：

```json
{
  "network": {
    "httpServers": [
      {
        "enable": true,
        "host": "127.0.0.1",
        "port": 3000,
        "token": "同一个OneBotToken",
        "enableCors": false,
        "enableWebsocket": false
      }
    ]
  }
}
```

优先推荐通过 WebUI 保存，避免覆盖 NapCat 版本特有的其他配置项。

在 Docker 部署中，容器访问宿主机的 NapCat，`Host` 不能只绑定宿主机回环地址；请改为宿主机私网地址或受防火墙保护的可达地址，详见 [Docker 部署](../deploy/docker.md)。原生部署时建议保持 `127.0.0.1`。

可以用下面的请求验证 OneBot：

```bash
curl -H "Authorization: Bearer 同一个OneBotToken" \
  -H "Content-Type: application/json" \
  -d '{}' http://127.0.0.1:3000/get_login_info
```

## 3. 安装 `qq-miniapp-openauth` 插件

插件源码在项目的 `napcat-openauth-plugin` 目录。插件提供：

- `GET /plugin/qq-miniapp-openauth/api/status`
- `POST /plugin/qq-miniapp-openauth/api/miniapp`
- `POST /plugin/qq-miniapp-openauth/api/logout`

### Windows

完全退出 QQ/NapCat 后，在项目根目录执行：

```powershell
Copy-Item .env.example .env
notepad .env
.\install-napcat-plugin.ps1 -NapCatRoot "D:\lyp-soft\NapCat"
```

脚本会：

- 将插件复制到 `NapCat\plugins\qq-miniapp-openauth`；
- 写入 `NapCat\config\plugins\qq-miniapp-openauth\config.json`；
- 启用插件并补充 NapCat 的第三方插件白名单；
- 生成或复用 `NAPCAT_OPEN_AUTH_PLUGIN_TOKEN` 并写入项目 `.env`。

脚本不会修改 QQ 的 `resources\app\package.json`，不会安装额外的主进程 loader，不会创建项目备份或重启删除登记。运行结束后重启 NapCat。

如果 PowerShell 阻止脚本执行，只对当前窗口放行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
```

### Linux/macOS

在 NapCat 完全退出时，把插件目录内容复制到 NapCat 的插件目录：

```bash
mkdir -p "/path/to/NapCat/plugins/qq-miniapp-openauth"
cp -R napcat-openauth-plugin/. "/path/to/NapCat/plugins/qq-miniapp-openauth/"
mkdir -p "/path/to/NapCat/config/plugins/qq-miniapp-openauth"
```

先将 `/path/to/NapCat` 替换为实际 NapCat 目录，再执行命令。

在 `config/plugins/qq-miniapp-openauth/config.json` 写入一个长随机 token，并把同一个值放入项目 `.env`：

```json
{
  "token": "替换为长随机字符串"
}
```

在 NapCat WebUI 的插件管理中启用 `qq-miniapp-openauth`。如果当前 NapCat 版本还要求第三方插件白名单，请按该版本官方方式启用此 ID；不要修改 QQ 的 `resources/app/package.json`。完成后重启 NapCat。

## 4. 验证插件

如果插件配置了 token，请带上请求头：

```bash
curl -H "Authorization: Bearer 插件token" \
  http://127.0.0.1:6099/plugin/qq-miniapp-openauth/api/status
```

应看到类似结果：

```json
{
  "ok": true,
  "ready": true,
  "logoutAvailable": true,
  "methods": ["checkSessionForMiniApp", "loginWithAppId"]
}
```

`ready` 必须为 `true`，并且 `methods` 中应有 `loginWithAppId`；
`logoutAvailable` 必须为 `true`。当使用 wrapper 回退时，
`logoutSessionMethods` 中通常会包含 `offLine` 或 `offLineSync`，这是正常
现象，不需要额外安装旧的 QQNT 控制接口。如果这些字段不满足，检查插件
目录层级、token 和 NapCat 重启状态。

## 5. 多 QQ 账号串行配置

NapCat 通常按 QQ 号保存 OneBot 配置：

```text
<NapCat目录>/config/onebot11_<QQ号>.json
```

加载时会优先读取当前 QQ 的文件；不存在时回退到公共模板 `onebot11.json`，随后由 NapCat 保存当前账号文件。因此不需要提前为每个新 QQ 手动生成文件。建议先在一个账号上配置好 HTTP Server，再复制一份为 `onebot11.json` 作为公共模板。

切换 QQ 的串行流程是：

1. 用户 A 扫码登录并获取 code。
2. 项目调用插件的原生注销（`offline()` 或 `WrapperSession.offLine()`）。
3. 项目请求 worker 重启并确认 NapCat 已回到未登录状态，再让用户 B 扫码。
4. NapCat 会为 B 加载或生成 `onebot11_B.json`。

如果切换后 OneBot 仍返回上一个 QQ，先在 NapCat WebUI 执行一次“重启 NapCat”，等待 WebUI 恢复后再开始下一次登录。不要同时运行第二个 NapCat。
