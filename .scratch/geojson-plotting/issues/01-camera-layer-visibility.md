# 多摄像头共用图层时怎样控制显隐

Type: grilling
Labels: wayfinder:grilling
Status: resolved
Assignee: unassigned
Parent: [GeoJSON 标绘管理与摄像头图层控制](../map.md)
Blocked by:

## Question

同一图层关联摄像头 A 和 B 时，A 隐藏该图层是否影响 B？显隐状态应保存为整个图层的共同状态，还是分别保存到各摄像头关联？

切换摄像头时，地图应只展示当前摄像头关联的图层，还是保留其他摄像头的图层？独立管理页与地图面板以哪个摄像头作为显隐操作的上下文？明确刷新、切页返回和切换摄像头后的恢复规则，以及新导入或新关联图层的初始状态。

## Resolution

用户已确认：地图只加载当前摄像头关联的图层；各摄像头独立保存显隐，A 隐藏不影响 B；新关联默认显示。管理页选择摄像头上下文进行显隐，刷新、切页和重启从 SQLite 已保存关系恢复。实施契约见[规格](../spec.md)。
