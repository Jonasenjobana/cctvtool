# 修复已拍满任务的停止与完成恢复

Type: task
Status: open
Assignee: unassigned
Blocked by: 05
Spec: [海天线保持自动截图实现规格](../spec.md)

## Question

修复 Spec 审查发现的 P2：最后一张已保存后 stop 失败，或完成状态保存前异常重启，任务会保留 failed/interrupted 与 completedCount=sampleCount；当前继续入口和界面阻止恢复，completed 来源门禁导致预扫无法进入正式扫描。

允许这些可恢复状态通过既有 start 动作仅重新执行停止与完成收尾；不得补拍、重复精确定位或放宽正式阶段的 completed 门禁。设备仍被占用时保留现有先停止要求，收尾成功后按既有逻辑自动关联识别。界面使用“确认停止并完成”说明动作，并同步相关文档。

在用户已确认的公开后端 API 边界以 TDD 覆盖：拍满后 stop 失败→手动 stop 成功→收尾→识别→可正式扫描；拍满后异常重启→收尾，不补拍或重复定位。先处理失败测试，再实现。该票集中解决本轮唯一审查发现。
