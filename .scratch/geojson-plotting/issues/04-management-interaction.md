# 标绘管理页和地图面板怎样协同

Type: prototype
Labels: wayfinder:prototype
Status: closed
Assignee: unassigned
Parent: [GeoJSON 标绘管理与摄像头图层控制](../map.md)
Blocked by: [多摄像头共用图层时怎样控制显隐](01-camera-layer-visibility.md), [共享标绘怎样修改关联和删除](02-associations-and-removal.md), [GeoJSON 导入需要哪些数据与容量边界](03-import-contract.md)

## Question

基于已明确的数据和摄像头关系，用简洁原型确认独立标绘管理页、导入与关联编辑入口，以及 Cesium 图层面板的交互。管理页如何查看全部图层、选择摄像头上下文并操作显隐？导入进行中、保存失败、地图加载失败与空列表如何呈现？

点击“定位”后，怎样进入三维地图、选择关联摄像头并定位到图层范围？当前摄像头未关联该图层、图层隐藏或没有可定位几何时怎样处理？现有 Viewer 会随切页重建，跟随观察会随 PTZ 更新重新定位；原型需明确定位时的跟随状态及显隐行为，避免返回地图后丢失操作结果。

原型只用于确认操作布局与行为，不连接真实设备，也不进行浏览器调试。通过人工反馈明确交互后，再形成实施规格与对应验证范围。

## Scope resolution

用户已切换为 implement-spec 实施流程，页面操作直接按[规格](../spec.md#管理页与地图)实现，不另行开展原型票；不将本票标为原型已获人工验收。
