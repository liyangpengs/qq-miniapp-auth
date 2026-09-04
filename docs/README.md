# 文档目录

## NapCat

- [安装、插件和 OneBot 配置](napcat/install-and-config.md)

## 原生平台

- [Windows](platforms/windows.md)
- [Linux](platforms/linux.md)
- [macOS](platforms/macos.md)

## 快捷部署

- [Docker](deploy/docker.md)
- [宝塔](deploy/baota.md)

## 接口

- [HTTP API](api.md)

## 地址关系

```text
浏览器 --> Web 8787 --> 项目 bridge 9010 --> NapCat 插件 6099
                                      \--> NapCat OneBot 3000
```

项目 bridge 只使用 HTTP。不存在需要创建、挂载或清理的 `bridge.sock` 文件，也不需要配置 `BRIDGE_SOCKET`。

