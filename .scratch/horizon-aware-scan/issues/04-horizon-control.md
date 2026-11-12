# 实现并验证海天线 T 反求与角度余量

Type: task
Status: resolved
Assignee: /root/implement_geometry
Blocked by:
Spec: [海天线保持自动截图实现规格](../spec.md)

## Question

按规格实现公开几何求解接口和粗拟合角度残差诊断，用独立椭球射线验证可达解、中心海天线、参考分支选择和不可达目标。只修改几何模块、必要拟合诊断及对应测试。

## Answer

`server/horizon-control.mjs` 提供 `solveHorizonTilt` 与 `horizonOffsetDegrees`：共用旋转链，在 WGS84 缩放空间求前向可见的相切射线，再按真实 ENU 上方向保持参考 T 的俯仰分支，并在允许的连续原始 T 区间选择最近值。不可达、无效标定和控制输入明确返回 400；不截断越界 T，不跨 0°包装负 T。中心角差朝天为正。

`estimateInstallation.diagnostics.rmsAngularResidualDegrees` 按参与图像等权汇总真实观测射线的角度残差，供后续扫描计算模型余量。该字段不改变现有拟合质量门槛，也不代表现场精度保证。

TDD 已逐项记录模块/导出缺失、不可达未拒绝、完整区间误判、反向分支误选和角度诊断缺失的失败后实现。`node --test tests/horizon-control.test.mjs tests/installation-calibration.test.mjs tests/tilt-calibration.test.mjs` 通过 19 项，测试期望来自独立椭球射线命中分界。浏览器、真实设备、截图同步与现场精度未验收。
