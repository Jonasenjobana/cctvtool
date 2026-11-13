# 接入 Cesium 标绘加载与定位

Type: implementation
Status: open
Assignee: unassigned
Parent: [GeoJSON 标绘管理](../spec.md)
Blocked by:

## 工作范围

按[规格](../spec.md)的场景公开契约实现 GeoJSON 展示、二维贴地与三维高程保留、文件样式、图层显隐、定位、异步代次保护与资源释放。只持有本模块的 Cesium 资源，不改已有摄像头与视频行为。

负责 `src/app/camera-scene.component.ts` 及必要的新场景辅助模块。统一类型由 API 票提供；按规格先并行实现，合并该票后执行构建。用户指定前端仅构建，不新增场景或组件测试，不运行浏览器。
