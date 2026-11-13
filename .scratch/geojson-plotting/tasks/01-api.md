# 实现标绘持久化与 HTTP API

Type: implementation
Status: resolved
Assignee: /root/plot_api
Parent: [GeoJSON 标绘管理](../spec.md)
Blocked by:

## 工作范围

按[规格](../spec.md)实现 GeoJSON 导入校验、SQLite 图层与关联存储、公开 HTTP 路由、前端统一业务类型与 ApiService 方法，并同步 API 文档。仅新增 HTTP 公开接口测试，按已确认边界逐个完成红绿循环。

负责 `server/store.mjs`、`server/app.mjs`、新的标绘后端模块、`tests/plot-layers.test.mjs`、`src/app/plot-layer.models.ts`、`src/app/api.service.ts` 与 `docs/API.md`。不修改场景与管理页文件，不操作真实数据目录。

## 实施结果

已实现原文及独立元数据持久化、GeoJSON 结构／坐标／CRS／容量校验、关联事务与独立显隐，以及规格中的六个 HTTP 路由。共享模型、ApiService 和 API 文档已同步，接口契约无偏差。空外环但存在非空内环的面按结构无效拒绝，整空面继续保留。

## 实际验证

- Node 22.22.3、npm 10.9.8；HTTP 测试仅使用临时数据目录和模拟上游。
- 已合并最新 `feat-geojson-plotting`；合并后 `node --test tests/api.test.mjs tests/plot-layers.test.mjs` 为 27 项通过，其中标绘 HTTP 回归 13 项，按逐片红绿循环完成。
- 回归覆盖原文与元数据重启恢复、显隐隔离、关联状态保留、零关联、重复导入及删除范围、整份拒绝、404、10 MiB 原文与转义封装、其他接口 64 KiB 限制、50,000 个 Feature、500,000 个位置及 32 层嵌套边界。
- `node --check` 检查新增后端模块与改动的后端入口、存储模块通过；差异空白检查通过。
- 未读取 `.env` 或真实业务数据；未进行浏览器、真实设备、复杂业务文件性能或现场精度验收。前端生产构建与全量回归由集成验收票统一执行。
