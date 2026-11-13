# 实现标绘管理页与地图图层面板

Type: implementation
Status: in_progress
Assignee: /root/plot_ui
Parent: [GeoJSON 标绘管理](../spec.md)
Blocked by:

## 工作范围

按[规格](../spec.md)实现独立标绘管理页面、导入与关联编辑、改名与删除、按摄像头显隐、地图图层面板和定位衔接，原文与可见状态在 Viewer 外保存。保持设备切换保护、识别草稿保存及现有页面行为。

负责 `src/app/app.component.ts/html/css`、`src/app/icon.component.ts`、新增管理页及必要的前端状态模块，并同步 README。统一类型和 API 方法由 API 票提供，场景接口由场景票提供；按规格先并行实现，集成后构建。用户指定前端仅构建，不新增测试，不运行浏览器。
