# GeoJSON 标绘管理

## 范围与验证约定

一个 GeoJSON 文件对应一个标绘图层，原始文件文本存入本工具 SQLite，可关联零个或多个摄像头。独立标绘管理页提供导入、改名、关联修改、删除、定位及显隐；三维地图提供当前摄像头图层面板。

用户已确认：地图只加载当前摄像头关联的图层，各摄像头独立保存显隐，新关联默认显示；解除关联只影响该摄像头，删除图层删除原始数据及全部关联，允许保留未关联图层。

用户已确认：WGS84 经纬度、保留已有高程、无高程贴地；文件样式优先，缺省使用统一样式。不做手工绘制、要素编辑、样式编辑器、其他坐标系转换、其他文件格式或导出。

用户指定只新增 HTTP API 公开边界测试，前端通过生产构建检查，不新增地图模块或组件测试。沿用 Node 22.22.3、npm 和现有依赖；禁止浏览器调试及真实设备操作。改动前完整回归为 114 项通过。

## 导入边界

- 接受 UTF-8 `.geojson` 或 `.json` 文件，原文最大 10 MiB。允许 UTF-8 BOM，解析时去除 BOM，持久化保留原文。重复导入创建独立图层，不覆盖已有记录。
- 接受 Feature、FeatureCollection 及 GeoJSON 几何对象：Point、MultiPoint、LineString、MultiLineString、Polygon、MultiPolygon、GeometryCollection。Feature 的 properties 为对象或 null，geometry 可为 null；允许空集合，地图定位无有效几何时明确提示。
- 坐标为有限数值，经度在 -180～180、纬度在 -90～90；位置只能为二维或三维。单个非集合几何内维度一致，图层及 GeometryCollection 可混合二维、三维几何。第三维为米制 WGS84 椭球高度，不改写原始数值。
- 线至少两个位置，非空面环至少四个位置且首尾闭合；验证类型、数组层级及坐标，不新增完整拓扑修复或空间分析。空坐标数组可作为无几何展示的数据保留；部分非空坐标无效时整份拒绝。
- 仅接受未声明 CRS 或明确声明 WGS84/CRS84 的数据；不对其他 CRS 猜测、自动转换或静默空加载。
- 导入整体校验后一次入库；非法 JSON、结构、坐标或摄像头关联不产生部分图层。最多 50,000 个 Feature、500,000 个位置、32 层几何集合嵌套，超限明确报错。这些是处理边界，不代表真实文件性能已验收。
- 仅 POST 导入路由扩大请求体上限，须容纳原文 JSON 字符串转义后的 envelope；其他接口保持现有 65,536 字节限制。服务端仍按原文 UTF-8 字节数执行 10 MiB 限制。

## 统一数据与接口

前端纯业务类型集中在 `src/app/plot-layer.models.ts`，不包含 Cesium 对象：

```ts
interface PlotLayerAssociation { cameraId: string; visible: boolean; }
interface PlotLayerSummary {
  id: string; name: string; sourceFileName: string; byteLength: number;
  featureCount: number; geometryTypes: string[];
  createdAt: string; updatedAt: string;
  associations: PlotLayerAssociation[];
}
interface PlotLayerDetail extends PlotLayerSummary { geojsonText: string; }
interface PlotLayerImportInput {
  name: string; sourceFileName: string; geojsonText: string; cameraIds: string[];
}
interface PlotLayerUpdateInput { name: string; cameraIds: string[]; }
interface PlotLayerRenderInput { id: string; name: string; geojsonText: string; visible: boolean; }
interface PlotLayerFocusRequest { layerId: string; requestId: number; }
interface PlotLayerError { layerId: string; message: string; }
interface PlotLayerFocusResult { requestId: number; success: boolean; message: string; }
```

`featureCount` 表示 GeoJSON Feature 数；单个 Feature 或顶层几何对象记为 1。列表返回摘要，不携带原文。名称去除首尾空白，长度为 1～200；来源文件名长度为 1～255，仅为元数据，不作为后端磁盘路径。

| 方法与路径 | 请求 | 返回 |
| --- | --- | --- |
| GET `/api/plot-layers` | 无 | `PlotLayerSummary[]` |
| GET `/api/plot-layers/:id` | 无 | `PlotLayerDetail` |
| POST `/api/plot-layers` | `PlotLayerImportInput` | 201 + `PlotLayerDetail` |
| PUT `/api/plot-layers/:id` | `PlotLayerUpdateInput` | `PlotLayerSummary` |
| PUT `/api/plot-layers/:id/cameras/:cameraId` | `{ visible: boolean }` | `PlotLayerAssociation` |
| DELETE `/api/plot-layers/:id` | 无 | 204 |

未知图层、摄像头或不存在的关联返回 404；无效输入返回 400；原文或请求体超限返回 413。错误沿用 `{ message }`，不把导入原文或内部异常堆栈返回给用户。

ApiService 使用 `plotLayers()`、`plotLayer(id)`、`importPlotLayer(input)`、`savePlotLayer(id,input)`、`setPlotLayerVisibility(id,cameraId,visible)`、`deletePlotLayer(id)`，沿用同源 HttpClient 与明确超时。

## SQLite

在可写存储启动分支创建 `plot_layers` 和 `plot_layer_cameras`。前者保存原文及独立管理元数据，后者以 `(layerId,cameraId)` 为主键保存布尔显隐，并引用图层与摄像头。删除图层级联删除关联；不增加摄像头删除能力，不修改已有业务表。

导入与关联编辑使用事务；先确认所有摄像头存在，摄像头 ID 去重。编辑关联保留交集关系的显隐，只为新增关系赋默认显示。名称共享，修改后全部关联摄像头看到相同名称。原文保持不变，名称、关联和显隐都不回写 GeoJSON properties。旧库可写启动自动建立新表，只读 MCP 不执行迁移，也不依赖新表读取旧业务。

## 管理页与地图

- 左侧菜单增加“标绘管理”。管理页沿用全宽工作区，隐藏云台控制栏，不新增路由体系；提供简单表格/列表及导入与编辑表单。
- 管理页列出全部图层，包含名称、来源文件、要素数、关联摄像头与操作。摄像头上下文默认跟随当前选择，可选择其他摄像头，用于显隐及定位；未关联该上下文时显隐和定位不可用，并提供关联编辑入口。
- 导入时显示文件名、管理名称和摄像头多选，默认勾选当前摄像头，也可全部取消。导入失败保留输入和关联选择；加载及写入期间避免重复提交，保存失败明确显示，不伪装成功。
- 编辑名称及关联使用独立草稿，点击保存后生效；点击删除明确提示名称及受影响摄像头后才执行整份删除。未关联图层可保留与改名，关联后可在地图使用。
- 地图工具栏增加图层面板，列出当前摄像头关联的图层，提供显隐、定位、刷新/重试及进入管理页。显隐写入成功后更新页面状态；失败保留已保存状态并显示错误。
- 从管理页定位时，先通过现有摄像头切换与离页保护，确认成功后进入地图。定位目标若隐藏，先保存为显示；定位前关闭跟随观察，避免下一次 PTZ 更新抢回镜头。不发送 PTZ 控制。
- 图层数据和显隐保留在 Viewer 外；返回地图、切换摄像头、刷新或服务重启后，从已保存记录恢复。当前未选择摄像头时不加载图层。

## 场景接入契约

`CameraSceneComponent` 增加 Input `plotLayers: readonly PlotLayerRenderInput[]` 与 `plotFocus: PlotLayerFocusRequest | null`，Output `plotLayerError: PlotLayerError` 与 `plotFocusResult: PlotLayerFocusResult`。场景初次创建与 Input 变化时同步；聚焦请求以 requestId 区分重复定位同一图层。

每个业务图层持有自己的 Cesium GeoJsonDataSource 或受控子源，整体显隐与定位统一处理。复用 Cesium 的 GeoJSON 和 simplestyle 支持，统一默认颜色与线宽；不修改摄像头点、视锥、覆盖线、视频或底图。带高程的线不能统一启用贴地，二维和三维几何在展示副本中分开处理；原文及 properties 不被改写。

同一原文的改名、显隐不重复解析几何。切换、移除、隐藏、定位或销毁期间应核对最新同步代次和 Viewer 身份；迟到的 load/add/flyTo 结果不能把旧图层放回新场景。只移除本模块拥有的资源，释放实体、监听及引用；按需渲染的场景在变化后请求重绘。单个图层加载失败需明确显示并可重试，不影响其他图层及原有场景。

## 实施任务与验收

任务保存在 `tasks/`，采用本地 Markdown 的 `Status`、`Assignee` 与 `Blocked by`。API/存储、场景、管理页三票按统一接口并行，集成验收票依赖三票完成。每个实施子代理在以集成分支为基线的独立工作树工作，完成时合并最新集成分支。

HTTP 公开边界测试按用户确认采用 TDD，覆盖原文与元数据的重启恢复、多摄像头显隐隔离、关联修改保留状态、零关联与删除范围、无效输入整份拒绝、未知资源、容量边界及其他接口限制保持。测试通过 Fastify HTTP 注入访问公开路由，不通过数据库内部实现断言业务结果。

前端执行生产构建及源码审查，不新增测试。最终运行必要回归，分别做标准与规格审查，修复发现的问题后关闭实施票。浏览器布局、真实 WebGL、复杂业务文件性能、地物对齐和现场精度仍待实际验收。
