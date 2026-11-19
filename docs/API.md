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
| `GET /api/data-sources` | 返回固定项目身份与可选 AIS 来源，不携带上游地址 |
| `GET /api/data-sources/:id/snapshot` | 返回统一来源状态和完整有效目标快照 |
| `GET /api/data-sources/:id/events` | 同源 SSE 完整快照流，重连重新发送当前状态 |
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
| `POST /api/cameras/:id/snapshot-scans` | 按有序 PTZ 控制点与最大 P 间隔创建逐点截图任务，HTTP 202 返回任务组 |
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
| `GET /api/recognition-tasks/:id/panorama-guide` | 获取全景参考线及独立版本 `{ guide, revision }` |
| `PUT /api/recognition-tasks/:id/panorama-guide` | 保存或删除 `{ guide, revision }`，返回独立版本递增后的参考线状态 |
| `POST /api/recognition-tasks/:id/cancel` | 取消排队或运行中的本地模型识别，保留已有结果 |
| `POST /api/recognition-tasks/:id/generate` | `{ revision, model? }` 按本任务生成普通结果，指定 `wgs84-horizon-zero-pose-v1` 得到零位候选，缺省为历史四参数模型 |
| `POST /api/recognition-tasks/:id/zero-pose-measure` | `{ revision, resultId, snapshotId }` 只读测量新版普通候选在指定参与图上的理论海天线及偏差 |
| `PUT /api/recognition-tasks/:id/refinement-sources` | 保存联合精修的基础来源、补充任务及选择版本；返回任务，不计算或写设备配置 |
| `POST /api/recognition-tasks/:id/refine` | `{ revision, selectionRevision }` 从已保存基础结果联合生成独立精修候选，返回任务 |
| `POST /api/recognition-tasks/:id/refinement-measure` | `{ revision, selectionRevision, mode, resultId? }` 只读计算参与图的基准或候选理论线与偏差，不作为独立复核 |
| `POST /api/recognition-tasks/:id/validate` | `{ revision, referenceTaskId, referenceResultId, referenceKind?, criteria? }` 按独立原图测量固定普通／精修四参数，或比较已保存四参数与冻结的零位候选并保存证据 |
| `POST /api/recognition-tasks/:id/refinement-apply` | `{ revision, resultId }` 在同一写事务内核对全部来源、完整配置版本与占用，仅应用精修四参数及其独立应用状态，返回 `{ task, camera }` |
| `POST /api/recognition-tasks/:id/apply` | `{ revision, resultId }` 应用服务端保存的最新合格结果，返回 `{ task, camera }` |

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

`zeroPose` 为可选的零位姿态草稿，由 `{ roll, pitch, yaw, tiltOffset }` 组成，均为度。Roll 与 T 补偿范围为 -180°～180°，Pitch 为 -90°～90°，Yaw 为 [0°, 360°) 的绝对真北方位。旧摄像头在保存草稿前省略该字段。更新请求省略该字段时保留已存值，提交时整组校验并随摄像头配置写入。原 `panOffset` 保留 P 朝向基准，原 `tiltOffset` 仍是旧安装模型的 T 偏移。快照的 `calibration` 使用拍摄时的安装配置。

零位姿态在当地 ENU 中使用 `R0 = Rz(-yaw) × Rx(pitch) × Ry(roll)`。以草稿的 `tiltOffset` 为 δ，设备当前姿态用 `R0 × Rx(-δ) × Rz(-Pan) × Rx(δ - Tilt)`。补偿由 δ 调至 δ′ 时，将 `R0 × Rx(δ′ - δ)` 转回三角，保留机械俯仰校正。存储保存四个角度，矩阵和四元数从角度派生。

应用启动时为旧数据库补齐 `tiltOffset/imageRoll/maxZoom/zeroPose`。两项修正初始化为 0，最大倍率按上述设备默认值初始化，零位草稿初始为空。读取历史截图时缺少两项修正按 0 处理。MCP 只读打开旧库时按同样默认值兼容。

新部署可通过 `npm run db:init` 使用相同存储模块建库，导入 `scripts/initial-cameras.json` 中的已注册摄像头和完整安装参数。脚本沿用 `.env` 的 `DATA_DIR`，保留初始数据中的 ID 和时间；同一事务中跳过已有 `serial + code` 通道，其他摄像头写入错误会回滚，不覆盖现有配置。使用方式及数据范围见 [数据库初始化](../README.md#数据库初始化)。

`command` 可选 `left/right/up/down/upleft/upright/downleft/downright/zoomin/zoomout/stop`，`speed` 为 0～255 整数，省略时使用 129。连续控制直接调用上游 `/api/v1/control/ptz`，不预先回读，不计算角度目标。前端方向和变倍按钮按下发送启动、松手发送 stop，界面保持 PTZ 轮询。

精确定位使用独立 `/api/cameras/:id/precise`，要求完整提交 `pan/tilt/zoom`，P 为 0～360°，T 为 -90～90°、负值上抬且正值下俯，Z 为 1 至该摄像头已保存的 `maxZoom`。高级表单展开和编辑不发指令，点击提交才调用上游 `/api/v1/control/ptzprecise`。临时点手动追踪由前端根据当前安装位置、姿态及零高程目标反算原始 P/T，点击后先重新回读 PTZ；普通点保留该次 Zoom，带船体尺寸的点根据同次 Z/HFOV/VFOV 估算横纵占比不超过 50% 的倍率，并受该摄像头已保存的最大 Z 约束，再调用此接口。船体尺寸、船高及朝向只保留在前端，不加入请求或数据库；估算假设及边界见 [README](../README.md#cesium-视场与最佳观察)。P/T 仅从 T 合法范围内选择更接近当前读数的解，停止、切页、保存修改或删除目标使回读后尚未下发的追踪失效。后端原样转发原始目标，不再次叠加安装修正，原始回读也不修改。HTTP 校验和 LiveGBS 下发边界均拒绝越界 T 与 Z，扫描下发也遵守当前设备最大 Z；负 T 不包装成 360°附近的数值。接口返回仅表示请求已发送，设备位置及停稳状态以回读和现场为准。

截图的 `calibration` 包含 `longitude`、`latitude`、`height`、`pAxisPitch`、`pAxisRoll`、`panOffset`、`tiltOffset`、`imageRoll` 八个字段；提供时需完整提交，省略时使用数据库配置。前端提交当前表单草稿，后端将其作为该样本的参数副本，不覆盖设备配置。

截图记录保存 `imageUrl`、图片尺寸／格式／字节数、`ptz` 与 `ptzAfter`、`calibration`、`snapshotTime`、快照请求的 `requestedAt/receivedAt/durationMs`、`createdAt`、`usesDraft`、`poseChanged` 和 `timeAlignment`。`imageUrl` 是本工具生成的相对地址；`timeAlignment` 当前始终为 `unverified`。

同一设备的连续控制、精确定位、截图及配置保存互斥，连续控制保持占用直到 stop 成功。停止请求独立接收并排在同一设备尚未结束的控制请求之后；启动失败也不阻止 stop，停止失败保留连续控制占用，允许重试停止。并发 stop 共用一次在途停止请求。参数无效返回 400、设备或图片不存在返回 404、重复通道或操作冲突返回 409、上游失败返回 502、上游超时返回 504、未配置上游认证信息返回 503。本工具错误体为 `{ "message": "错误说明" }`。

后端使用 `URLToken`，在临近有效期前重新登录；并发登录合并，上游 401 后重新登录并重试一次。网络错误和超时不自动重发控制请求，前端不持有或传递上游 token。

### AIS 数据源接口

后端 [project.mjs](../server/project.mjs) 固定部署身份、来源地址、适配器及时间/几何参数；不提供前端来源编辑或摄像头绑定 API。当前项目为 `tianjin-lock / 天津船闸`，来源按顺序为 `tianjin-lock-ais / 天津船闸 AIS` 和 `dagu-ais / 大沽 AIS`。天津船闸连接 `ws://192.168.1.20:4323/websocket`，大沽连接 `ws://192.168.1.21:5345/websocket`，均复用 `seaoil-ais` 适配器读取 `api=1`。目录响应为：

```json
{
  "project": { "id": "tianjin-lock", "name": "天津船闸" },
  "sources": [{
    "id": "tianjin-lock-ais", "name": "天津船闸 AIS", "type": "ais",
    "geometry": { "antennaFromSternRatio": 0.1, "antennaFromPortRatio": 0.5, "heightMeters": 10 },
    "expireAfterMs": 600000
  }, {
    "id": "dagu-ais", "name": "大沽 AIS", "type": "ais",
    "geometry": { "antennaFromSternRatio": 0.1, "antennaFromPortRatio": 0.5, "heightMeters": 10 },
    "expireAfterMs": 600000
  }]
}
```

快照响应固定为 `{ sourceId, status, error, receivedAt, targets }`。`status` 为 `idle/connecting/connected/reconnecting`；`error` 为可展示的异常或坏记录计数，正常时为 `null`；`receivedAt` 为后端最近收到来源消息的 ISO 时间，尚未收到时为 `null`。单船 `targets` 只含以下字段：

| 字段 | 含义 |
| --- | --- |
| `mmsi` | 九位字符串，不转换为数字 |
| `time` | 带时区的 ISO 来源记录时间，不保证是船端发射或定位时刻 |
| `longitude/latitude` | WGS84 十进制度的原始报告位置 |
| `heading` | 真北顺时针船艏度数；本源的 0 值沿用同船当前缓存中的旧船艏，没有旧值时为 `null`；其他不可用值为 `null`，独立于 COG 保存 |
| `cog` | 对地航向，真北顺时针度数，范围为 0°～360°左闭右开；0°有效，360、缺失及其他无效值为 `null`，不重复缩放 |
| `length/width` | 船长/船宽，米；缺失或非正值为 `null` |
| `speed` | 对地航速，节；缺失、负值及本来源不可用编码为 `null`，0 为有效静止值 |

两路来源无偏移的 `date` 均按后端配置 UTC+08:00 解释后输出 ISO；已解码的经纬度和速度不再次按 AIS 位字段缩放。只消费 `api=1`，在各来源内按 MMSI 合并；同身份较新时间优先，同时间以后到的有效记录为准，不合并不同来源的同 MMSI 船舶。适配器将误报为 0 的船艏替换为同船尚未过期的旧船艏，其他字段照常更新；后续有效非零船艏可以替换旧值，456/511 等无效船艏仍输出 `null`。空批、其他类别或本批未出现不删除目标；按来源时间超过 10 分钟清除，旧船艏随目标过期或来源断开清除，超过后端当前时间一分钟的未来记录跳过。坏记录和非法 JSON 公开错误，其他有效记录继续可用。

来源按需连接并在后端共享，断线清空目标后从 2 秒至 30 秒指数退避重连；10 秒连接超时，90 秒无任何消息则重连。SSE 使用 `text/event-stream`，每条 `data:` 为上述完整快照，短批次合并为最多每 250 毫秒一次更新，15 秒注释心跳；慢客户端仅保留一份最新待发快照，不累积增量队列。不依赖 `Last-Event-ID`，重新连接直接取完整状态。未知来源返回 404。服务关闭会结束 SSE 并释放来源连接与定时器。

浏览器页面单选来源，选择按项目保存在当前浏览器，不写摄像头或数据库。AIS 场景显示所选来源的全部有效实时目标，不按摄像头 PTZ/FOV、距离或自定义椭球遮挡筛选，无有效 PTZ 回读时仍显示点。页面以 `addEventListener` 注册 SSE 事件，兼容代理包装的 EventSource；初始化异常时释放订阅并显示“连接失败”、具体原因及重新连接入口，此为页面本地状态。历史模式和离页关闭订阅；切源隔离旧回调。ABCD/船高属于展示边界，开启 ABCD 后按目录参数与有效船长宽估算，也可在前端按数据源与 MMSI 手动覆盖。A/B/C/D 为报告位置至船艏、船艉、左舷、右舷的非负米制距离，A+B、C+D 及船高须大于 0；手动尺寸只保留在当前网页内存，切源或 AIS 更新不覆盖，刷新清除。原始 AIS 记录保持九个字段，手动参数不提交后端、不入库或写浏览器存储；尺寸与选用方向共同决定长方体和中心偏移，方向优先有效船艏，缺失时使用有效 COG。

页面定位 AIS 时默认关闭“使用 ABCD 船体居中”，直接瞄准报告经纬度的零高程点。开启 ABCD 且有有效几何时，按有效船艏优先、COG 回退的方向及估算或手动尺寸瞄准盒中心，中心高度取当前船高的一半；几何缺失时使用报告点。单次定位和持续追踪的 Z 均采用前端“跟踪倍率 Z”中已应用的自定义值，未设置时沿用该次 PTZ 回读的 Z；倍率原样作为 `/api/cameras/:id/precise` 的 `zoom` 提交，不按距离、FOV 或船体尺寸估算、不自动裁剪或取整。前端应用及实际下发时均校验 1 至当前摄像头已保存的最大 Z，超限明确报错。模式、自定义倍率及尺寸只在前端内存保存，不改写统一 AIS 记录或数据库。

地图处于“固定观察”时，单击 AIS 点会选择该船、结束当前 AIS 持续追踪，并复用现有定位流程下发一次 P/T/Z；“跟随摄像头”时只选择并显示详情。单次定位不启用定时追踪，后续 AIS 更新不会重复下发；摄像头和安装参数有效、回读未过期且当前没有保存、控制或扫描占用时才允许定位。等待期间切源、切摄像头、改选目标、恢复跟随、进入历史、离页或修改取景参数，会使尚未下发的旧请求失效。

页面点击“开始追踪”后立即定位，每次调用结束等待 2 秒检查目标；经纬度或船艏变化时，或船艏缺失且 COG 变化时，再次回读 PTZ、刷新来源快照并调用 `/api/cameras/:id/precise`。调用串行，不积压中间更新，不因来源时间、速度或长宽变化单独定位；来源过滤的 0 船艏不会单独引发定位。实时目标过期或来源断开时结束实时追踪。

“预判”使用浏览器缓存的最近 AIS 报告独立运行。提前秒数默认 3，允许可计算的非负秒数及小数；目标时刻为当前浏览器时间加提前秒数，外推跨度包含 AIS 记录到当前的历史时间差。按 `speed ×1852/3600×时间跨度` 得到米制距离，沿 COG 优先、有效船艏回退的方向作 WGS84 匀速恒向外推；0 航速保持原位置。每次定位完成后等待 2 秒，回读 PTZ 后按新的当前时刻重算，不调用来源快照接口或等待 AIS 更新。新 SSE 记录的源时间相同或更新时校正起点，较旧记录不回退；断流和实时目标过期时保留预判缓存并继续外推。

预判点在前端应用 ABCD 和手动倍率，再通过现有 `/api/cameras/:id/precise` 提交 `{pan, tilt, zoom}`；不新增控制接口或改写原始 AIS 记录。成功下发后更新页面的预判位置和时刻，地图目标标注“预判”。缓存、提前秒数和定时器只在当前页面内存保存，刷新不自动恢复。运动数据缺失或时间、坐标不可计算时明确报错；新记录不可预测或定位失败时结束预判。

AIS 单次定位、持续追踪和预判对海平面视距外的目标也反算理论指向，并沿用精确定位接口的 P/T/Z 范围校验。

切换 ABCD 模式、应用跟踪倍率、手动应用尺寸或恢复估算，使旧参数下未下发的请求失效；正在持续追踪或预判时按新参数重新定位。更改提前秒数并再次点击“预判”重新开启推算，“开始追踪”切回实时模式。停止、人工控制、配置保存、截图扫描、目标／来源／摄像头切换、历史、离页或网页隐藏会结束两种模式，旧请求不再下发；失败后不自动重发，需要用户显式重新开启。交互和估算边界见 [README](../README.md#ais-数据源与追踪船体)。

### GeoJSON 标绘接口

一个 `.geojson` 或 `.json` 文件对应一个图层，扩展名不区分大小写。导入请求的 `name` 去除首尾空白后须为 1～200 个字符，`sourceFileName` 为 1～255 个字符的来源元数据，不作为后端磁盘路径。`geojsonText` 是 UTF-8 文件解码后的原文，允许开头的 UTF-8 BOM；BOM 仅在解析副本中去除。重复导入创建新的图层 ID，不覆盖旧图层。

摘要返回 `id`、`name`、`sourceFileName`、`byteLength`、`featureCount`、`geometryTypes`、`createdAt`、`updatedAt` 和 `associations`。`byteLength` 为 UTF-8 原文字节数；`featureCount` 为 FeatureCollection 中的 Feature 数，单个 Feature 或顶层几何对象记为 1；`geometryTypes` 为实际出现的几何类型去重列表，包含遇到的 GeometryCollection。`associations` 每项为 `{ cameraId, visible }`。详情额外返回 `geojsonText`，其格式、未知属性、样式和扩展均保持导入时的原文。业务类型见[标绘模型](../src/app/plot-layer.models.ts)。

接受 Feature、FeatureCollection，以及 Point、MultiPoint、LineString、MultiLineString、Polygon、MultiPolygon、GeometryCollection。Feature 的 `properties` 必须为对象或 null，`geometry` 可为 null。允许空集合和空坐标数组；没有有效几何时由地图明确提示无法定位。坐标须为有限数值，经度 -180°～180°、纬度 -90°～90°，每个位置只能有二维或三维；同一个非集合几何内维度一致，图层和几何集合可以包含不同维度的几何。第三维按米制 WGS84 椭球高度原样保存。

非空线至少两个位置，非空面环至少四个位置并首尾闭合；面有非空内环时必须有非空外环。校验类型、数组层级及坐标，不执行完整拓扑修复或空间分析。CRS 可省略；声明时采用 `{ "type": "name", "properties": { "name": "EPSG:4326" } }` 形式，接受 WGS84、CRS84、EPSG:4326 及对应 OGC URN／标准 URL 名称。其他 CRS、空声明及外部链接声明均拒绝，不猜测坐标系或自动转换。

原文最多 10 MiB，最多 50,000 个 Feature、500,000 个位置、32 层 GeometryCollection 嵌套。超出原文字节上限返回 413，其他结构或处理数量超限返回 400。只有 `POST /api/plot-layers` 的请求体上限扩大为 60 MiB + 64 KiB，以容纳 JSON 字符串转义后的封装；其他接口仍为 65,536 字节，请求体超限同样返回 413。这些上限是处理边界，不代表真实业务文件性能已验收。

`cameraIds` 是完整关联集合，按摄像头 ID 去重，允许为空。导入和关联编辑先确认全部摄像头存在，再通过事务一次提交；失败不产生部分图层，也不改写原有名称、关联或显隐。新关联默认显示，编辑保留交集关联的显隐；解除关联只影响移出的摄像头，不删除原文。显隐按摄像头分别保存，修改名称对全部关联摄像头生效。显隐接口只修改已有关系，不隐式建立关联；删除图层移除全部关联，不影响其他图层或摄像头记录。

图层及关联保存在 SQLite 的 `plot_layers`、`plot_layer_cameras` 表。可写启动时自动建立新表；只读 MCP 不执行迁移，也不依赖新表读取已有业务。名称、关联和显隐的修改都不回写 GeoJSON properties。未知图层、摄像头或未建立的关联返回 404；无效输入返回 400；错误体统一为 `{ "message": "错误说明" }`，不返回导入原文或内部堆栈。HTTP 公开边界回归见[标绘接口测试](../tests/plot-layers.test.mjs)。

### 自动截图与任务接口

实时页使用至少两个有序 PTZ 控制点启动自动截图。控制点可手填或由页面显式回读当前 PTZ 填入；启动接口直接使用提交的目标，不要求当前设备姿态与起点相同。

```http
POST /api/cameras/<CAMERA_ID>/snapshot-scans
Content-Type: application/json

{
  "controlPoints": [
    { "pan": 10, "tilt": 0, "zoom": 2 },
    { "pan": 20, "tilt": 4, "zoom": 6 }
  ],
  "maxPanStep": 3,
  "settleMs": 1000,
  "moveTimeoutMs": 30000
}
```

| 字段 | 约束 |
| --- | --- |
| `controlPoints` | 至少两个有序 `{ pan, tilt, zoom }`；P 为 0～360°，T 为 -90～90°有符号角，Z 为 1～该摄像头已保存的最大倍率 |
| `maxPanStep` | 最大 P 间隔，默认 5°，须大于 0°且不超过 360° |
| `settleMs` | 稳定等待时间，默认 1000 毫秒，范围 0～10000；设为 0 仍要求至少两次回读到位 |
| `moveTimeoutMs` | 每点定位和停稳超时，默认 30000 毫秒，范围 1000～120000 |
| `calibration` | 可选的完整安装标定副本；省略时使用已保存的摄像头参数 |

每段跨度 D=结束 P-起始 P，负值加 360°，要求 D>0。相邻点 P 相同和 360°→0°无效；0°→360°表示整圈。P 始终递增，350°→10°走 20°，10°→350°走 340°，不自动取最短路。

每段划分 N=ceil(D/maxPanStep) 个间隔，实际步长为 D/N；进度 u=i/N（i=0..N），目标 P=(起始 P+uD)%360、T=起始 T+u×T差、Z=起始 Z+u×Z差。包含所有控制点，相邻段共用点只拍一次；总张数为 1+各段 N 之和，超过 10000 在任何设备操作前返回 400。上述示例生成 (10°,0°,2)、(12.5°,1°,3)、(15°,2°,4)、(17.5°,3°,5)、(20°,4°,6) 共五张。0°→360°、间隔 5°共 73 张，首尾分别拍摄。

规划不使用未知倍率的推算 FOV；最大 P 间隔定义目标密度，无法保证画面覆盖无缝。设备在精确定位之间的运动轨迹由设备执行，线性插值只约束采样目标。

启动返回 HTTP 202、`Location: /api/snapshot-groups/<GROUP_ID>` 及任务摘要。摘要保留 `kind: "scan"`、`status`、`controlPoints`、`maxPanStep`、`sampleCount`、`completedCount`、`snapshotCount`、时间、错误和标定副本；冻结的 `targets` 保存完整 PTZ 目标，`targetPanSteps` 保存各目标对应的实际 P 间隔，连接点取两侧较小值。

每点执行精确定位、稳定回读、截图前回读、抓图、截图后回读和持久化。P 按环形角比较，到位容差为 min(0.15°,当前实际 P 间隔/4)，T 为 0.15°，Z 为 max(0.01,目标 Z×0.001)。前后 P/T/Z/FOV 变化时本张不保存、任务失败；实际 `ptz/ptzAfter`、`scanIndex`、`scanTarget` 与标定副本一起保存，图片与姿态严格同步继续为 `unverified`。

任务状态为 `running/pausing/paused/completed/failed/cancelled/interrupted`。暂停等待在途请求和 stop，成功后释放设备；继续使用原冻结目标，从 `completedCount` 开始。删除已拍图片不重拍，已拍满任务继续时只完成停止收尾。完成保持最后位置。停止失败保留设备占用，手动 stop 成功后才能恢复；通道变更返回 409。正常关闭取消执行任务，异常重启标为中断，均不自动驱动设备。

分组和任务列表支持 `limit=1..100`、`offset>=0`，默认每页 30 条，返回 `{ total, groups, offset, nextOffset }`；组内图片默认 50 张，返回 `{ group, total, snapshots, offset, nextOffset }`。分组倒序、组内图片正序，`kind: "single"` 以单张图片 ID 为组 ID。原摄像头截图列表接口仍可读取完整列表。

`DELETE /api/snapshots/:id` 删除单图及文件，成功返回 204，设备扫描或控制中返回 409。文件暂存与数据库删除保持一致，数据库拒绝时恢复原图；删除仅减少 `snapshotCount`，不改变 `completedCount` 或其他样本。

PowerShell 示例：

```powershell
$baseUrl = 'http://127.0.0.1:3000'
$cameraId = '<CAMERA_ID>'
$scanBody = @{
  controlPoints = @(
    @{ pan = 10; tilt = 0; zoom = 2 },
    @{ pan = 20; tilt = 4; zoom = 6 }
  )
  maxPanStep = 3
} | ConvertTo-Json -Depth 4
$task = Invoke-RestMethod "$baseUrl/api/cameras/$cameraId/snapshot-scans" -Method Post -ContentType 'application/json' -Body $scanBody
Invoke-RestMethod "$baseUrl/api/snapshot-groups/$($task.id)"
Invoke-RestMethod "$baseUrl/api/snapshot-groups/$($task.id)/snapshots?limit=50&offset=0"
Invoke-RestMethod "$baseUrl/api/snapshot-tasks/$($task.id)/pause" -Method Post
Invoke-RestMethod "$baseUrl/api/snapshot-tasks/$($task.id)/start" -Method Post
```

已有普通及两阶段海天线任务仍按原存储字段读取和恢复。旧普通任务保留区间中心采样，旧预扫／正式任务保留冻结目标；正式阶段继续检查实际 FOV、原角度余量及 min(0.15°,0.05×VFOV) 的 T 容差。历史海天线任务完成后的自动识别关联保留；页面对历史预扫粗结果保留只查看限制。新任务采用多点请求并手动创建识别；新建请求只接受本节字段。

### 本地识别任务与标定

本地任务不需要 MCP，操作入口和模型环境见 [README](../README.md#本地模型识别与安装参数)。创建时冻结源任务现存截图集合，原始截图和 PTZ 保持不变；运行中的截图任务或空任务不可创建。Python 与 ESSLD 路径分别由 `ESSLD_PYTHON/ESSLD_UPSTREAM` 指定，缺失时返回 503。

识别状态为 `queued/running/completed/failed/cancelled/interrupted`，进度字段为 `completedCount/sampleCount`。本地模型按队列串行运行，关闭时取消在途进程，重启不自动继续。失败或中断后可用同一个 `sourceTaskId` 创建新的识别任务。

任务中的 `revision` 从 0 开始，任何标注或忽略状态保存都会递增并清空旧 `result`。编辑、生成、应用均需提交客户端读取的版本，不匹配返回 409；识别运行或排队中不可编辑、生成或应用。列表与图片分页支持 `limit=1..100`、`offset>=0`，默认每页 30 条。

每个识别条目包含 `snapshotId`、采样元数据副本 `snapshot`、模型原始 `detectedPoints`、当前 `points`、`source=model/manual`、`ignored/ignoreReason`、原图是否已删除 `missing` 及原始检测参数 `detection`。提交的点位固定为两个 `{x,y}`，均在 0～1 内；参与计算时横向跨度至少 10%，被忽略的图片可暂存尚未满足跨度的标注。只修改忽略状态时可省略 `points`，人工点位不会覆盖模型原始输出。源记录删除后 `missing=true`，重新生成会排除此图。

全景参考线通过独立的 `panorama-guide` 接口保存，不进入单图 `points`、`detectedPoints`、忽略状态或安装拟合。无参考线的旧任务返回 `{ "guide": null, "revision": 0 }`。PUT 请求和响应均为 `{ guide, revision }`；请求的 `revision` 必须等于当前参考线版本，成功后加一，`guide:null` 表示删除并同样递增版本。版本冲突返回 409，未知任务返回 404，识别排队或运行中不可修改。

`guide.kind` 支持以下形状，点位顺序决定曲线，不按方位重新排序：

| kind | points |
| --- | --- |
| `line` | 两个端点 |
| `quadratic` | 起点、弯曲控制点、终点，兼容已保存的三点弧线 |
| `bezier` | 5～65 个点且为奇数，按起点、控制点、连接节点、控制点、……、终点交替排列；每一对相邻节点及中间的控制点组成一段二次贝塞尔，相邻段共用连接节点，最多 32 段 |

每点包含有限的 `heading`（展开方位，弧度）和 `elevation`（射线垂直分量与水平长度之比），独立于全景 PNG 尺寸；起终点方位差的绝对值须大于 `1e-9` 弧度，全部点的方位最大值与最小值之差不得超过 `2π`，保留展开值。点数、结构或坐标无效返回 400 且不改变版本。参考线保存在独立的 `recognition_panorama_guides` 表，保存不会改变识别任务的 `revision`、`updatedAt`、计算结果编号或应用状态。该能力仅保存人工复核参照，不覆盖正式标注，不触发重识别或设备控制。

模型无有效点位、采样姿态变化或同组局部倾角/归一化高度突变时默认忽略。邻域、MAD 和最小门槛见 README。突变过滤只比较同一 T/Z/FOV，多点路径的 T/Z 可能逐点变化，须逐图复核不同姿态的样本。自动忽略可手动恢复，恢复前必须有合法点位。过滤不保证边界一定是真正海天线。

`generate` 使用当前设备经纬度、高度及默认朝向，以及未忽略截图的真实 PTZ/FOV。模型 `wgs84-horizon-installation-v1` 联合求解 `pAxisPitch/pAxisRoll/tiltOffset/imageRoll`，复用共用旋转链、WGS84 残差和稳健损失。`result.status` 为 `estimated/insufficient_data/unreliable`，只有 `estimated` 包含 `installation` 四项数值。有效样本参与拟合后，必须收敛、未加阻尼的四参数矩阵条件数小于 `1e8`，各图等权的 RMS 不超过 5 像素；否则返回 `unreliable`。没有有效样本时返回 `insufficient_data`。张数、不同 P 方向数和覆盖范围用于查看分布，样本较少或方向集中时对标注及固定参数误差更敏感。`diagnostics.perSnapshot` 给出逐图像素残差，`diagnostics.rmsAngularResidualDegrees` 给出参与样本真实射线的角度均方根残差，排除项列在 `excluded`。低倍率的像素门槛不直接保证高倍率精度。

`generate` 的失败消息区分未收敛、不可辨识和 RMS 超限；已收敛但残差超限会明确显示实际 RMS 与 5 像素门槛。每次生成新的 `resultId` 并清除当前结果的应用状态。

`generate` 指定 `model=wgs84-horizon-zero-pose-v1` 时，按现存原图的正式海天线、原始 P/T、实测 FOV 和尺寸拟合零位 Roll、Pitch。固定位置及已保存 `zeroPose` 的 Yaw、T 补偿，独立光轴旋转为零。旧摄像头用已保存 P 朝向和 T 补偿，并从旧模型在设备零位的姿态初始化 Roll、Pitch。求解采用同一 WGS84 切线残差和各图等权的 4 像素 Huber 损失。模型收敛、未加阻尼的二参数矩阵条件数小于 `1e8`，且各图等权 RMS 不超过 5 原图像素时返回 `status=estimated` 和 `zeroPose={roll,pitch,yaw,tiltOffset}`。无有效图返回 `insufficient_data`，数值检查未通过返回 `unreliable`，两种状态的 `zeroPose` 均为 `null`。

新版普通候选保存在 `task.zeroPoseCandidate`，含 `model/resultId/revision/generatedAt/generatedCamera/fixedCalibration/sourceSnapshotIds`。每次生成分配新编号，`revision` 对应正式标注和忽略状态版本，`generatedCamera` 是生成时完整配置，`fixedCalibration` 记录位置、Yaw、T 补偿、独立光轴旋转和配置更新时间。`diagnostics` 记录收敛、条件数、像素和角度 RMS 及每张参与原图的误差，`distinctPanCount/panCoverageDegrees` 记录 P 覆盖，`excluded` 记录忽略、正式标注、设备通道、采样姿态、视场角、尺寸和源图缺失等检查的排除项。读取任务时返回 `stale/staleReasons`，相机配置或正式标注版本变更、模型版本变化或任一参与原图删除或缺失时显示过期诊断。旧普通结果和历史预扫粗结果继续使用四参数字段。

`zero-pose-measure` 返回冻结候选在指定参与图上的 `perSnapshot`，包含理论海天线和左、中、右垂直像素差，使用与独立复核相同的原图坐标及符号约定。请求版本、结果编号、来源或质量状态不符时返回 409。生成及原图预览均属于识别任务内的软件计算，独立复核和设备配置应用使用各自入口。

`refinement-sources` 的请求结构如下，客户端仅提交标识和期望版本，不提交角度、PTZ、FOV 或替代标注：

```json
{
  "revision": 0,
  "selectionRevision": 0,
  "base": { "taskId": "base-task-id", "revision": 2, "resultId": "base-result-id", "model": "wgs84-horizon-zero-pose-v1" },
  "supplemental": [{ "taskId": "extra-high-task-id", "revision": 1 }]
}
```

`revision` 对应主任务正式标注；`selectionRevision` 对应独立的来源选择版本，旧任务缺省为 0。保存成功后 `task.refinementSelection={revision:selectionRevision+1,base,supplemental}`，来源选择立即持久化；`base:null` 可清除基础选择。当前主任务自动属于高倍组，不需重复列在 `supplemental`。选择版本变更使旧精修候选过期，不清空普通 `result`，也不修改正式标注版本或全景参考线。

基础来源必须属于同一摄像头，其普通候选的编号与 `base.resultId` 一致，正式标注版本有效，且通过普通拟合质量检查。`base.model` 为 `wgs84-horizon-zero-pose-v1` 时读取 `task.zeroPoseCandidate`，校验完整相机配置版本和基础拟合原图。省略时使用 `wgs84-horizon-installation-v1`，读取四参数结果并核对基础 `fitCamera` 的经纬度、高度、默认朝向和设备通道。历史预扫粗结果仅供查看。主任务和补充任务需结束识别，使用各任务的正式标注。跨来源重复的截图编号返回 409，重复姿态的独立原图可参与。

`refine` 从已保存选择生成 `task.refinement`，每次计算使用新 `resultId`。零位精修模型为 `wgs84-horizon-zero-pose-v1`，四参数精修模型为 `wgs84-horizon-refinement-v1`。基础组仅使用所选普通结果的 `sourceSnapshotIds` 及其正式标注，高倍组包含主任务和全部补充任务的有效图。忽略、缺图、无效正式标注、移动、无效 PTZ/FOV、通道或尺寸等排除原因保存在 `excluded`。零位精修检查实际原图文件。两组均需有效观测，高倍组至少一张实际有效原图的 Zoom 严格高于基础实际参与图最大 Zoom。

求解从同一模型的冻结基础参数开始。零位模型仅求解 Roll 与 Pitch，固定基础的经纬度、高度、Yaw 和 T 补偿，独立光轴滚转取零。四参数模型固定基础的经纬度、高度和默认朝向，求解四项修正。每个残差点的权重为 `1/(2×该组有效图数×该图有效点数)`，同一权重用于稳健目标、梯度及未加阻尼矩阵。所有高倍任务共同构成一组。

`refinement` 字段契约：

| 字段 | 内容 |
| --- | --- |
| `model/resultId/generatedAt/selectionRevision` | 精修模型、独立结果编号、生成时间和本次来源选择版本 |
| `baseCamera` | 冻结的位置及基础解。零位结果来自基础候选的 `generatedCamera` 与求解后的 `zeroPose`，四参数结果来自基础的 `fitCamera` 与 `installation` |
| `generatedCamera` | 生成时相机的完整已保存配置，包括 `updatedAt`。零位精修用它校验相机版本，四参数精修在应用时校验 |
| `sources` | 基础、主任务及补充任务的角色、任务编号、正式标注版本、检查图 `inputSnapshotIds`、实际参与图 `sourceSnapshotIds`。基础来源包含普通结果编号及选择时的模型字段 |
| `sourceSnapshotIds` | 基础和高倍全部实际参与图片的并集，独立复核按此排除参与图 |
| `before/after` | 同一批有效观测上的基础与尝试求解参数，分别用 `zeroPose` 或 `installation` 表示。包含 `objective`、`overall/base/high` 摘要及 `perSnapshot` 原图测量 |
| `overall/base/high` | `sampleCount/zoomRange:{min,max}/distinctPanCount/panCoverageDegrees/rmsResidualPixels/rmsAngularResidualDegrees`，无有效观测的误差与范围为 `null`；overall 的两种 RMS 为两组均方误差等权合并 |
| `perSnapshot` | 沿用下文 `HorizonMeasurement` 的理论线、左中右偏差、方向差、像素和角度残差、真实姿态、尺寸、FOV 及同步状态，补充 `taskId/group:base/high`；前后数组顺序一致 |
| `status`、`zeroPose` 或 `installation` | `estimated` 返回合格精修参数，`no_change` 返回基础参数，`insufficient_data/unreliable` 返回空参数。测量值及尝试参数保留在 `after` |
| `diagnostics` | `converged/conditionNumber/failures`，分别保留收敛、可辨识性、分组超差和目标未改善原因 |
| `stale/staleReasons` | 每次读取实时计算的输入过期状态与原因；保留诊断供查看，不可继续当作有效候选 |
| `applied/appliedAt` | 精修独立应用状态与时间，初始为 `false/null`，成功手动应用后为 `true/ISO 时间`；普通应用状态保持原值 |

合格候选须收敛，所求参数对应的未加阻尼矩阵条件数小于 `1e8`，总体、基础组和高倍组 RMS 均不超过 5 原图像素，且联合稳健目标降低超过 `1e-12×(1+基准目标)`、参数变化不小于 `1e-7` 度。基准满足质量要求且无实际改善时返回 `no_change`，`before/after` 保留基础值。无有效组或没有有效较高倍率返回 `insufficient_data`，其他质量失败为 `unreliable`。

计算在写事务之外完成。保存前在 `BEGIN IMMEDIATE` 内重新核对选择版本、全部正式标注版本、基础结果编号、参与源图和完整当前相机配置。冲突返回 409，候选保存为一次完整写入。列表、任务详情和条目响应实时核对来源选择、基础结果、来源标注与参与图。零位精修还检查原图文件和完整相机配置版本，四参数精修检查固定安装条件。

`refinement-measure` 的 `mode=after` 需要精修 `resultId`。零位精修的 `mode=before` 也可提交该编号。带编号的固定对照使用候选冻结的参与图与对应参数，候选过期时返回 409。实时基准测量使用当前选择的基础参数，响应的 `resultId=null`；四参数 `mode=before` 沿用该方式。响应在固定测量结果上补充 `taskId/revision/selectionRevision/mode/resultId`。逐图 `taskId` 标明来源，客户端从 `GET /api/recognition-tasks/:id/items` 分页读取对应版本的正式标注及元数据，从 `GET /api/snapshots/:id/image` 读取原图。外部参与图在主任务中只读打开。接口只计算精修参与图的原图对照。

`validate` 的 `referenceKind=ordinary` 或 `refinement` 固定另一任务的合格四参数，按本任务全部有效标注直接测量残差。缺省为 `ordinary`。请求的 `revision` 对应验证任务；来源必须是同一摄像头的另一任务，`referenceResultId` 与所选类型的当前结果编号一致且来源不在识别中。普通来源沿用 `wgs84-horizon-installation-v1`、`resultRevision=revision` 和历史预扫粗结果不能作为来源的规则。精修来源要求 `wgs84-horizon-refinement-v1`、`status=estimated`，并实时校验来源选择、全部来源正式标注版本、基础结果编号和全部实际参与图；已应用候选仍可复核。当前经纬度、高度、默认朝向和设备通道必须与普通来源的 `fitCamera` 或精修的 `baseCamera` 一致。验证图与普通拟合参与图或精修的基础及全部高倍实际参与图并集有重叠时返回 409，同一图片从其他任务重复引用仍拒绝，重新拍摄产生的新图片允许参与。只使用未忽略、源记录存在且点位有效的验证图，其余排除原因列在 `excluded`。

复核响应包含 `taskId/revision/generatedAt`、`reference:{ kind, taskId, resultId, revision, createdAt }`、本次固定的 `installation`、实际使用的 `sourceSnapshotIds`、`perSnapshot`、`failedSnapshotIds`、总体 `rmsResidualPixels/rmsAngularResidualDegrees`、最大逐图 RMS `maximumResidualPixels` 及门槛 `maximumAcceptedRmsPixels=5`。精修 `reference` 额外返回冻结的 `selectionRevision/sources`。逐图测量字段如下：

| 字段 | 口径 |
| --- | --- |
| `pan/tilt/zoom/width/height` | 该张截图实际保存的 P/T/Z 与原图尺寸 |
| `horizontalFieldAngle/verticalFieldAngle` | 该图保存的 HFOV/VFOV，单位度；不按倍率比例推算 |
| `timeAlignment` | 保存的画面与姿态同步状态；缺省 `unverified`，读数稳定不等于严格同步 |
| `theoreticalHorizon` | 原图中可见的理论海天线片段数组，每段为归一化 `{x,y}` 点数组，无可见片段时为 `[]`。使用普通来源 `fitCamera` 或精修 `baseCamera` 的固定安装条件、来源结果四参数与本图实际 P/T/FOV，沿用共享旋转链和 WGS84 海平面几何；不混入该图历史安装参数 |
| `verticalResiduals` | 按 `left/center/right` 排列的三项 `{position,x,observedY,theoreticalY,offsetPixels,unavailableReason}`。`x` 为正式标注横向范围左端、中点、右端；`observedY` 按正式标注插值，坐标均归一化。`offsetPixels=(observedY-theoreticalY)×height`，原图向下为正，不向标注范围外推算测量 |
| `verticalOffsetPixels` | 兼容字段，等于 `verticalResiduals` 中点的 `offsetPixels` |
| `directionDifferenceDegrees` | 实拍标注与理论线在标注两端连线的方向角之差，单位度，图像向右为参考、顺时针为正。理论线未经过两端对应竖线时为 `null` |
| `rmsResidualPixels/rmsAngularResidualDegrees` | 原有几何像素 RMS 与射线角度 RMS；它们与有符号垂直偏差、海天线方向差分别命名，不互相替代 |

理论海天线未经过某个对应图像竖线时，该处 `theoreticalY/offsetPixels` 为 `null`，`unavailableReason` 为“理论海天线未经过该图像竖线”；可比较处原因为 `null`。不可比较位置不填零，其余几何 RMS 保留。像素使用每张原图尺寸，跨倍率或分辨率对照可同时参考角度残差；前端缩放只改变绘制。

四参数单模型复核的全部有效图逐图 RMS 均不超过 5 像素时 `status=passed`，有超差图时为 `failed`；无有效图（含无截图条目的历史任务）为 `insufficient_data`，总体误差为 `null`。忽略、缺图和无效正式标注，以及几何有效性检查排除的姿态、通道、尺寸等原因列在 `excluded`。验证任务可以只有单张图，响应只评价实际参与的这些样本，不将其视为全姿态或现场精度验收。结果仅返回客户端，不持久化，不生成精修候选，不清除本任务拟合结果、不应用参数，也不调用 LiveGBS；客户端切换来源或图片、保存正式标注后重新请求，草稿未保存时隐藏旧测量。旧版本、过期来源或固定条件冲突不能继续作为有效对照，历史原图、PTZ 和拍摄时参数副本保持原值。

`referenceKind=zero-pose` 固定来源任务当前有效的普通零位候选，并以该相机已保存的四参数为旧基准。两种模型按同一批有效原图的正式标注、原始 P/T/Z、实测 FOV 及尺寸测量。缺少源截图记录、原图文件或有效观测的图片列入 `excluded`。验证图与候选拟合图或与旧基准相符的已应用四参数结果的实际参与图重叠时返回 409。使用版本过期、相机配置变化或拟合图缺失的候选，以及使用已更新的复核标注版本，同样返回 409。

此模式必须提交 `criteria={minimumHighZoom, maximumVerticalOffsetPixels, maximumDirectionDifferenceDegrees, maximumRmsPixels}`。高倍指 `Z >= minimumHighZoom`，起始 Z 至少为 1。三项误差均取绝对值校验，要求正数门槛，方向差门槛至多 180°。操作者依据重复拍摄和重复标注确定这些门槛。响应中 `baseline` 和 `candidate` 分别给出模型、参数和总体 RMS。每个 `perSnapshot` 按原图 ID 配对两个模型的完整测量，标明 `zoomGroup`、可比较性、超差项 `failures` 和其中相对旧基准变差的 `regressions`。总体验收状态按无有效图、逐图超差、覆盖不足、通过依次判定为 `insufficient_data/failed/insufficient_coverage/passed`。`coverage` 返回高低倍样本数、同时可比较的高倍样本数、实际 P/T 组数、P 覆盖与原因。通过需要所有有效原图的新版偏差和方向均可比较，且两套模型均可比较的高倍图至少覆盖两组 P/T，P/T 组按 0.01° 归并。

在写事务中核对候选、相机和复核标注版本，测量后在来源任务的 `zeroPoseCandidate.validation` 保存最新 `evidence`。证据 `version=1` 包括 `id/status/generatedAt`、来源模型与候选编号、正式标注版本和拟合图 ID、复核任务及正式标注版本和实际复核图 ID、相机 ID 与配置时间、旧基准模型及参数和匹配的已应用来源，以及本次门槛。应用时可在写锁内按该服务端证据重测并核对全部版本；客户端只提供证据编号。请求本身只保存复核证据。

`apply` 必须同时提交读取的 `revision` 与 `resultId`，只读取服务端保存的合格结果，不接收前端角度值；校验标注版本、结果编号、计算参考的当前设备配置、设备通道、源记录仍存在以及设备未被控制/截图占用。在同一事务中更新四项修正与应用状态，其他设备字段保持原值；不调用 LiveGBS 控制、修改原始 PTZ 或回写历史截图。成功后记录 `appliedAt/appliedRevision`；无合格结果、配置改变、源图删除、过期版本或重复应用返回 409。此写入能力仅属于本地网页流程，MCP 工具继续只读且只估计两个 P 轴倾角。

`refinement-apply` 只接受主任务 `revision` 和精修 `resultId`，角度取自服务端保存的候选。在 `BEGIN IMMEDIATE` 取得写锁后重新读取候选编号、全部来源版本和基础结果编号、来源选择、参与图存在性、固定条件、当前完整相机配置与生成时 `generatedCamera`（含 `updatedAt`），并检查设备控制／截图占用。仅未应用、未过期且 `status=estimated` 的精修候选可应用；`no_change`、质量失败、旧编号、来源或配置变化、占用及重复应用均返回 409，额外角度等非法输入返回 400。一次事务只保存四项安装修正与 `refinement.applied/appliedAt`，任一失败整体回滚；普通 `result/resultId/appliedRevision/appliedAt`、其他来源任务、原始 PTZ 和历史采样副本不变。成功返回新摄像头配置供页面同步预览，不调用 LiveGBS；应用后的候选可继续固定参数独立复核。

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
