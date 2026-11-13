# 提供两阶段海天线采样入口与复核衔接

Type: task
Status: resolved
Assignee: implement_ui
Blocked by:
Spec: [海天线保持自动截图实现规格](../spec.md)

## Question

按已冻结的 API 契约实现前端预扫表单、阶段展示、关联识别跳转、人工复核后启动正式扫描及错误状态，并同步 README/API。构建验证模板及类型，不新增未经确认的测试边界，不进行浏览器调试。

## Answer

已在实时表单提供普通／海天线预扫选择、预扫倍率及允许 T 范围，开始前重新回读当前姿态。截图任务展示采样阶段、目标倍率、自动识别关联和识别创建失败；识别页从来源截图任务读取阶段，复核确认绑定当前任务、revision 和 resultId，编辑或重新生成后清除确认。源预扫 completed、识别已结束且候选有效、无未保存内容并明确确认后，调用 horizon-scan 创建正式任务并跳转进度页；粗结果只供扫描控制，最终结果保留手动应用入口。

README/API 已同步当前流程、契约及预测限制。Node 22.22.3/npm 10.9.8 下 `npm run build` 通过（最终构建 11.538 秒），`git diff --check` 通过；仅有既有 flv.js/Cesium CommonJS 提示。依已确认边界不新增 UI 测试，不进行浏览器、真实设备或现场精度验收。
