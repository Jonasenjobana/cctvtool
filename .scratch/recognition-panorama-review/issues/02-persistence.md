# 全景参考线独立持久化

Status: resolved
Assignee: /root/implement_persistence
Blocked by:
Spec: [识别全景与相邻端点复核交互规格](../spec.md)

## 范围

实现 GET/PUT /api/recognition-tasks/:id/panorama-guide。GET 返回 { guide, revision }；无记录返回 { guide: null, revision: 0 }。PUT 接受同样对象，revision 为独立参考线版本，写入后加一；guide:null 表示删除。共享类型见 shared/panorama-guide.ts，二次弧线点顺序为起点、控制点、终点。

通过独立存储保持识别任务 revision、updatedAt、points、ignored、result/resultId 和 applied 状态完全不变。真实输入边界校验有限坐标、kind 对应的点数、有效非退化方位范围；乐观并发冲突 409、未知任务 404、活动识别任务不可编辑。保持旧任务与只读存储兼容。

拥有文件：server/store.mjs、server/recognition.mjs、tests/recognition.test.mjs、src/app/api.service.ts（仅新增参考线方法与类型导入）。不修改识别组件、几何或 README/API 文档。

## 验证

沿用模拟 HTTP 公开入口按 TDD 验证保存／删除／重启、旧任务缺省、任务隔离、非法形状、版本冲突及保存参考线不改变安装结果或正式标注版本。完成答案记录接口与实际验证。

## Answer

已在隔离工作树 `C:\Users\Administrator\.codex\worktrees\panorama-persistence\cctv-tool` 的 `feat-panorama-guide-storage` 分支完成，基线为 `0d306b3a15dff6692c7c8a3ec38f8eb6b1a18dd0`；未提交、合并或推送。

- `GET /api/recognition-tasks/:id/panorama-guide` 返回 `{ guide, revision }`，无参考线记录时为 `{ guide: null, revision: 0 }`。
- `PUT` 同一路径接收 `{ guide, revision }`，以独立版本乐观写入，成功后版本加一；`guide: null` 删除也保留新版本，重复删除仍加一，防止旧草稿在删除后恢复已过期内容。版本冲突或排队／运行中的识别任务返回 409，未知任务返回 404。
- 直线恰好两个点；二次弧线恰好三个点，顺序为起点、控制点、终点。坐标必须为有限数值，保留展开 `heading` 原值（弧度）与 `elevation` 射线高度比；首末点方位差的绝对值须大于 `1e-9` 弧度，所有点的方位最大值减最小值不得超过 `2π`。不额外要求控制点位于首末点方位之间，也不把高度比限制为角度或 0～1。请求版本须为 0～`Number.MAX_SAFE_INTEGER - 1` 的整数；非法输入返回 400，失败不改写数据。
- 独立 `recognition_panorama_guides` 表及事务保存参考线，不调用正式任务／标注更新方法，不改写任务 `revision/updatedAt`、正式点位和忽略状态、`result/resultId`、应用状态或摄像头配置。可写启动时建表；只读打开旧库不迁移，现有读取流程不依赖新表。
- 客户端新增 `recognitionPanoramaGuide(id)`、`savePanoramaGuide(id, revision, guide)`，返回 `Promise<PanoramaGuideState>`；仅导入共享类型，未改共享类型或 UI。

实际验证：模拟 HTTP 的缺省读取、保存与重启、形状、方位和版本边界分别经历失败→实现→通过；新增六项 HTTP 用例，并在原队列用例覆盖排队／运行时的保存和删除限制。`node --test tests/recognition.test.mjs tests/store.test.mjs` 为 13/13 通过；补强人工忽略图片场景后，单独重跑参考线保存／安装状态用例通过。类型及差异检查通过，集成主工作区完整回归 185/185、生产构建通过。未进行浏览器调试、真实设备动作或现场验收。

交付补丁：`C:\Users\Administrator\.codex\scratch\cctv-panorama-review\persistence.patch`，仅含四个拥有文件，已通过反向 `git apply --check`；上下文复制的 `GLOSSARY.md`、`shared/panorama-guide.ts` 不在补丁中。
