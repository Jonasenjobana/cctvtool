# 实现标绘持久化与 HTTP API

Type: implementation
Status: in-progress
Assignee: /root/plot_api
Parent: [GeoJSON 标绘管理](../spec.md)
Blocked by:

## 工作范围

按[规格](../spec.md)实现 GeoJSON 导入校验、SQLite 图层与关联存储、公开 HTTP 路由、前端统一业务类型与 ApiService 方法，并同步 API 文档。仅新增 HTTP 公开接口测试，按已确认边界逐个完成红绿循环。

负责 `server/store.mjs`、`server/app.mjs`、新的标绘后端模块、`tests/plot-layers.test.mjs`、`src/app/plot-layer.models.ts`、`src/app/api.service.ts` 与 `docs/API.md`。不修改场景与管理页文件，不操作真实数据目录。
