# 接入 Cesium 标绘加载与定位

Type: implementation
Status: done
Assignee: /root/plot_scene
Parent: [GeoJSON 标绘管理](../spec.md)
Blocked by:

## 工作范围

按[规格](../spec.md)的场景公开契约实现 GeoJSON 展示、二维贴地与三维高程保留、文件样式、图层显隐、定位、异步代次保护与资源释放。只持有本模块的 Cesium 资源，不改已有摄像头与视频行为。

负责 `src/app/camera-scene.component.ts` 及必要的新场景辅助模块。统一类型由 API 票提供；按规格先并行实现，合并该票后执行构建。用户指定前端仅构建，不新增场景或组件测试，不运行浏览器。

## 实施结果

- 已按公开 Inputs/Outputs 接入图层加载、改名、显隐、定位及独立失败提示；失败图层在下一次 Input 同步时重试。
- 展示副本按二维与三维几何拆分，沿用 Cesium GeoJSON 与 simplestyle，二维贴地，三维保留 WGS84 椭球高度；原文和 properties 不回写。
- 同原文复用现有资源；同步代次、数据源身份与 Viewer 生命周期保护过期加载、添加和定位，销毁时只移除标绘资源。
- 已合并共享类型提交 `f89b5e6` 及最新集成基线 `bd0a358`；`npm run build` 和差异检查通过，仅保留既有 CommonJS 依赖提示。
- 未新增地图或组件测试；未执行浏览器、真实 WebGL、复杂文件性能、真实设备或现场精度验收。
