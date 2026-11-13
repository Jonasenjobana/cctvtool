# 项目工作规则

- 始终使用简体中文，区分已确认事实、推断和待验证事项。
- 只解决当前问题，采用最小且完整的改动，沿用项目结构与已有依赖。
- 开始工作前，检查当前目录及父目录适用的 `AGENTS.md`、`AGENT.md`、`Agent.md`、`CLAUDE.md`，文件名匹配忽略大小写。
- 保留已有业务数据与无关改动；原始业务数据和 UI 展示数据分离，在展示边界转换。
- 保留必要的错误处理，明确暴露异常；中文注释重点解释原因、约束和取舍。
- 行为、接口、配置或流程变化时，同步维护对应文档及引用，以当前有效状态为准。

## 文档入口

| 路径 | 用途 | 阅读时机 |
| --- | --- | --- |
| [README.md](README.md) | 运行方式、功能基线、源码与验证入口 | 开始项目工作时 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 仓库、分支、提交与合并规范 | 创建分支、提交、推送或合并前 |
| [docs/API.md](docs/API.md) | 本工具与 LiveGBS 的接口、控制和持久化契约 | 修改前后端接口或设备接入时 |
| [docs/MCP使用说明.md](docs/MCP使用说明.md) | MCP 配置、认证、模型调用与排错 | 修改 MCP 或 ESSLD 接入时 |
| [GLOSSARY.md](GLOSSARY.md) | 海天线采样与标定术语 | 讨论预扫描、粗标定和正式扫描时 |
| [.scratch/horizon-aware-scan/map.md](.scratch/horizon-aware-scan/map.md) | 高倍率采样方案的决策地图与本地决策票 | 继续该方案研究时；其中候选方案不代表当前产品行为 |
| [.scratch/horizon-vertical-drift/map.md](.scratch/horizon-vertical-drift/map.md) | 海天线变倍与转向垂直偏差的证据、验证与修正决策 | 排查低倍对齐后高倍或转向出现上下错位时 |

## 环境与验证

- Windows 10，PowerShell 读取文本使用 `-Encoding UTF8`。
- 开发前检查 `package.json`、`.nvmrc` 和锁文件，按 `.nvmrc` 使用 nvm 切换 Node，沿用 npm 和 `package-lock.json`。
- 按改动范围选择 README 中的必要验证；完成时说明实际结果和未验证项。
- 不进行浏览器调试；源码检查、测试或构建不能替代浏览器、真实设备与现场精度验收。
- 本地凭据、设备数据及生成文件按 `.gitignore` 管理，提交前核对暂存文件。
