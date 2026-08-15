# dsh-mcp-xcode

DeepSeek Harness (DSH) 插件:把 **Xcode Headless MCP**(`xcrun mcpbridge`)桥接为 DSH 原生工具。

装上之后,DSH agent 就能直接调用 Xcode 的全部 headless 能力:创建/打开工程、构建、测试、渲染 SwiftUI Preview 为 PNG、启动模拟器并交互(tap/type/swipe)、读截图与无障碍层级、读 OSLog 等 —— 无需打开 Xcode UI。

## 安装

一条命令(官方插件通道,`dsh plugin` 转发给 pnpm,支持 npm / GitHub / 本地路径):

```bash
# 从 GitHub 安装(推荐;v1.0.0 为最新标签)
dsh plugin --profile web add "github:nanshanyi/dsh-mcp-xcode#v1.0.0"

# 或本地路径
dsh plugin --profile web add file:/path/to/dsh-mcp-xcode
```

本包通过 `dsh.bundle.patch` 自描述挂载:安装后**无需编辑任何 profile 文件**,重启 DSH 即生效(设置 → 插件列表可见,`xcode_*` 工具对所有会话可用)。

> 如果你之前手动在 `cordis.patch.yml` 里写过本插件的行,请先删掉,避免双挂载。

## 前置条件(macOS + Xcode 27+)

**要求 Xcode 27 或更高**(headless MCP 从 Xcode 27 beta 5 起内置 `xcrun mcp-server` / `mcpbridge`,更早版本没有这些命令;本项目在 27.0 27A5237l 上开发验证):

```bash
# headless 服务需开启并运行
xcrun mcp-server status          # Permission: enabled / mcp-server: running
sudo xcrun mcp-server enable     # 若未启用
xcrun mcp-server start           # 若未运行
```

首次连接会弹 Xcode agent 授权框,批准一次即可。DSH 是签名应用,授权**永久有效**;未签名客户端则约 24 小时过期。

> 构建报 `Operation not permitted` 时,给 headless 服务授权工程所在文件夹(需 sudo):
> `sudo xcrun mcp-server allow-folder /path/to/your/projects`

## 原理

插件通过 `subprocess` 服务 spawn `/usr/bin/xcrun mcpbridge`,在 stdio 上自行实现 MCP(JSON-RPC 2.0)客户端:

1. `initialize`(protocolVersion `2025-06-18`)→ `notifications/initialized` → `tools/list`;
2. 把 `tools/list` 返回的每个工具(实测 Xcode 27 = **54 个**)的 JSON Schema 转成 DSH 参数 DSL,注册为 `xcode_<原名>` 工具;
3. 工具调用转发为 `tools/call`,文本内容聚合进结果;截图自动存入 attachment 并通过 `deferContext` 注入下一轮模型上下文;
4. 附带控制工具 `xcode_mcp_status`:查看连接状态 / 强制重连 / 查看 bridge stderr。

## 使用

直接自然语言描述即可,例如:

> 打开 /path/to/Project.xcodeproj,跑一遍单元测试,把失败的用例列出来

排障:让 agent 调用 `xcode_mcp_status`(必要时带 `reconnect: true`)。

## 安全说明

- 连接走的是 Xcode 官方 headless 权限模型:签名应用一次批准长期有效,无需 `--unsafe-always-allow-all-agents`。
- 插件不发布任何 service,不修改 Xcode 权限存储;停止/禁用插件会终止它持有的 mcpbridge 子进程。

## License

MIT
