# 截图标定 MCP 使用说明

该服务通过 **Streamable HTTP** 向局域网内的 MCP 客户端提供截图查询、原图读取和 P 轴倾斜计算。客户端连接固定 URL，由具备视觉能力的大模型识别海天线；服务端从数据库读取对应 PTZ/FOV 并完成数值拟合。

## 连接信息

| 项目 | 配置 |
| --- | --- |
| 协议 | Streamable HTTP，客户端界面也可能显示为 HTTP MCP |
| 当前主机地址 | `http://10.10.101.132:3001/mcp` |
| 健康检查 | `http://10.10.101.132:3001/health` |
| 认证 Header | `Authorization: Bearer <MCP_API_KEY>` |
| 服务端入口 | `server/mcp-http.mjs` |
| 运行环境 | 服务端 Node 22.22.3、npm 10.9.8；远端客户端无需安装本项目或访问服务端磁盘 |

部署到其他主机或更换 IP、端口时，替换连接地址。`0.0.0.0` 表示监听所有网卡，客户端应使用服务端实际局域网 IP。

服务使用独立 MCP 访问密钥，与 LiveGBS 登录 token 分开。只有四个只读标定工具；不提供云台移动、截图采集或配置写入。原图通过 MCP `image` 内容块返回，无需共享文件夹，也不需要访问截图记录中的相对 `imageUrl`。

## 服务端启动

先通过网页注册摄像头并保存截图，使 `DATA_DIR` 中已有 `cctv.sqlite` 和图片。MCP 与网页共用这份数据，可单独运行，不依赖网页进程保持开启。

在项目目录运行：

```powershell
nvm use 22.22.3
npm ci
npm run mcp
```

`.env` 中的相关配置：

```dotenv
DATA_DIR=./data
MCP_HOST=0.0.0.0
MCP_PORT=3001
MCP_API_KEY=<填写独立访问密钥>
MCP_ALLOWED_HOSTS=
MCP_ALLOWED_ORIGINS=
```

| 配置 | 说明 |
| --- | --- |
| `DATA_DIR` | 数据目录，相对路径以项目根目录解析 |
| `MCP_HOST` | 默认 `0.0.0.0`，允许局域网访问 |
| `MCP_PORT` | 默认 `3001`，与网页后端独立 |
| `MCP_API_KEY` | 必填，客户端使用相同值；已有密钥时继续使用 |
| `MCP_ALLOWED_HOSTS` | 额外允许的服务主机名，不含端口，逗号分隔；默认已允许本机 IP、主机名和 localhost |
| `MCP_ALLOWED_ORIGINS` | 浏览器客户端的完整 Origin，含协议与端口，逗号分隔；一般后端、桌面 MCP 客户端不发送 Origin，无需填写 |

首次配置可生成随机密钥，再填写到 `.env`：

```powershell
node --input-type=module -e "import { randomBytes } from 'node:crypto'; console.log(randomBytes(32).toString('hex'))"
```

修改监听地址、密钥、主机名白名单或 Origin 后，重启 MCP 服务。修改摄像头已保存参数或新增截图后，无需重启；每次工具请求都会读取当前数据库。

## 客户端配置

在大模型应用的 MCP 设置中选择 Streamable HTTP，填写上述 URL 与认证 Header。模型须支持图片，客户端也须将 MCP 图片内容传给模型，才能进行海天线识别。

常见 JSON 配置形式如下，具体导入字段以客户端约定为准：

```json
{
  "mcpServers": {
    "cctv-tilt-calibration": {
      "url": "http://10.10.101.132:3001/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_API_KEY>"
      }
    }
  }
}
```

通用模板见 [mcp.config.example.json](../mcp.config.example.json)。当前主机另有包含实际连接密钥的 `mcp.config.local.json`，可用于导入获授权的客户端；该文件已忽略提交。密钥变更后同步更新客户端配置。

## 工具与调用流程

| 工具 | 输入 | 用途 |
| --- | --- | --- |
| `list_cameras` | `{}` | 摄像头 ID、安装参数、截图数量及可用起止时间 |
| `query_snapshots` | `cameraId`、`startTime`、`endTime`，可选 `groupId/limit/offset` | 按摄像头和时段查询截图及原始 PTZ/FOV，可按一次自动截图任务分组筛选，支持分页 |
| `get_snapshot` | `snapshotId` | 返回原图图片内容及采样元数据 |
| `estimate_p_axis_tilt` | `cameraId`、`startTime`、`endTime`、`observations` | 根据海天线标注与采样 PTZ/FOV 计算 P 轴倾斜 |

建议给 AI 的任务描述：

> 使用截图标定 MCP，先确定摄像头及分析时间段，再读取该时段的原图。只标注能够确认的远处海天线，不把岸线、船体、近处波浪或文字当成海天线。结合采样 PTZ 和接口 FOV 计算 P 轴前后倾、左右倾，说明来源截图、误差和假设。样本不足或拟合不可靠时明确说明，不编造点位或角度，不声称已写回配置。

具体步骤：

1. 调用 `list_cameras`，使用返回的本地 `id` 作为 `cameraId`；确认用户要求的摄像头和时间段。
2. 调用 `query_snapshots`。时间必须带时区，开始包含、结束不包含，按截图 `createdAt` 筛选。例如北京时间 `2026-11-09T11:00:00+08:00`。若分析一次自动扫描，传入任务的 `groupId`，结果中的每张图也带分组 ID。有 `nextOffset` 时继续分页。自动采集从实时右侧表单或 [HTTP 扫描接口](API.md#自动扇区截图与任务接口)发起，MCP 继续只读。
3. 选择停稳且海天线可确认的截图，跳过 `poseChanged`、海天线不可见或遮挡严重的图片。拟合质量由实际收敛、可辨识性和残差决定；样本较少或方向集中时，对标注及固定参数误差更敏感。
4. 对每张候选图调用 `get_snapshot`，实际查看其 MCP 图片内容。每图至少标注两个海天线点，横向跨度至少为图宽 10%。
5. 将标注归一化：左上角为原点，`x=像素横坐标/图片宽度`，`y=像素纵坐标/图片高度`，范围均为 0～1。调用拟合工具时不自行提交或替换 PTZ/FOV。
6. 调用 `estimate_p_axis_tilt`，向用户说明结果和限制。复核后，由用户在网页填写前后倾、左右倾并保存。

查询参数示例：

```json
{
  "cameraId": "<list_cameras 返回的 id>",
  "startTime": "2026-11-09T11:00:00+08:00",
  "endTime": "2026-11-09T12:00:00+08:00",
  "limit": 50,
  "offset": 0
}
```

拟合参数结构如下。**点位数值仅演示结构，真实调用必须查看对应原图后重新标注。**

```json
{
  "cameraId": "<cameraId>",
  "startTime": "2026-11-09T11:00:00+08:00",
  "endTime": "2026-11-09T12:00:00+08:00",
  "observations": [
    { "snapshotId": "<截图1的id>", "points": [{ "x": 0.1, "y": 0.4 }, { "x": 0.9, "y": 0.42 }] },
    { "snapshotId": "<截图2的id>", "points": [{ "x": 0.1, "y": 0.45 }, { "x": 0.9, "y": 0.43 }] },
    { "snapshotId": "<截图3的id>", "points": [{ "x": 0.1, "y": 0.46 }, { "x": 0.9, "y": 0.47 }] }
  ]
}
```

## 结果解释

| 字段或状态 | 含义 |
| --- | --- |
| `status=estimated` | 数值检查通过，`installation` 返回可复核的估计 |
| `status=insufficient_data` | 没有有效的停稳截图和海天线标注，安装角度为 `null` |
| `status=unreliable` | 未收敛、不可辨识或均方根误差超过 5 像素，安装角度为 `null` |
| `installation.pAxisPitch/pAxisRoll` | 前后倾、左右倾，单位度 |
| `diagnostics` | 总体和逐图残差、收敛情况等 |
| `fixedCalibration` | 本次使用的安装位置、高度、P/T 偏移及画面 Roll |
| `applied` | 始终为 `false`，MCP 不写回结果 |

当前模型为 `wgs84-horizon-p-axis-v3`，与网页共用参考 Cesium 的安装 Z-X-Y 旋转链。经纬度、高度、P/T 偏移和画面 Roll 使用当前保存值，本次只求解 P 轴两个倾角。截图/PTZ 尚未确认严格同步，拟合通过不代表现场精度已经验收。完整契约见 [API 文档](API.md#截图标定-mcp)。

## ESSLD 独立离线试跑

网页中的本地识别、人工编辑、四参数生成与直接应用见 [本地模型识别与安装参数](../README.md#本地模型识别与安装参数)。本节用于独立评测模型，与网页共用 `scripts/essld_model.py` 的推理流程。

使用 [ESSLD 官方实现](https://github.com/kaibaJC/ESSLD)和仓库内的预训练权重，只读本地 `cctv.sqlite` 及 `snapshots/`，将原图、分割掩膜、粗线与精修线保存到独立目录。该流程不连接摄像头、不调用 MCP 或 PTZ 拟合，也不写入业务数据库。

本机环境在 `data/essld/.venv/`，上游源码和权重在 `data/essld/upstream/`。使用 Python 3.11.15、CPU PyTorch，主要依赖固定在 [essld-requirements.txt](../scripts/essld-requirements.txt)。模型只使用 MMCV 的归一化层，因此安装 `mmcv-lite`，无需编译 CUDA 算子；OpenCV 固定为 4.12，保持原版 Hough 线段输出格式兼容。

环境已准备好时，在项目根目录运行：

```powershell
$env:PYTHONUTF8 = '1'
data/essld/.venv/Scripts/python.exe scripts/essld-evaluate.py
```

默认评测 `data/` 中全部截图，每轮保存到新的 `data/essld/runs/<时间>/`，不覆盖旧结果。可用 `--data-dir <数据目录>` 指定其他 `DATA_DIR`，用 `--camera-id <本地摄像头ID>` 或 `--zoom 15` 筛选；脚本不自动读取 `.env`。`--output-dir <新目录>` 可以指定输出位置，目标目录必须尚不存在。

| 输出 | 用途 |
| --- | --- |
| `review.html` | 本地复核页，逐图比较原图、叠线和分割掩膜，点击图片查看原尺寸 |
| `contact-sheet.jpg` | 全部叠线结果的缩略图总览 |
| `images/` | 原始图片副本、原尺寸叠线 PNG 和掩膜 PNG |
| `results.json` | 截图 ID、原始 PTZ、粗线、最终线、归一化点位、耗时、失败或回退原因、源码提交、权重哈希与运行环境 |

红色实线表示最终候选，黄色虚线表示分割粗线。`detected` 只表示原版算法返回候选，不代表识别正确或通过标定；`no_detection` 表示没有候选，`out_of_frame` 表示候选在导出点位处超出画面，`error` 表示该图处理失败。精修未得到结果或抛出异常时，沿用原版的粗线回退；异常同时记录到 `warnings`。归一化点取 `x=0.1/0.9`，按原图宽高计算，不裁剪超界坐标。图像倾角的正方向为右侧向下，不等于 P 轴倾斜。

本机样本 `data/essld/runs/20261109-essld/` 包含 1 张 15 倍和 18 张 8.8 倍截图。15 倍原图只有海水及近处礁石，没有海天线，模型仍返回了候选；8.8 倍样本含岛屿、岸线和船体，部分候选穿过山体或近处海面，贴合岸线也不能证明它是真正海天线。因此默认模型输出仍需逐图复核，不能直接用于倾斜拟合。当前没有人工真值标注，未计算像素误差、斜率误差或准确率。

重建独立环境时使用以下步骤；不使用上游包含说明文字及 CUDA 依赖的 `requirements.txt`：

```powershell
git clone --depth 1 https://github.com/kaibaJC/ESSLD.git data/essld/upstream
git -C data/essld/upstream checkout 902afc89ce901f518f056dad3a97a01ac60d1ca8
uv venv --python 3.11.15 data/essld/.venv
uv pip install --python data/essld/.venv/Scripts/python.exe --link-mode copy 'torch==2.15.0+cpu' --index-url https://download.pytorch.org/whl/cpu
uv pip install --python data/essld/.venv/Scripts/python.exe --link-mode copy -r scripts/essld-requirements.txt
```

## 直接通过 HTTP 检查

MCP 使用同一个 `/mcp` URL，工具名放在 JSON-RPC 请求中。HTTP 响应可能是 JSON 或 SSE，MCP 客户端负责处理；它不是每个工具各一个 REST 路由。

Windows PowerShell 示例：

```powershell
$mcpEndpoint = 'http://10.10.101.132:3001/mcp'
$mcpAccessKey = '<MCP_API_KEY>'
$mcpHeaders = @{
  Authorization = "Bearer $mcpAccessKey"
  Accept = 'application/json, text/event-stream'
  'MCP-Protocol-Version' = '2025-03-26'
}
$mcpBody = @{
  jsonrpc = '2.0'
  id = 1
  method = 'tools/list'
} | ConvertTo-Json -Depth 10
(Invoke-WebRequest -Uri $mcpEndpoint -Method Post -Headers $mcpHeaders -ContentType 'application/json' -Body $mcpBody -UseBasicParsing).Content
```

调用工具时将请求体改为：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": { "name": "list_cameras", "arguments": {} }
}
```

服务兼容 2025 版 Streamable HTTP 客户端和当前 SDK 的逐请求协议。不使用会话 ID，无需会话保持；GET `/mcp` 返回 405 是正常行为，健康检查应访问 `/health`。

## 连接排错

- 连接超时：确认服务已运行、URL 使用正确局域网 IP、端口可达。在客户端执行 `Test-NetConnection 10.10.101.132 -Port 3001`，或访问 `/health`。
- HTTP 401：检查客户端 Header 中的密钥是否与服务端 `MCP_API_KEY` 一致。
- HTTP 403：使用自定义服务域名时，将主机名加入 `MCP_ALLOWED_HOSTS`；浏览器客户端将其完整 Origin 加入 `MCP_ALLOWED_ORIGINS`，然后重启 MCP。
- 不能识图：确认客户端会把 MCP `image` 内容传给视觉模型；相对 `imageUrl` 和服务端本地文件路径不作为远端看图入口。
- 没有数据：检查 `DATA_DIR`，先在网页保存截图，并使用明确时区及正确的摄像头 ID 查询。

若服务已监听而 Windows 防火墙未放行，可在服务端以管理员 PowerShell 添加仅限本地子网的入站规则：

```powershell
New-NetFirewallRule -DisplayName 'CCTV MCP LAN 3001' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3001 -RemoteAddress LocalSubnet
```

端口修改后同步调整规则。跨设备是否可达需在目标客户端验证，本机调用内网地址不能代替该验证。

本机 stdio 兼容入口保留为 `npm run --silent mcp:stdio`，仅供需要客户端启动本地进程的接入方式使用。
