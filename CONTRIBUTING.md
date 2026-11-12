# Git 协作规范

## 仓库与分支

- 远端 `origin`：<https://github.com/Jonasenjobana/cctvtool.git>。
- 当前工作副本通过 HTTPS 拉取，通过 `ssh://git@ssh.github.com:443/Jonasenjobana/cctvtool.git` 推送；SSH 命令及密钥选择保存在本地 Git 配置，新工作副本按本机认证方式配置。
- 主分支为 `master`，用于保存可集成的项目基线。
- 日常改动从最新 `master` 创建 `feat-<模块>` 分支；功能、修复、文档和维护任务均沿用此命名。
- 模块名使用小写英文字母、数字及连字符，例如 `feat-ptz`、`feat-calibration`、`feat-mcp`、`feat-docs`。
- 每个分支聚焦一个模块或任务，通过 Pull Request 合并到 `master`；推送前检查远端更新，保留已有历史，禁止强制推送 `master`。

## 提交信息

采用 Conventional Commits 格式，类型与模块使用英文，说明使用简体中文：

```text
<type>[(scope)][!]: <简要说明>

<可选正文：说明原因、约束及影响>

<可选页脚：关联事项或 BREAKING CHANGE>
```

`scope` 可省略；填写时使用实际模块名，例如 `ptz`、`calibration`、`mcp`、`repo`。破坏兼容的改动使用 `!`，并在正文或 `BREAKING CHANGE:` 页脚说明影响与迁移方式。

| 类型 | 用途 |
| --- | --- |
| `feat` | 新功能 |
| `fix` | 缺陷修复 |
| `docs` | 文档调整 |
| `style` | 不改变行为的格式调整 |
| `refactor` | 不增加功能、不修复缺陷的代码重构 |
| `perf` | 性能优化 |
| `test` | 测试调整 |
| `build` | 构建或依赖调整 |
| `ci` | 持续集成配置 |
| `chore` | 仓库配置等维护工作 |
| `revert` | 回退已有提交 |

示例：

```text
feat(calibration): 增加海天线样本复核
fix(ptz): 修复松开控制按钮后停止指令的顺序
docs(repo): 完善分支与提交规范
```

每次提交只包含一个完整目的，相关文档随行为调整一起提交。提交前检查差异和暂存文件，排除无关改动、认证信息、设备数据与生成文件。

## 日常流程

确认当前工作区改动已妥善处理后，更新主分支并创建工作分支：

```powershell
git switch master
git pull --ff-only origin master
git switch -c feat-calibration
```

完成改动后，按 [README](README.md#运行) 与 [项目规则](AGENTS.md#环境与验证) 执行必要验证，逐项暂存并检查：

```powershell
git status --short
git diff
git add <本次修改的文件路径>
git diff --cached --check
git diff --cached
git commit -m "feat(calibration): 增加海天线样本复核"
git push -u origin feat-calibration
```

在 GitHub 创建以 `master` 为目标分支的 Pull Request，说明改动目的、实际验证结果及未验证项。存在冲突时先核对双方改动并解决，再完成合并。

## 本地文件

`.env` 及其本地变体、`mcp.config.local.json`、`data/`、`node_modules/`、`dist/`、`.angular/`、日志和 Python 缓存由 `.gitignore` 排除；配置模板 `.env.example` 与 `mcp.config.example.json` 随源码维护，保持可公开的示例值。

`.scratch/` 中现有的方案地图与决策票作为项目研究文档随源码维护。待定方案和已实现功能分别在决策文档及 README/API 文档中描述。
