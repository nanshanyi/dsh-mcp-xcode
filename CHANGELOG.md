# Changelog

## [1.0.0] - 2026-08-15

首个正式版本。

### 功能

- 通过 stdio JSON-RPC 2.0 桥接 Xcode Headless MCP(`xcrun mcpbridge`)
- 自动注册全部 Xcode MCP 工具为 `xcode_*` agent 工具(实测 Xcode 27 = 54 个),覆盖:
  - 工程创建/打开/编辑(`XcodeNewProject` / `XcodeOpenWorkspace` / `XcodeUpdate` / `XcodeWrite` 等)
  - 构建/测试/调试(`BuildProject` / `RunAllTests` / `InvokeDebuggerCommand` / `GetBuildLog` 等)
  - SwiftUI Preview 渲染与本地化(`RenderPreview` / `StringCatalog*` / `LocalizationPlanner`)
  - 模拟器/真机驱动(`DeviceInteraction*` / `RunProject` / `GetConsoleOutput`)
  - 崩溃与性能分析(`GetTopCrashIssues` / `GetFieldPerformanceIssueLogs` 等)
- 附带 `xcode_mcp_status` 控制工具:连接状态 / 强制重连 / stderr 诊断
- MCP JSON Schema → DSH schema 子集自动转换(enum / 嵌套对象 / 数组)
- 结果图片自动存入 attachment 并经 `deferContext` 注入下一轮模型上下文(模拟器截图对模型可见)
- 连接失败自动重连;工具调用支持取消转发(`notifications/cancelled`);插件卸载时终止子进程
- 零运行时依赖;`clientName` / `bridgePath` / `bridgeArgs` 可配置

### 已验证环境

- Xcode 27(27A5237l),xcode-tools server `25280.8`,protocolVersion `2025-06-18`
- DeepSeek Harness(web profile,宿主 composition 行 `dsh-mcp-xcode`)

### 安装

```bash
cd ~/.dsh/profiles/web
pnpm add file:/path/to/dsh-mcp-xcode     # 或 pnpm add github:nanshanyi/dsh-mcp-xcode
# 在 cordis.patch.yml 增加:
# - insert:
#     - id: mcp-xcode
#       name: 'dsh-mcp-xcode'
# 重启 DSH
```

前置:`xcrun mcp-server status` 显示 enabled + running;首次连接批准一次 Xcode agent 授权(DSH 为签名应用,批准长期有效)。
