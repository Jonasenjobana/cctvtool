# 首轮受控验证怎样分开倍率与姿态变化

Type: grilling
Labels: wayfinder:grilling
Status: open
Assignee: unassigned
Parent: [海天线变倍与转向垂直偏差排查](../map.md)
Blocked by: 01

## Question

根据[现有证据能否区分变倍与转向的垂直偏差](01-evidence-and-observability.md)的证据清单，与用户确定第一轮可执行对照：固定 P/T 仅改变倍率并返回 8 倍，以及固定倍率改变 P/T 后返回原状态。若海天线在固定 T 的高倍画面中移出视野，应如何保留这一事实，避免重新调 T 后又把两个变量混在一起？

确定摄像头与可用倍率、P/T 方向覆盖、停稳条件、原图和 PTZ/FOV 记录方式，以及能接受的高倍垂直误差。判据应同时考虑有符号的中心垂直偏差、海天线斜率、归一化偏差和角度残差，不以肉眼吻合或低倍 5 像素 RMS 代替高倍验收。
