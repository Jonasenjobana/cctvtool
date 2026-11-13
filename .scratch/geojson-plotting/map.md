# GeoJSON 标绘管理与摄像头图层控制

Labels: wayfinder:map
Status: resolved

## Destination

形成可直接用于实施的 GeoJSON 导入、独立标绘管理页面与 Cesium 图层控制方案，明确 SQLite 持久化、多个摄像头关联及管理操作的业务边界。

## Notes

- 当前按 implement-spec 执行[GeoJSON 标绘管理规格](spec.md)，实施状态保存在 `tasks/`；本地图记录已明确的决策，图层功能是否完成以实施票与实际验证为准。
- 用户已确认：一个 GeoJSON 文件对应一个标绘图层，图层内要素统一显示或隐藏；数据存入 SQLite，同一图层可以关联多个摄像头。
- 用户已确认：独立标绘管理页面提供导入、改名、删除、定位与显隐；Cesium 地图内提供图层显隐面板。首版不包含手工绘制与单要素编辑。
- 用户已确认：按 WGS84 经纬度导入，保留已有高程，无高程的点、线、面贴地显示；优先使用文件内样式，缺省使用统一样式，首版不提供样式编辑器。
- 术语遵循[标定与标绘术语](../../GLOSSARY.md)。现有业务约定与验证入口见 [README](../../README.md)、[API](../../docs/API.md)。
- 当前项目使用 Angular 22、Cesium 1.147 与 SQLite；Node 和 npm 版本沿用 `.nvmrc`、`package.json` 与锁文件。当前没有标绘模块，复用现有页面结构、ApiService 和存储方式，无需先改造路由体系。
- [场景组件](../../src/app/camera-scene.component.ts)随页面切换销毁和重建，图层业务状态需要在 Viewer 外保存；现有跟随观察会在 PTZ 更新时重新定位，图层定位需处理这一交互。场景启用了按需渲染，显隐变化需要请求重绘。
- [接口入口](../../server/app.mjs)的当前全局请求体上限为 65,536 字节；导入容量方案需要显式处理这一边界。图层原始数据和展示状态分离，Cesium 对象在展示边界生成。
- 用户已确认按摄像头独立保存显隐，地图只加载当前摄像头关联的图层；允许零关联，解除关联只影响该摄像头，删除图层移除全部关联。只新增 HTTP API 测试，前端执行构建检查。
- 实施时读取 implement-spec、TDD 和适用的 Cesium 技能；用户指定的前端验证范围优先。不得进行浏览器调试，不操作真实设备，保留工作区已有改动。
- 沿用仓库的本地 Markdown 跟踪方式：子票位于 `issues/`，`Parent:` 指向本地图，`Blocked by:` 记录依赖。`Status: open`、`Assignee: unassigned` 且所有依赖已关闭的子票属于可领取范围。领取时先修改负责人，答案记在子票的解决评论中，再关闭子票并在下方加入链接；初始建图不关闭决策票。

## Decisions so far

- [多摄像头共用图层时怎样控制显隐](issues/01-camera-layer-visibility.md)：当前摄像头过滤，关联独立显隐，新关联默认显示。
- [共享标绘怎样修改关联和删除](issues/02-associations-and-removal.md)：保留零关联，解除单项关联和删除整图分别操作。
- [GeoJSON 导入需要哪些数据与容量边界](issues/03-import-contract.md)：采用规格中的 WGS84、10 MiB 原文上限、整份拒绝与重复新建规则。

## Not yet specified

首版实施范围已明确；真实业务文件性能、浏览器和现场精度验收不由本轮自动检查证明。

## Out of scope

- [标绘管理页和地图面板怎样协同](issues/04-management-interaction.md)的独立原型流程不再开展；用户已要求进入实施，页面交互直接按实施规格实现。
- 不执行真实设备控制或采样。
- 手工绘制、单要素几何与属性编辑、图层样式编辑器。
- 自动识别或转换 GCJ-02、BD-09 与其他投影坐标。
- KML、KMZ、Shapefile 等其他文件格式导入，以及新增导出功能。
- 摄像头、视锥、视频与底图的现有显示控制改造。
- 本轮不进行浏览器、WebGL 或现场精度验收；后续自动检查也不能替代这些验收。
