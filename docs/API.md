# LiveGBS 接口参考

本文供后端适配使用。2026-11-09 已通过 `curl.exe` 验证登录、PTZ 回读和实时快照；连续与精确控制尚未向真实设备下发，实现依据接口资料并通过模拟上游回归。实测仅代表本服务及本设备，不作为所有 LiveGBS 版本的统一契约。

验证服务为 `http://192.168.1.15:10000`，设备 `serial=34020000001320000088`，通道 `code=34020000001320000001`。

示例中的 `<LIVEGBS_ORIGIN>`、`<USERNAME>`、`<PASSWORD>`、`<TOKEN>`、`<COOKIE_TOKEN>`、`<SERIAL>`、`<CODE>` 均需由后端配置或实际响应替换，文档不保存真实凭据。`serial`、`code` 按字符串处理。

## 本工具的前后端接口

浏览器通过下列本工具接口操作设备，LiveGBS API 登录、token 缓存与认证重试由后端负责。开发时由 Angular 代理到 Fastify，生产时由 Fastify 同源提供页面与接口。实时媒体根据后端返回的拼接地址直连 CMS WebSocket。

| 方法与路径 | 请求与响应 |
| --- | --- |
| `GET /api/health` | 返回 `status` 和 `livegbsConfigured`，不返回认证信息 |
| `GET /api/playback?cameraId=<ID>` | 返回指定摄像头的 `{ url, serial, code, smsId }`，未传 ID 时使用默认通道；`url` 为 WS-FLV 地址，不包含登录凭据或 token |
| `GET /api/cameras` | 返回数据库中的设备列表 |
| `POST /api/cameras` | 注册设备，返回 HTTP 201 及保存后的完整记录 |
| `PUT /api/cameras/:id` | 完整保存当前设备配置，返回数据库记录 |
| `GET /api/plot-layers` | 返回全部标绘图层摘要，不携带 GeoJSON 原文 |
| `GET /api/plot-layers/:id` | 返回标绘图层详情及原始 `geojsonText` |
| `POST /api/plot-layers` | `{ name, sourceFileName, geojsonText, cameraIds }` 导入独立图层，HTTP 201 返回详情 |
| `PUT /api/plot-layers/:id` | `{ name, cameraIds }` 保存共享名称和完整关联集合，返回摘要 |
| `PUT /api/plot-layers/:id/cameras/:cameraId` | `{ visible }` 保存已有摄像头关联的显隐，返回 `{ cameraId, visible }` |
| `DELETE /api/plot-layers/:id` | 删除图层原文、元数据和全部摄像头关联，成功返回 HTTP 204 |
| `GET /api/cameras/:id/ptz` | 返回 `{ raw, requestedAt, receivedAt, durationMs }`；`raw` 为上游 PTZ 业务值 |
| `POST /api/cameras/:id/control` | 接收 `{ command, speed? }`，转发连续控制或停止，返回 `{ command, speed, sentAt }` |
| `POST /api/cameras/:id/precise` | 接收完整 `{ pan, tilt, zoom }`，供高级表单和临时点手动追踪下发原始精确定位，返回 `{ target, sentAt }` |
| `GET /api/cameras/:id/snapshots` | 返回该通道截图记录，按创建时间倒序排列 |
| `POST /api/cameras/:id/snapshots` | 接收 `{ calibration? }`，完成前后回读、抓图、图片和元数据保存，返回 HTTP 201 及截图记录 |
| `GET /api/snapshots/:id/image` | 读取已保存图片的二进制内容 |
| `DELETE /api/snapshots/:id` | 删除单张截图及图片文件，成功返回 HTTP 204；扫描或控制期间返回 409 |
| `POST /api/cameras/:id/snapshot-scans` | 按当前基础 PTZ 和 P 范围创建普通任务；带 `horizon` 时创建海天线低倍率预扫，HTTP 202 返回任务组 |
| `GET /api/cameras/:id/snapshot-groups` | 截图分组分页，含扫描组与手动／旧截图的单张组 |
| `GET /api/snapshot-groups/:id` | 读取任务／分组摘要和当前进度 |
| `GET /api/snapshot-groups/:id/snapshots` | 读取组内截图分页 |
| `GET /api/snapshot-tasks` | 自动截图任务分页，可用 `cameraId` 筛选设备 |
| `POST /api/snapshot-tasks/:id/pause` | 暂停任务，等待在途请求及 stop 完成后返回任务状态 |
| `POST /api/snapshot-tasks/:id/start` | 继续暂停／失败／中断的任务；已拍满时仅重试停止与完成收尾，HTTP 202 返回任务组 |
| `POST /api/snapshot-tasks/:id/cancel` | 取消执行中或暂停的任务，已保存图片保留 |
| `POST /api/recognition-tasks` | `{ sourceTaskId }` 从暂停或结束的截图任务创建本地识别任务，返回 HTTP 202 |
| `GET /api/recognition-tasks` | 识别任务分页，返回 `{ tasks, total, offset, nextOffset }` |
| `GET /api/recognition-tasks/:id` | 任务状态、模型进度、标注版本和计算结果 |
| `GET /api/recognition-tasks/:id/items` | 图片与标注分页，返回 `{ task, items, total, offset, nextOffset }` |
| `PUT /api/recognition-tasks/:id/items/:snapshotId` | 保存 `{ revision, points?, ignored? }`，返回 `{ task, item }` |
| `POST /api/recognition-tasks/:id/cancel` | 取消排队或运行中的本地模型识别，保留已有结果 |
| `POST /api/recognition-tasks/:id/generate` | `{ revision }` 联合生成四项安装修正，返回任务及结果，不写设备配置 |
| `POST /api/recognition-tasks/:id/apply` | `{ revision, resultId }` 应用服务端保存的最新合格结果，返回 `{ task, camera }` |
| `POST /api/recognition-tasks/:id/horizon-scan` | `{ revision, resultId, reviewed: true }` 用已复核粗结果创建高倍率正式扫描，HTTP 202 返回截图任务组 |

设备创建与保存的请求体为：

```json
{
  "name": "摄像头名称",
  "serial": "<SERIAL>",
  "code": "<CODE>",
  "maxZoom": 73,
  "longitude": null,
  "latitude": null,
  "height": null,
  "pAxisPitch": 0,
  "pAxisRoll": 0,
  "panOffset": 0,
  "tiltOffset": 0,
  "imageRoll": 0
}
```

经纬度和高度可留空注册；P 轴前后倾、左右倾、P/T 偏移及画面 Roll 修正为必填数字。位置采用 WGS84 经纬度与椭球高度，角度用度，高度用米。`tiltOffset/imageRoll` 范围为 -180°～180°，页面初始为 0。T 偏移正值上抬，对应局部 `Rx(tiltOffset - Tilt)`；画面 Roll 在 P/T 之后绕光轴应用 `Ry(imageRoll)`。`serial + code` 唯一，名称及编号均按字符串保存。

`panOffset` 表示安装坐标系的默认方位，真北为 0°、向东为 90°。固定安装矩阵为 `Rz(-panOffset) × Rx(pAxisPitch) × Ry(pAxisRoll)`，随后应用设备局部 `Rz(-Pan) × Rx(tiltOffset - Tilt) × Ry(imageRoll)`。前后倾和左右倾以此安装坐标系为参考，与参考 Cesium 场景的安装 Z-X-Y 旋转约定一致。

`maxZoom` 为每台摄像头持久保存的最大倍率，数字且不小于 1；新建请求省略时，名称为“天津船闸”默认 32，其他默认 73；更新请求省略时保留已保存值。名称变化不重置上限。前端在“设备信息”编辑并保存后生效，刷新及重启后保留。该字段是设备配置，不属于历史截图的 `calibration`。

应用启动时自动为旧数据库补齐 `tiltOffset/imageRoll/maxZoom`，两项修正初始化为 0，最大倍率按上述设备默认值初始化，已有值不重置。读取历史截图时缺少两项修正按 0 处理，原始元数据保持不变；MCP 只读打开旧库时按同样默认值兼容，不执行结构迁移。

`command` 可选 `left/right/up/down/upleft/upright/downleft/downright/zoomin/zoomout/stop`，`speed` 为 0～255 整数，省略时使用 129。连续控制直接调用上游 `/api/v1/control/ptz`，不预先回读，不计算角度目标。前端方向和变倍按钮按下发送启动、松手发送 stop，界面保持 PTZ 轮询。

精确定位使用独立 `/api/cameras/:id/precise`，要求完整提交 `pan/tilt/zoom`，P 为 0～360°，T 为 -90～90°、负值上抬且正值下俯，Z 为 1 至该摄像头已保存的 `maxZoom`。高级表单展开和编辑不发指令，点击提交才调用上游 `/api/v1/control/ptzprecise`。临时点手动追踪由前端根据当前安装位置、姿态及零高程目标反算原始 P/T，点击后先重新回读 PTZ；普通点保留该次 Zoom，带船体尺寸的点根据同次 Z/HFOV/VFOV 估算横纵占比不超过 50% 的倍率，并受该摄像头已保存的最大 Z 约束，再调用此接口。船体尺寸、船高及朝向只保留在前端，不加入请求或数据库；估算假设及边界见 [README](../README.md#cesium-视场与最佳观察)。P/T 仅从 T 合法范围内选择更接近当前读数的解，停止、切页、保存修改或删除目标使回读后尚未下发的追踪失效。后端原样转发原始目标，不再次叠加安装修正，原始回读也不修改。HTTP 校验和 LiveGBS 下发边界均拒绝越界 T 与 Z，扫描下发也遵守当前设备最大 Z；负 T 不包装成 360°附近的数值。接口返回仅表示请求已发送，设备位置及停稳状态以回读和现场为准。

截图的 `calibration` 包含 `longitude`、`latitude`、`height`、`pAxisPitch`、`pAxisRoll`、`panOffset`、`tiltOffset`、`imageRoll` 八个字段；提供时需完整提交，省略时使用数据库配置。前端提交当前表单草稿，后端将其作为该样本的参数副本，不覆盖设备配置。

截图记录保存 `imageUrl`、图片尺寸／格式／字节数、`ptz` 与 `ptzAfter`、`calibration`、`snapshotTime`、快照请求的 `requestedAt/receivedAt/durationMs`、`createdAt`、`usesDraft`、`poseChanged` 和 `timeAlignment`。`imageUrl` 是本工具生成的相对地址；`timeAlignment` 当前始终为 `unverified`。

同一设备的连续控制、精确定位、截图及配置保存互斥，连续控制保持占用直到 stop 成功。停止请求独立接收并排在同一设备尚未结束的控制请求之后；启动失败也不阻止 stop，停止失败保留连续控制占用，允许重试停止。并发 stop 共用一次在途停止请求。参数无效返回 400、设备或图片不存在返回 404、重复通道或操作冲突返回 409、上游失败返回 502、上游超时返回 504、未配置上游认证信息返回 503。本工具错误体为 `{ "message": "错误说明" }`。

后端使用 `URLToken`，在临近有效期前重新登录；并发登录合并，上游 401 后重新登录并重试一次。网络错误和超时不自动重发控制请求，前端不持有或传递上游 token。

### GeoJSON 标绘接口

一个 `.geojson` 或 `.json` 文件对应一个图层，扩展名不区分大小写。导入请求的 `name` 去除首尾空白后须为 1～200 个字符，`sourceFileName` 为 1～255 个字符的来源元数据，不作为后端磁盘路径。`geojsonText` 是 UTF-8 文件解码后的原文，允许开头的 UTF-8 BOM；BOM 仅在解析副本中去除。重复导入创建新的图层 ID，不覆盖旧图层。

摘要返回 `id`、`name`、`sourceFileName`、`byteLength`、`featureCount`、`geometryTypes`、`createdAt`、`updatedAt` 和 `associations`。`byteLength` 为 UTF-8 原文字节数；`featureCount` 为 FeatureCollection 中的 Feature 数，单个 Feature 或顶层几何对象记为 1；`geometryTypes` 为实际出现的几何类型去重列表，包含遇到的 GeometryCollection。`associations` 每项为 `{ cameraId, visible }`。详情额外返回 `geojsonText`，其格式、未知属性、样式和扩展均保持导入时的原文。业务类型见[标绘模型](../src/app/plot-layer.models.ts)。

接受 Feature、FeatureCollection，以及 Point、MultiPoint、LineString、MultiLineString、Polygon、MultiPolygon、GeometryCollection。Feature 的 `properties` 必须为对象或 null，`geometry` 可为 null。允许空集合和空坐标数组；没有有效几何时由地图明确提示无法定位。坐标须为有限数值，经度 -180°～180°、纬度 -90°～90°，每个位置只能有二维或三维；同一个非集合几何内维度一致，图层和几何集合可以包含不同维度的几何。第三维按米制 WGS84 椭球高度原样保存。

非空线至少两个位置，非空面环至少四个位置并首尾闭合；面有非空内环时必须有非空外环。校验类型、数组层级及坐标，不执行完整拓扑修复或空间分析。CRS 可省略；声明时采用 `{ "type": "name", "properties": { "name": "EPSG:4326" } }` 形式，接受 WGS84、CRS84、EPSG:4326 及对应 OGC URN／标准 URL 名称。其他 CRS、空声明及外部链接声明均拒绝，不猜测坐标系或自动转换。

原文最多 10 MiB，最多 50,000 个 Feature、500,000 个位置、32 层 GeometryCollection 嵌套。超出原文字节上限返回 413，其他结构或处理数量超限返回 400。只有 `POST /api/plot-layers` 的请求体上限扩大为 60 MiB + 64 KiB，以容纳 JSON 字符串转义后的封装；其他接口仍为 65,536 字节，请求体超限同样返回 413。这些上限是处理边界，不代表真实业务文件性能已验收。

`cameraIds` 是完整关联集合，按摄像头 ID 去重，允许为空。导入和关联编辑先确认全部摄像头存在，再通过事务一次提交；失败不产生部分图层，也不改写原有名称、关联或显隐。新关联默认显示，编辑保留交集关联的显隐；解除关联只影响移出的摄像头，不删除原文。显隐按摄像头分别保存，修改名称对全部关联摄像头生效。显隐接口只修改已有关系，不隐式建立关联；删除图层移除全部关联，不影响其他图层或摄像头记录。

图层及关联保存在 SQLite 的 `plot_layers`、`plot_layer_cameras` 表。可写启动时自动建立新表；只读 MCP 不执行迁移，也不依赖新表读取已有业务。名称、关联和显隐的修改都不回写 GeoJSON properties。未知图层、摄像头或未建立的关联返回 404；无效输入返回 400；错误体统一为 `{ "message": "错误说明" }`，不返回导入原文或内部堆栈。HTTP 公开边界回归见[标绘接口测试](../tests/plot-layers.test.mjs)。

### 自动扇区截图与任务接口

页面从**实时画面右侧表单**发起自动截图，开始时重新读取所选摄像头的当前 PTZ；任务页提供进度、状态、暂停／继续及关联截图查看。HTTP 调用流程相同：先 `GET /api/cameras/:id/ptz`，再将当前的 P/T/Z 传给启动接口。以下为请求结构示例，实际基础值必须来自当前设备回读：

```http
POST /api/cameras/<CAMERA_ID>/snapshot-scans
Content-Type: application/json

{
  "basePtz": { "pan": 60, "tilt": 2.8, "zoom": 15 },
  "panMin": 0,
  "panMax": 150,
  "settleMs": 1000,
  "moveTimeoutMs": 30000
}
```

| 字段 | 约定 |
| --- | --- |
| `basePtz` | 必填，当前已调好的 `{ pan, tilt, zoom }`；P 为 0～360°，T 为 -90～90°，Z ≥ 1。若与新的回读不符返回 409 |
| `panMin`、`panMax` | 必填，设备原始 P，均为 0～360°，不叠加安装偏移。普通模式分别表示起始／结束 P，结束值小于起始值时沿 P 递增方向跨 0°；海天线模式表示最小／最大 P，要求最小值小于最大值且不跨 0° |
| `settleMs` | 可选，稳定等待时间，默认 1000 毫秒，0～10000；即使为 0 也至少要求两次到位回读 |
| `moveTimeoutMs` | 可选，每点定位稳定等待上限，默认 30000 毫秒，1000～120000 |
| `calibration` | 可选，完整安装参数副本，语义与单张截图一致；省略用已保存配置。实时表单提交当前草稿 |
| `horizon` | 可选，`{ preScanZoom, tiltMin, tiltMax }` 创建低倍率预扫；预扫倍率 ≥ 1 且小于当前 Z，-90 ≤ 最小 T < 最大 T ≤ 90，当前 T 须在其中；P 覆盖至少 30°，建议 90°以上。允许 T 可按设备进一步机械限制收窄 |

普通模式省略 `horizon`。HFOV 从启动时当前倍率的 PTZ 接口读取，必须为 0°～180°之间的有效值。跨度 `D = panMax - panMin`，负值时加 360°，要求 `D > 0`；相同起止值和 `360 → 0` 返回 400，`0 → 360` 表示完整一周。张数 `N = ceil(D / HFOV)`，步长 `S = D / N`，第 `i` 个目标为 `(panMin + (i + 0.5) × S) % 360`（`i` 从 0 开始）。0° → 150°、30°视场角产生 5 张，目标 P 为 15°、45°、75°、105°、135°；347° → 9° 的跨度为 22°，8°视场角产生 3 张，目标 P 约为 350.667°、358°、5.333°。普通模式每次提交精确 PTZ 时固定任务原始的 T/Z；停稳检查中 P 按环形角比较，T 按有符号差值直接比较。上限为 10000 张，超限返回 400；海天线模式见[分阶段接口](#海天线预扫描与正式扫描接口)。

启动成功返回 HTTP 202 和 `Location: /api/snapshot-groups/<GROUP_ID>`。任务摘要含 `id`、`cameraId`、`kind: "scan"`、`status`、`basePtz`、`panMin/panMax`、`horizontalFieldAngle`、`sampleCount`、`panStep`、`completedCount`、`snapshotCount`、`createdAt`、`finishedAt` 和 `error`。`panMin/panMax` 保留提交的原始起止值，跨 0° 任务的 `panStep` 仍为正值。`completedCount` 是已完成采样点数；`snapshotCount` 是当前未删除的图片数，两者在删图后可能不同。

海天线任务额外返回 `horizon`，含 `phase: "coarse" | "fine"`、`targetZoom`、`tiltMin/tiltMax`、`targetHorizontalFov/targetVerticalFov`；正式阶段另含 `sourceRecognitionTaskId/sourceRevision/sourceResultId`。任务摘要可带 `recognitionTaskId` 或 `recognitionError`，分别用于打开自动创建的识别任务或显示创建失败。创建识别失败不更改已完成截图的状态，现存截图仍可手动创建识别。

每个位置依次执行“精确 PTZ → 回读到位并稳定 → 截图前回读 → 抓图 → 截图后回读 → 保存”。截图期间姿态变化则本张不保存并终止任务。样本增加 `groupId`、从 0 开始的 `scanIndex`、`scanTarget`；实际 `ptz/ptzAfter`、图片尺寸、时间、标定副本等仍遵循单张截图契约，时间对应保持 `unverified`。图片元数据与任务进度在同一数据库事务中更新，文件写入失败不提交记录。

任务状态为 `running`（执行）、`pausing`（等待暂停）、`paused`（暂停）、`completed`（完成）、`failed`（失败）、`cancelled`（取消）或 `interrupted`（异常重启中断）。暂停接口等待在途请求结束并停止云台，再返回 `paused`；继续接口从 `completedCount` 对应的下一点开始，使用原任务采样计划、FOV 和标定副本，普通及预扫阶段固定原 T/Z，正式阶段沿用冻结的逐点 T。暂停／失败／中断的任务若已拍满，`start` 仅重新发送 stop 并保存 `completed`，不重复定位或抓图；海天线任务随后自动关联识别，正式阶段仍要求 `completed` 来源。新建普通或预扫任务才重新采用当前基础姿态。完成后停在最后采样位置。终止或暂停均保留已存截图，停止失败时保留设备锁，需用 `/control` 的 `stop` 重试成功后才可继续或收尾；该 stop 会取消执行中的自动任务。通道标识改变后不能继续原任务。正常关机会取消活动任务，异常重启不自动恢复转动；一个数据目录只运行一个业务后端。

分组、任务及组内截图接口均支持 `limit`（1～100）和 `offset`（从 0 开始）。任务／分组列表默认每页 30 条，返回 `{ total, groups, offset, nextOffset }`；组内图片默认 50 张，返回 `{ group, total, snapshots, offset, nextOffset }`。分组按时间倒序，组内图片按时间正序。`kind: "single"` 以单张截图 ID 作为组 ID，兼容旧数据，原始元数据不改写。旧 `/api/cameras/:id/snapshots` 保持兼容的完整列表，页面采用分组分页接口。

任务页的“生成全景图”使用组内分页接口读取全部现存截图，再通过各记录的 `imageUrl` 获取原图；暂停或结束的任务至少两张可生成。前端按保存的安装旋转、真实 P/T 和视场角作圆柱投影及重叠融合，可预览并下载 PNG，原始图片和记录不修改。生成中可取消，切换任务、删除图片或继续任务后清除旧预览；记录变化或任一图片读取失败时终止生成并显示错误。输出最多 16384×4096、1600 万像素，按比例缩小，缺失视野保持透明。全景生成在浏览器完成，不新增后端写接口；实现及局限见 [README](../README.md#自动扇区截图与任务)。

截图记录与任务页中的图片支持右键删除；`DELETE /api/snapshots/:id` 成功返回 204，只删除这一张。设备正在扫描、控制、保存或截图时返回 409，暂停后可删除。后端在截图目录中暂存图片，数据库拒绝删除时恢复原图；成功后清理暂存文件，清理失败明确返回错误。删除已完成点不会让任务继续时重拍该点，也不修改其他截图或标定配置。

PowerShell 调用示例：

```powershell
$baseUrl = 'http://127.0.0.1:3000'
$cameraId = '<CAMERA_ID>'
$reading = Invoke-RestMethod "$baseUrl/api/cameras/$cameraId/ptz"
$scanBody = @{ basePtz = @{ pan = $reading.raw.Pan; tilt = $reading.raw.Tilt; zoom = $reading.raw.Zoom }; panMin = 0; panMax = 150 } | ConvertTo-Json
$task = Invoke-RestMethod "$baseUrl/api/cameras/$cameraId/snapshot-scans" -Method Post -ContentType 'application/json' -Body $scanBody
Invoke-RestMethod "$baseUrl/api/snapshot-groups/$($task.id)"
Invoke-RestMethod "$baseUrl/api/snapshot-groups/$($task.id)/snapshots?limit=50&offset=0"
Invoke-RestMethod "$baseUrl/api/snapshot-tasks/$($task.id)/pause" -Method Post
Invoke-RestMethod "$baseUrl/api/snapshot-tasks/$($task.id)/start" -Method Post
```

### 海天线预扫描与正式扫描接口

预扫仍使用 `POST /api/cameras/:id/snapshot-scans`，在普通请求中加入 `"horizon": { "preScanZoom": 2, "tiltMin": 0, "tiltMax": 90 }`。示例 T 范围须按设备实际能力填写。`basePtz` 来自启动时当前高倍率真实回读，保存其 Z 与 HFOV/VFOV 供正式阶段恢复；后端读取低倍率实际 FOV，按包含两端、间隔不超过 15°的均匀 P 点采样，至少三个方向。预扫固定初始 T，每张保存实际低倍率 P/T/Z/FOV；人工须事先调好 T，缺线或遮挡样本可在复核页忽略，必要时重新预扫。

预扫完成后自动创建本地识别。海天线任务自动创建的识别在模型结束后自动计算候选安装结果，失败或不可靠结果正常保留，不自动应用配置。识别页通过 `sourceTaskId` 读取来源截图任务，展示预扫／正式阶段；粗结果仅用于下一阶段控制。手动新建同一已完成预扫的识别任务，也可复核后启动正式扫描。

```http
POST /api/recognition-tasks/<RECOGNITION_TASK_ID>/horizon-scan
Content-Type: application/json

{ "revision": 0, "resultId": "<CURRENT_RESULT_ID>", "reviewed": true }
```

接口只接受源预扫状态为 `completed`、识别已结束且结果为 `estimated` 的当前版本。必须显式提交 `reviewed: true` 和匹配的 `revision/resultId`；源图片、设备通道、安装位置及拟合参考配置须仍有效，且设备未被其他操作占用。页面先保存标注，存在未保存内容、排队／识别中、无效结果或未确认复核时不能启动；确认绑定当前任务、版本和结果，任何编辑或重新生成均清除确认。无效请求或冲突明确返回错误，页面不伪造任务成功。

校验成功后返回 HTTP 202 和普通 `SnapshotGroup` 摘要。服务端恢复原预扫保存的目标倍率及 P 范围，按目标 HFOV 等分中心点，使用 `fitCamera` 与粗结果组成控制标定副本，不写摄像头配置。先求解全部目标 T：保持与参考 T 相同的俯仰分支，选择允许区间内最接近参考 T 的解；不可达时拒绝，不硬截到范围边缘或将负角度自动包装成 360°。逐点目标、控制副本、来源识别版本／结果和残差余量在 SQLite 中冻结，之后修改粗标注不追溯改变已创建计划，续扫仍校验通道。

正式扫描使用完整原始 P/T/Z 精确定位，以实际 FOV 检查到位和截图前后稳定。T 容差为 `min(0.15°, 0.05 × 实际 VFOV)`；模型余量为 `max(0.02°, 3 × 粗拟合角度 RMS)`，要求 `abs(中心海天线角度差) + 余量 + 到位容差 < 0.35 × 实际 VFOV`。无效 FOV 或余量不足时失败并保留已完成样本；余量是模型检查，不是经标定的概率置信度。原始 `ptz/ptzAfter` 始终来自真实回读。海天线居中指画面横向中部接近中心，不要求整条线水平，也不执行在线真实海天线检测。正式阶段完成后自动创建最终识别，复核后的候选参数仍由用户点击“应用到摄像头”保存。

### 本地识别任务与四参数标定

本地任务不需要 MCP，操作入口和模型环境见 [README](../README.md#本地模型识别与安装参数)。创建时冻结源任务现存截图集合，原始截图和 PTZ 保持不变；运行中的截图任务或空任务不可创建。Python 与 ESSLD 路径分别由 `ESSLD_PYTHON/ESSLD_UPSTREAM` 指定，缺失时返回 503。

识别状态为 `queued/running/completed/failed/cancelled/interrupted`，进度字段为 `completedCount/sampleCount`。本地模型按队列串行运行，关闭时取消在途进程，重启不自动继续。失败或中断后可用同一个 `sourceTaskId` 创建新的识别任务。

任务中的 `revision` 从 0 开始，任何标注或忽略状态保存都会递增并清空旧 `result`。编辑、生成、应用均需提交客户端读取的版本，不匹配返回 409；识别运行或排队中不可编辑、生成或应用。列表与图片分页支持 `limit=1..100`、`offset>=0`，默认每页 30 条。

每个识别条目包含 `snapshotId`、采样元数据副本 `snapshot`、模型原始 `detectedPoints`、当前 `points`、`source=model/manual`、`ignored/ignoreReason`、原图是否已删除 `missing` 及原始检测参数 `detection`。提交的点位固定为两个 `{x,y}`，均在 0～1 内；参与计算时横向跨度至少 10%，被忽略的图片可暂存尚未满足跨度的标注。只修改忽略状态时可省略 `points`，人工点位不会覆盖模型原始输出。源记录删除后 `missing=true`，重新生成会排除此图。

模型无有效点位、采样姿态变化或同组局部倾角/归一化高度突变时默认忽略。邻域、MAD 和最小门槛见 README。突变过滤只比较同一 T/Z/FOV，变 T 的正式扫描不能获得与固定 T 扫描相同的支持，不按图像行位置直接比较不同 T 样本。自动忽略可手动恢复，恢复前必须有合法点位。过滤不保证边界一定是真正海天线。

`generate` 使用当前设备经纬度、高度及默认朝向，以及未忽略截图的真实 PTZ/FOV。模型 `wgs84-horizon-installation-v1` 联合求解 `pAxisPitch/pAxisRoll/tiltOffset/imageRoll`，复用共用旋转链、WGS84 残差和稳健损失。`result.status` 为 `estimated/insufficient_data/unreliable`，只有 `estimated` 包含 `installation` 四项数值。有效样本参与拟合后，必须收敛、未加阻尼的四参数矩阵条件数小于 `1e8`，各图等权的 RMS 不超过 5 像素；否则返回 `unreliable`。没有有效样本时返回 `insufficient_data`。张数、不同 P 方向数和覆盖范围用于查看分布，样本较少或方向集中时对标注及固定参数误差更敏感。`diagnostics.perSnapshot` 给出逐图像素残差，`diagnostics.rmsAngularResidualDegrees` 给出参与样本真实射线的角度均方根残差，排除项列在 `excluded`。低倍率的像素门槛不直接保证高倍率精度。

`generate` 每次产生新的 `resultId` 并清除当前结果的应用状态。`apply` 必须同时提交读取的 `revision` 与 `resultId`，只读取服务端保存的合格结果，不接收前端角度值；校验标注版本、结果编号、计算参考的当前设备配置、设备通道、源记录仍存在以及设备未被控制/截图占用。在同一事务中更新四项修正与应用状态，其他设备字段保持原值；不调用 LiveGBS 控制、修改原始 PTZ 或回写历史截图。成功后记录 `appliedAt/appliedRevision`；无合格结果、配置改变、源图删除、过期版本或重复应用返回 409。此写入能力仅属于本地网页流程，MCP 工具继续只读且只估计两个 P 轴倾角。

### 实时播放地址

`GET /api/playback?cameraId=<ID>` 读取该摄像头已保存的设备与通道编号，返回 WS-FLV 配置。不存在的摄像头返回 404；未传 `cameraId` 时使用默认通道。默认配置响应如下：

```json
{
  "url": "ws://192.168.1.15:10000/sms/34020000002020000001/ws-flv/hls/34020000001320000088_34020000001320000001.flv",
  "serial": "34020000001320000088",
  "code": "34020000001320000001",
  "smsId": "34020000002020000001"
}
```

设备和通道编号取指定摄像头的数据库记录，CMS 主机与 HTTP／HTTPS 端口来自 `LIVEGBS_URL`，`smsId` 来自 `LIVEGBS_SMS_ID`，缺省为上述节点编号。后端按 `/sms/{smsId}/ws-flv/hls/{serial}_{code}.flv` 拼接并对各标识进行路径编码，HTTP 对应 WS，HTTPS 对应 WSS；不调用上游取流接口。

前端以 `flv.js` 直接解复用此 WebSocket 中的 FLV 数据，交给 MediaSource 和原生 `video` 解码，再将视频元素交给 Cesium 作为视锥截面的纹理。仅当当前摄像头、表单通道和直播 serial/code 一致、位置及 PTZ/FOV 有效时显示截面，使用同一安装旋转链与视场角，支持不透明度调节。切换摄像头时取消旧的取址 HTTP 订阅并清空源和视频引用，旧媒体组件销毁后释放原 WebSocket，再加载新通道。保存通道标识变化时重新取址，保存安装参数时保留连接；旧 HTTP 响应不回写新设备的播放状态。

已实测收到 FLV 文件头及视频帧数据，无需将 API 登录 token 加入媒体地址。该结果确认网络媒体链路，浏览器解码和视频纹理实际显示仍未验收。关闭融合或进入历史会释放直播连接、帧回调及纹理，重连先释放旧连接。历史模式通过所选记录的 `imageUrl` 加载图片，以该记录保存的安装参数、PTZ 和视场角在原 CCTV 截面显示，支持不透明度调节；切换记录或返回实时时释放旧截图纹理。媒体接入与清理规则见 [README](../README.md#实时视频)。

## 截图标定 MCP

HTTP 入口为 `server/mcp-http.mjs`，通过独立的 Streamable HTTP `/mcp` 端点提供 MCP 协议，默认监听 `0.0.0.0:3001`，使用 `npm run mcp` 启动。客户端传入 `Authorization: Bearer <MCP_API_KEY>`，连接服务端局域网地址；配置示例见 [mcp.config.example.json](../mcp.config.example.json)，完整流程见 [MCP 使用说明](MCP使用说明.md)。运行时使用 Node 22.22.3，读取与网页相同的 `DATA_DIR`。

HTTP 请求按次处理，无会话 ID，支持多个客户端以及 2025 版 Streamable HTTP 协议。`POST /mcp` 的工具调用使用 JSON-RPC `tools/list`、`tools/call` 等方法，响应可为 JSON 或 SSE。`GET /health` 提供无业务数据的健康状态；`GET /mcp` 返回 405。未认证请求返回 401，Host/Origin 不在允许列表时返回 403。浏览器来源可通过 `MCP_ALLOWED_ORIGINS` 显式配置。stdio 兼容入口为 `server/mcp.mjs`，命令为 `npm run --silent mcp:stdio`。

该 MCP 以只读模式打开数据库。连接端需要具备识别图片的 AI，负责海天线标注；原图直接通过 MCP `image` 内容块返回，无需访问服务端本地路径或相对 `imageUrl`。工具负责数值拟合，不额外调用大模型，也不提供移动设备、截图采集或配置写入工具。

### 工具

| 名称 | 输入 | 输出 |
| --- | --- | --- |
| `list_cameras` | `{}` | `cameras`，每项包含设备与当前标定字段、`snapshotCount`、`firstSnapshotAt`、`lastSnapshotAt` |
| `query_snapshots` | `cameraId`、`startTime`、`endTime`，可选 `groupId`、`limit`（1～100，默认 50）、`offset`（默认 0） | 时间正序的截图元数据、分组 ID、`total`、`nextOffset`、本页 P 方向分布；`groupId` 可限定一次任务，不返回图片 |
| `get_snapshot` | `snapshotId` | 原始截图的 MCP `image` 内容块及 `structuredContent` 元数据 |
| `estimate_p_axis_tilt` | `cameraId`、`startTime`、`endTime`、`observations` | 倾斜估计、来源、假设和残差；不修改配置 |

`startTime/endTime` 使用带时区的 ISO 时间，统一转换为 UTC；按截图 `createdAt` 筛选，开始包含、结束不包含。缺少时区、结束早于开始或摄像头不存在时明确报错。查询的 `pageSampling` 返回本页 `stableSnapshotCount`、`distinctPanCount` 和 `panCoverageDegrees`，用于查看样本分布；读取其他页需继续使用 `nextOffset`。

`get_snapshot` 返回原始分辨率，支持 JPEG／PNG；图片文件缺失、无法识别或尺寸与记录不一致时返回工具错误。AI 应识别远处海天线，避开文字、船体、养殖网、近处波浪及岸线；无法确认时跳过该图。

拟合输入的 `observations` 为 1～100 项，每项形如：

```json
{
  "snapshotId": "<真实截图ID>",
  "points": [
    { "x": 0.1, "y": 0.4 },
    { "x": 0.9, "y": 0.42 }
  ]
}
```

上例仅说明结构，点位应由 AI 查看对应原图后填写。每张图需 2～20 个点，左上角为原点，`x = pixelX / width`、`y = pixelY / height`，取值均为 0～1。标注横向跨度须至少达到图宽的 10%。调用者不传入 PTZ/FOV，工具以数据库中采样时的原始值为准。

### 数据质量与拟合模型

- 使用停稳且海天线可确认的截图；张数、不同 P 方向数和圆周覆盖范围用于查看样本分布。样本较少或方向集中时，结果对标注及固定参数误差更敏感。
- 同一截图不能重复。截图不属于指定摄像头或时间段时拒绝请求；采样期间姿态改变、PTZ/FOV 无效、尺寸无效或历史通道与当前配置不一致时排除该样本并返回原因。
- 固定当前已保存的经纬度、高度、P/T 偏移和画面 Roll 修正，只拟合 `pAxisPitch/pAxisRoll`；旧截图中的安装参数只作采样记录，不作为真实轴倾角。T 偏移与画面 Roll 本次不联合求解，其输入误差可能影响 P 轴倾斜估计。
- 前端与拟合共用 `shared/camera-rotation.ts`：安装朝向、前后倾和左右倾按 Z-X-Y 组成固定底座，再应用局部 P/T 和画面 Roll。P 偏移只在固定安装矩阵中应用一次。
- 海天线使用 WGS84 椭球的前向切线条件，考虑已知安装高度的曲率影响。图像主点取中心，T 偏移及画面 Roll 使用数据库中的当前值；当前支持 P 轴朝上、两个倾角均在 -89°～89°内的固定安装，模型编号为 `wgs84-horizon-p-axis-v3`。倾角以安装朝向定义的坐标系为参考，结果应连同模型编号及旋转约定复核。
- 使用稳健最小二乘拟合，返回各图切线残差在图像处折算的像素误差及角度误差。均方根像素误差按各图等权统计，超过 5 像素、未收敛或不可辨识时不输出可用安装参数。

### 结果

| 字段 | 含义 |
| --- | --- |
| `status` | `estimated`、`insufficient_data` 或 `unreliable` |
| `installation` | 仅 `estimated` 时有值，含 `pAxisPitch`、`pAxisRoll`、`tiltDegrees`、`axisDirectionEnu` 和 `tiltBearingDegrees`，角度单位为度 |
| `fixedCalibration` | 本次固定采用的经纬度、高度、P/T 偏移、画面 Roll 修正和配置更新时间 |
| `sourceSnapshotIds`、`observations`、`excluded` | 实际使用的样本、输入标注和排除原因 |
| `distinctPanCount`、`panCoverageDegrees` | 样本的不同 P 方向数和圆周覆盖范围 |
| `diagnostics` | 收敛、迭代、条件数、总体及逐图误差；没有有效样本时不进行拟合 |
| `assumptions`、`warnings` | 模型条件及尚未验证的因素 |
| `applied` | 始终为 `false`，结果仅通过 MCP 返回 |

没有足够样本时 `installation=null`，返回取样要求；拟合不可靠时也为 `null`。`estimated` 仅表示在模型假设下通过数值检查，不代表现场精度已确认。倾向方位以当前 P 偏移为参考，不能视作海天线独立测出的绝对朝向。

结果由用户复核后在现有安装表单填写前后倾和左右倾，点击保存才会更新数据库。当前未建模潮汐、折射、畸变、稳像裁剪与视频/PTZ 的精确同步，残差大时应同时复核已保存的 T 偏移与画面 Roll 修正。

## LiveGBS 上游接口

| 能力 | 方法 | 路径 | 现有资料范围 |
| --- | --- | --- | --- |
| 登录 | POST | `/api/v1/login` | 已验证无 Cookie 登录及 JSON 响应 |
| 姿态回读 | GET | `/api/v1/device/fetchptzposition` | 已验证 PTZ、视场角响应及两种认证方式 |
| 连续控制 | POST | `/api/v1/control/ptz` | 用户提供的指令和速度接口资料，默认速度 129，含 stop |
| 精确控制 | POST | `/api/v1/control/ptzprecise` | `pan`、`tilt`、`zoom` 查询参数的请求示例 |
| 通道快照 | GET | `/api/v1/device/channelsnap` | 已验证 `stime=now` 返回 JPEG 二进制及快照时间头 |

## 获取 token

```http
POST <LIVEGBS_ORIGIN>/api/v1/login?username=<USERNAME>&password=<PASSWORD>
```

使用原始示例的用户名和密码参数，在未携带 Cookie 时登录成功。密码参数的转换算法仍需服务契约确认，不能仅凭参数形态认定算法。

成功响应为 HTTP 200，`Content-Type: application/json; charset=utf-8`，JSON 直接包含以下字段，没有额外的数据包装层：

```json
{
  "AuthToken": "<redacted>",
  "CookieToken": "<redacted>",
  "Token": "<redacted>",
  "TokenTimeout": 604800,
  "URLToken": "<redacted>"
}
```

其中四个 token 字段均为字符串，`TokenTimeout` 为数字。同次响应设置 Cookie：

```http
Set-Cookie: token=<redacted>; Path=/; Expires=<到期时间>; Max-Age=604800; HttpOnly
```

Cookie 的 `Max-Age` 为 604800 秒，即 7 天；token 实际过期与刷新行为尚未验证。已确认的认证方式为：

- 将登录响应的 `URLToken` 作为查询参数 `token`，不携带 Cookie，可以回读 PTZ 和获取快照。
- 仅携带登录时保存的 Cookie、不传查询参数 `token`，可以回读 PTZ。

这两种方式无需同时提供即可完成已验证的 PTZ 请求。`AuthToken`、`Token`、`CookieToken` 字段各自的其他用途未单独测试，不将其直接与 `URLToken` 混用。

## 获取 PTZ 信息

```http
GET <LIVEGBS_ORIGIN>/api/v1/device/fetchptzposition?token=<TOKEN>&serial=<SERIAL>&code=<CODE>
```

| 参数 | 含义 |
| --- | --- |
| `serial` | 设备编号 |
| `code` | 通道编号 |
| `token` | 使用登录响应中的 `URLToken`；采用登录 Cookie 时可不传 |

成功响应为 HTTP 200，`Content-Type: application/json; charset=utf-8`。一次实测响应如下：

```json
{
  "DeviceID": "34020000001320000001",
  "HorizontalFieldAngle": 4.32,
  "MaxViewDistance": 0,
  "Pan": 232.2,
  "Tilt": 2.8,
  "VerticalFieldAngle": 2.43,
  "Zoom": 15
}
```

| 字段 | 实测类型与含义 |
| --- | --- |
| `DeviceID` | 字符串，本样本等于请求的通道 `code`，不是设备 `serial` |
| `Pan` | 数字；按 0～360°处理，安装零位与真实方向仍需现场复核 |
| `Tilt` | 数字，-90～90°；负值上抬、正值下俯，原始读数保持有符号数值 |
| `Zoom` | 数字，本次为 `15`，与画面 OSD 的 `Z015` 一致；是否始终表示光学倍率待确认 |
| `HorizontalFieldAngle`、`VerticalFieldAngle` | 数字，分别表示水平／垂直视场角；单位、来源和准确性待确认 |
| `MaxViewDistance` | 数字，本次为 `0`；单位及 `0` 的语义未确认，不直接作为投影距离上限 |

另一组回读为 `Pan=232.83`、`Tilt=2.17`、`Zoom=37`、水平／垂直视场角 `1.76/0.99`。两组数据说明接口会返回随状态变化的视场角值，但不能据此认定其已经完成光学标定。

工具直接将 `HorizontalFieldAngle`、`VerticalFieldAngle` 分别用作 HFOV、VFOV，作为三维投影的唯一视场角来源，并与同次响应中的 `Pan`、`Tilt`、`Zoom` 一起更新和保存。视场角缺失或无效时，显示接口数据异常，当前实时投影不可用。`Zoom` 用于变倍控制与读数展示。

每个注册通道使用一套投影模型。安装位置、P 轴姿态、默认朝向（P 偏移）、T 偏移和画面 Roll 修正由本工具的数据库配置提供，用于投影及临时点目标反算；原始 PTZ 及下发给 LiveGBS 的控制参数保持设备语义，T 保留 -90～90°有符号值。表单字段及保存流程见 [README](../README.md#表单保存)。

响应中未见设备采样时间字段。接入端需要自行记录请求起止及接收时间，原始值与展示格式分开处理，不套用参考项目的 PTZ 解码。

前述 curl 的 4 次端到端回读耗时为 179、188、406、229 毫秒，平均约 251 毫秒；新后端一次真实回读为 146 毫秒。以上仅为测量样本，不作为固定响应时限。前端选择设备后立即读取一次，随后按页面设置的间隔轮询，默认 10 秒，可填写 1～3600 的整数秒，刷新页面后恢复默认值。修改间隔保留正在执行的回读，前一请求未完成时跳过本轮；该设置仅影响前端自动回读，不改变上游请求超时或后端截图任务的采样流程。

### 未认证响应

未携带任何 token 或 Cookie 时，本次返回 HTTP 401，`Content-Type: application/json; charset=utf-8`，响应体是 JSON 字符串：

```json
"Unauthorized"
```

错误解析不能假设响应始终为含 `code`、`message` 的对象。其他错误场景及 HTTP 200 下的业务错误结构尚未验证。

## PTZ 连续控制

```http
POST <LIVEGBS_ORIGIN>/api/v1/control/ptz?token=<TOKEN>&serial=<SERIAL>&code=<CODE>&command=left&speed=129
```

| 参数 | 约定 |
| --- | --- |
| `serial`、`code` | 设备和通道编号，按字符串处理 |
| `command` | `left/right/up/down/upleft/upright/downleft/downright/zoomin/zoomout/stop` |
| `speed` | 速度，0～255，资料默认值 129；本工具使用整数 |

按下按钮发送相应方向或变倍命令，松手、移出、取消或失焦时发送 `command=stop`。速度及指令不换算为 P/T/Z 目标。此接口及响应语义来自用户提供资料，实际移动、变倍、停止和速度效果仍需现场验证。

前端松手立即发 stop，启动未完成时在其结束后补发 stop；后端序列化同设备在途控制与停止，处理快速点击和迟到响应。停止失败时可手动重试；网络中断或请求返回成功都不能作为设备已停稳的证明。

## PTZ 精确控制

```http
POST <LIVEGBS_ORIGIN>/api/v1/control/ptzprecise?token=<TOKEN>&serial=<SERIAL>&code=<CODE>&pan=0&tilt=0&zoom=1.0
Cookie: token=<COOKIE_TOKEN>
```

`serial`、`code` 与回读接口使用同一设备及通道标识。

| 参数 | 当前资料 |
| --- | --- |
| `pan` | 水平定位参数，示例为 `0`；单位、范围和跨零规则待确认 |
| `tilt` | 垂直定位参数，示例为 `0`；单位、范围和方向待确认 |
| `zoom` | 变倍定位参数，示例为 `1.0`；是否为光学倍率及其范围待确认 |

数值仅保留原始示例，不作为设备默认值。需要确认是否必须同时提交三个参数，以及成功响应表示“请求已接受”还是“设备已到位”。工具发送后仍需回读，控制目标不能替代真实 PTZ。

此接口由“精确 PTZ（高级）”独立表单提交完整目标值。方向和变倍按钮使用连续控制接口。

## 设备信息：通道快照

```http
GET <LIVEGBS_ORIGIN>/api/v1/device/channelsnap?token=<TOKEN>&serial=<SERIAL>&code=<CODE>&stime=now
```

此接口用于获取标定样本图片。已确认实时抓图返回图片二进制，工具后端需保存图片并生成自身访问地址，不能把响应直接当作图片 URL。图片与当时 PTZ、接口视场角及实际使用的安装参数一起保存，可供后续海天线识别和辅助标定使用。

### 参数

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `serial` | String | 是 | 设备编号 |
| `channel` | Number | 否 | 通道序号，默认 `1`；与 `code` 二选一 |
| `code` | String | 否 | 通道编号，来自 `/api/v1/device/channellist` 的 `ChannelList.ID`；与 `channel` 二选一 |
| `stime` | String | 否 | `now` 表示实时抓图；`YYYYMMDDHHmmss` 表示从录像截取指定时刻的快照；未传时的行为待确认 |
| `check_outputs` | Boolean | 否 | `stime` 快照时有效，抓完后若没有输出是否停流；默认 `true` |
| `timeout` | Number | 否 | `stime` 快照超时时间，单位秒；默认读取 `ini > sip > ack_timeout` |
| `format` | String | 否 | `stime` 快照格式，可选 `jpeg`、`png` |
| `w` | Number | 否 | `stime` 快照宽度，默认 `960`；`-1` 表示原视频宽度 |
| `h` | Number | 否 | `stime` 快照高度，默认 `540`；`-1` 表示原视频高度 |

表中默认值来自原接口资料。未传 `w`、`h` 的真实调用中，已分别收到 1920×1080 和 960×540；后端按图片帧头解析实际尺寸，不假定统一输出尺寸。显式尺寸参数、上游 PNG 及历史快照未测试。

实时截图显式传 `stime=now`。`channel` 是序号，`code` 是编号，不能混用。本次仅使用查询参数 `token=<URLToken>` 获取快照成功，未携带 Cookie。

### 成功响应

一次实测响应为：

```http
HTTP/1.1 200 OK
Channel-Snap-Time: 2026-11-09 10:24:02
Content-Type: image/jpeg
Date: Mon, 09 Nov 2026 02:24:02 GMT

<图片二进制数据>
```

已解码确认是有效 JPEG，宽 1920、高 1080，共 212816 字节（约 208 KiB）。本次截图请求耗时约 287 毫秒，只代表本次测量，不作为响应时限保证。后端应根据实际响应保存图片格式与尺寸。

本次截图前后两次 PTZ 均为上述 `232.2/2.8/15`，但图片 OSD 显示 `10:24:01`，快照响应头为 `10:24:02`，相差 1 秒。时间头与本次 HTTP `Date` 按 UTC+8 换算相符，但不含时区标记；调用端与服务端时钟也存在差异。不能据此认定时间头就是精确的画面采样时刻。

PTZ 与快照来自不同请求，不具备已确认的同步保证。保存快照请求起止时间、截图前后 PTZ、响应头原始时间及各自回读时间；检测到姿态变化或无法确定时间对应时，在样本中记录该状态。

## 联调前待确认

1. 目标 LiveGBS 版本、登录密码的转换方式、token 过期与刷新行为，以及其他 token 字段的用途。
2. 登录失败、设备离线、无效通道、连续及精确控制的响应结构，以及 HTTP 200 下是否可能返回业务错误；真实移动、变倍及 stop 效果需在具备现场操作条件时验证。
3. P 的单位、方向与安装零位，Z 与视场角的来源及单位，`MaxViewDistance=0` 的含义；控制速度与设备运动速度的对应关系，以及 T -90～90°内进一步的机械限制与精确定位到位语义。
4. 快照时间头的准确语义、时区、缓存行为与时钟校准；显式尺寸、PNG、历史快照及能够接受的 PTZ 时间对应误差。
5. 接口响应耗时、超时及轮询频率，设备停稳的判断依据。
6. 若需要自动枚举设备／通道，需补充设备列表与通道列表的完整契约；当前按选中摄像头已保存的 serial／code 拼接 WS-FLV 地址。
