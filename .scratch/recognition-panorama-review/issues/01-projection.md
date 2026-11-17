# 全景置顶画面与参考线投影

Status: resolved
Assignee: /root/implement_projection
Blocked by:
Spec: [识别全景与相邻端点复核交互规格](../spec.md)

## 范围

实现同一全景计划下当前截图的不透明投影画面；导出全景点与原图点转换、直线／二次弧线采样及可见片段裁切，供全景绘线和下方相邻参照复用。持久坐标类型使用共享的 PanoramaGuide；quadratic.points 按起点、控制点、终点排序。不要修改识别组件、API 或后端。

拥有文件：src/app/panorama-math.ts、src/app/task-panorama.ts、tests/panorama-math.test.ts；如确需新几何文件可在同一目录创建，勿重复已有计算。

## 验证

使用公开几何入口按 TDD 一条行为一条实现，验证已知方向、跨零、不同 T/FOV/Roll、原图直线映射邻图、曲线可见片段不跨背面连线、稳定坐标重建一致，以及置顶渲染不混入邻图颜色。运行相关测试，导出接口与调用示例写在完成答案中。

## Answer

补丁：`C:\Users\Administrator\.codex\scratch\cctv-panorama-review\projection.patch`。基于 `0d306b3a15dff6692c7c8a3ec38f8eb6b1a18dd0`，仅包含 `src/app/panorama-math.ts` 与 `tests/panorama-math.test.ts`；`task-panorama.ts` 的同计划单帧包装已在集成主工作区完成。

公开接口：

- `createPanoramaFrame(snapshot, referenceHeading?): PanoramaFrame`：单张截图即可构造投影姿态，无需先生成全景；参考方位使用弧度，仅选择展开圈数。
- `imagePointToPanoramaPoint(frame, point): PanoramaGuidePoint | null`：归一化原图点转为展开 `heading` 与圆柱坡度 `elevation`。
- `panoramaPointToImagePoint(frame, point): HorizonPoint | null`：持久点转为归一化原图点，背面和画面外返回 `null`，供真实端点显隐使用。
- `panoramaPixelToPoint(plan, pixel)`、`panoramaPointToPixel(plan, point)`：全景像素与持久坐标双向转换，沿用同一计划的原点及比例。
- `panoramaGuideHeadingOffset(plan, guide): number`：整条参考线共用的 `2π` 整数倍偏移；删首图重建后可对齐新的展开圈数，持久点保持原值。
- `samplePanoramaGuide(guide, segments = 128): PanoramaGuidePoint[]`：直线或按起点／控制点／终点定义的二次 Bézier 弧线采样。
- `projectPanoramaGuide(frame, guide): HorizonPoint[][]`：归一化原图中的可见曲线片段；先求当前单帧方位覆盖的参数区间，再局部采样并做三维视锥裁切，避免长全景窄 FOV 漏线及背面连线。
- `projectImageLine(source, target, points): HorizonPoint[][]`：源图两点直线到目标原图的精确可见片段；源图两端都在目标画面外时仍保留中间可见部分，可配合 `extendHorizonLine` 显示邻图参照。

调用示例：

```ts
const target = createPanoramaFrame(current.snapshot);
const neighbor = projectImageLine(createPanoramaFrame(previous.snapshot), target, extendHorizonLine(previous.points));
const visibleGuide = projectPanoramaGuide(target, guide);
const offset = panoramaGuideHeadingOffset(plan, guide);
const pixels = samplePanoramaGuide(guide).map((point) =>
  panoramaPointToPixel(plan, { ...point, heading: point.heading + offset }));
const dragged = panoramaPixelToPoint(plan, pointerPixel);
const storedPoint = { ...dragged, heading: dragged.heading - offset };
```

全景显示与手柄使用同一偏移，拖动反算后减去偏移；超出当前画布的部分按画布裁切，不逐点回绕或连接跨缝片段。原图曲线通过返回的多个片段分别绘制。

验证：`node --test tests/panorama-math.test.ts` 为 24/24 通过，覆盖已知方向、跨零邻图、T/FOV/Roll、两端在外裁切、整周背面缺口、0.1°窄视场、控制点越出端点后折返、分辨率重建与删首图重建，以及单帧中心和边缘纯色、不透明、视野外透明。整周画布取整余量及不同起始方位的浮点边界已有回归，绘制范围不会超出后端允许的一周。相关姿态回归共 17 条、类型与模板检查通过；集成主工作区完整回归 185/185、生产构建与差异检查通过。未进行浏览器调试、真实设备或现场精度验证；未提交、合并或推送。
