# 天津船闸 AIS 上游契约研究

研究日期：2026-11-13。范围为用户样例、指定 WebSocket 的一次有限只读观察、本地来源实现与官方 AIS 资料；本轮不实现业务功能。

## 结论

- **已确认**：样例是 `api/datas` JSON，船舶字段已经具有业务数据形状；同一 WebSocket 实际出现 `api=0/1/2`，不能把所有消息都当成 AIS 列表。
- **已确认于本地来源代码**：`api=0` 是雷达批次，`api=1` 是 AIS／融合数据批次，`api=2` 是设备状态；连接建立另有初始查询。`api=0` 不能据此解释为删除，后续 `api=1` 不能逐帧全量替换。
- **有来源依据但运行契约仍待确认**：本地 AIS 解码链输出经纬度的十进制度、以节表示的 SOG、以度表示的 COG/heading、以米表示的长宽；不得再对这个 JSON 统一执行原始 AIS 位字段的缩放。
- **未确认**：本地源码与 `4323` 运行服务的版本同一性、全部输入路径的单位和位置参考点、`date` 的实际时区及时间来源、线上删除和过期策略、完整初始同步与心跳契约。
- **用户已选建模假设**：缺少实测 ABCD 时，默认天线位于中心线、距船尾 `0.1L`，即 `A=0.9L`、`B=0.1L`、`C=D=0.5W`，允许后端按数据源覆盖。绘制中心从报告点沿有效船艏向前移 `0.4L`；这是估算，不能宣称实际天线位置或现场精度已确认。

## 一次观察与样例事实

用户附件 `已粘贴的文本.txt` 可直接解析为 JSON：`api=1`，`datas` 为 49 条记录；49 个 `mmsi` 均为九位字符串且互不相同。`lng/lat/speed/cog/heading/shipLength/shipWidth` 均为数值，`date` 均为无偏移的 `yyyy-MM-dd HH:mm:ss` 字符串。15 条 `heading=511`、3 条 `heading=456`，1 条 `cog=360`，12 条长宽同时为 0；没有 ABCD 字段。`speed` 有小数，只能由样例证明形状，不能单凭数值大小证明单位。原始目标、MMSI、船名与报文不写入仓库。

只读连接地址为用户指定的 `ws://192.168.1.20:4323/websocket`。2026-11-13 16:37:15.170（UTC+08:00）开始，Node `v22.22.3` 内置 WebSocket 自动完成标准握手；没有发送应用消息，没有重连。上限为 29.5 秒或 5 条数据消息，实际在 3.853 秒收到第 5 条后主动结束，握手耗时约 62 毫秒。

| 次序 | 建连起计 | 类型 | api | datas 条数 | 最小证据 |
| --- | --- | --- | --- | --- | --- |
| 1 | 222 ms | 文本 JSON | 1 | 876 | 船舶字段，与样例主要字段一致 |
| 2 | 2792 ms | 文本 JSON | 1 | 47 | 船舶字段 |
| 3 | 2805 ms | 文本 JSON | 0 | 9 | 船舶字段，单凭外形无法判断含义 |
| 4 | 2812 ms | 文本 JSON | 1 | 36 | 船舶字段 |
| 5 | 3853 ms | 文本 JSON | 2 | 2 | 电压、电流、温湿度、能见度等设备字段 |

这里计数的是 WebSocket API 暴露的数据消息，没有抓包核对底层分片或 PING/PONG 控制帧。5 条消息中没有空列表或可识别的应用心跳。初始大集合后接小集合与初始同步加批次更新相符，**仅凭本次观察仍不能证明全量、增量或删除语义**。

## 来源实现证据及适用范围

定向核对的是 `G:\Work\seaoil` 的后端 Kotlin／Java 源码，不是客户端对协议的猜测。尚未证明该工作副本就是当前运行服务的构建版本，下列事实仅对读到的实现成立。

| 问题 | 来源实现与含义 |
| --- | --- |
| 封套和初始发送 | [Websocket.kt 30–40](G:/Work/seaoil/src/main/kotlin/com/shenlan/seaoil/auto/Websocket.kt:30) 定义 `api` 和任意类型的 `datas`，端点为 `/websocket`；[50–78](G:/Work/seaoil/src/main/kotlin/com/shenlan/seaoil/auto/Websocket.kt:50) 在 `onOpen` 查询 `fromType="1"` 并发送 `api=1`，随后发送设备状态 `2`、跟踪状态 `3` 和摄像头朝向 `4`。本次只观察到其中 `1/2`。 |
| 初始窗口 | [Radarposition.kt 405–414](G:/Work/seaoil/src/main/kotlin/com/shenlan/seaoil/auto/Radarposition.kt:405) 的实际 SQL 查询最近 `minutes` 分钟，默认 **60 分钟**，按时间倒序；不能用 `onOpen` 的“30秒”注释定义契约。查询未在此处做按 MMSI 分组，因此也不能由注释保证初始列表天然去重。 |
| api=0/1 | [RadarEvent.kt 40–74](G:/Work/seaoil/src/main/kotlin/com/shenlan/seaoil/event/RadarEvent.kt:40) 将事件中的雷达记录分组后以 `api=0` 推送，AIS／融合记录以 `api=1` 推送；二者都是本次事件的数据。`0` 是数据种类，不是删除操作。 |
| 后续 api=1 | [ChUtil.kt 433–501](G:/Work/seaoil/src/main/kotlin/com/shenlan/seaoil/util/ChUtil.kt:433) 对本次解析位置按 MMSI 保留一条，再推送该批 `insertList2`。这一路支持按 MMSI 合并批次的解释，不支持每批清空未出现的目标。 |
| api=2 和心跳 | [RadarTask.kt 211–219](G:/Work/seaoil/src/main/kotlin/com/shenlan/seaoil/task/RadarTask.kt:211) 每 60 秒推送设备及气象状态；这是业务状态更新，不能自动认定为连接心跳。[Websocket.kt 96–118](G:/Work/seaoil/src/main/kotlin/com/shenlan/seaoil/auto/Websocket.kt:96) 的应用消息处理体没有启用的业务逻辑，不能据此推断传输层心跳不存在。 |
| 空批与删除 | `RadarEvent` 的两个发送调用没有先排除空列表，故所读实现可能产生空批；这些路径没有把空批定义为清空或删除。未观察到空批或删除，线上删除、离场及过期规则仍待确认。 |

## 最小业务字段能转换到什么程度

按用户要求，统一 AIS 业务只保留 `mmsi`、时间、经纬度、船艏向、长、宽、速度。下表是接入方案的证据边界，不代表本工具已经实现该模型。

| 上游字段 | 可用依据 | 仍需明确的边界 |
| --- | --- | --- |
| `mmsi` | 样例为字符串；本地 AIS 路径将 `userId` 转为字符串，不需要船名或 `id` 组成身份。 | 跨源相同 MMSI 的隔离由数据源上下文处理；样例没有证明所有输入均为合法船舶身份。 |
| `date` → 时间 | [ChUtil.kt 164、447、466](G:/Work/seaoil/src/main/kotlin/com/shenlan/seaoil/util/ChUtil.kt:164) 沿用 `rawData.date` 并格式化；[Util.kt 177–183](G:/Work/seaoil/src/main/kotlin/com/shenlan/seaoil/util/Util.kt:177) 的格式没有时区偏移。 | [ChUtil.kt 34–38](G:/Work/seaoil/src/main/kotlin/com/shenlan/seaoil/util/ChUtil.kt:34) 的一个入口使用处理时的 `Date()`，不能统一称为船端发射时刻。线上 JVM、数据库及输入时间的时区未确认，不能直接追加 `Z` 或按浏览器本地时区解析。 |
| `lng/lat` → 经／纬度 | [AisPosition.java 104–114](G:/Work/seaoil/src/main/java/dk/dma/ais/message/AisPosition.java:104) 已将原始分辨率换为度；[ChUtil.kt 161–184](G:/Work/seaoil/src/main/kotlin/com/shenlan/seaoil/util/ChUtil.kt:161) 使用该结果。原始 AIS 按 WGS84 传送位置，见 [ITU-R M.1371-6 §A7-3](https://www.itu.int/dms_pubrec/itu-r/rec/m/R-REC-M.1371-6-202602-I%21%21PDF-E.pdf)。 | 这是已读原始 AIS 路径的依据，尚未证明运行服务每条输入都未做其他坐标转换或位置归中。 |
| `heading` → 船艏向 | 同一解码路径原样传递 `trueHeading`；在标准语义下是相对真北的船艏方向，合法 0–359°，不能与 COG 混用。 | 511 是不可用，456 属于标准禁用范围，应按无效方向处理，不能取模成角度；0°本身合法。另一路 [Radarposition.kt 37–38、91–108](G:/Work/seaoil/src/main/kotlin/com/shenlan/seaoil/auto/Radarposition.kt:37) 默认 `heading=0`，融合记录构造时没有赋值，因此仅凭 0 无法区分实际北向与上游默认值。 |
| `shipLength/shipWidth` → 长／宽 | [ChUtil.kt 223–239](G:/Work/seaoil/src/main/kotlin/com/shenlan/seaoil/util/ChUtil.kt:223) 分别求 `dimBow+dimStern` 和 `dimPort+dimStarboard`；AIS 这些距离单位为米。[Util.kt 644–651](G:/Work/seaoil/src/main/kotlin/com/shenlan/seaoil/util/Util.kt:644) 将缺失静态长宽补为 0。 | 12 条全零应视为没有可用船体尺寸的证据，不能绘制零尺寸船体。其他路径是否同单位、如何展示缺失尺寸仍需策略决定。 |
| `speed` → 速度 | 原始 AIS SOG 单位为 0.1 节；[ChUtil.kt 161–182](G:/Work/seaoil/src/main/kotlin/com/shenlan/seaoil/util/ChUtil.kt:161) 已除以 10，再由 [441、474](G:/Work/seaoil/src/main/kotlin/com/shenlan/seaoil/util/ChUtil.kt:441) 传到 JSON。此路径 JSON 已为节。 | 不能再除以 10。融合入口 [Radaraisdata.kt 27–34](G:/Work/seaoil/src/main/kotlin/com/shenlan/seaoil/auto/Radaraisdata.kt:27) 也做一次 `×0.1`，但还需确认其输入契约。`speed=0` 可能真实静止，也可能来自缺失值默认，不能统一当作缺失。 |

## 官方 AIS 语义与 JSON 的区别

[USCG NAVCEN 的 Class A 位置报告](https://www.navcen.uscg.gov/ais-class-a-reports)分开定义 SOG、COG、true heading 和时间戳；[USCG 检查表第 2–3 页](https://www.navcen.uscg.gov/sites/default/files/pdf/AIS/USCG_AIS_Inspection_Checklist19_10_01.pdf)也分别检查 EPFS 的 COG/SOG、陀螺船艏向和定位天线参考点。COG 是对地运动方向，靠泊时也可能波动；它不能在统一业务中悄悄改名为船艏向。

原始 AIS 的消息 1/2/3 中，SOG 以 0.1 节编码，1023 表示不可用；COG 以 0.1°编码，3600 表示不可用；经纬度按 1/10000 分编码；时间戳仅为 UTC 秒及特殊状态。这些规则描述无线报文，不自动等同于带完整日期和小数的业务 JSON。[USCG NAVCEN 位置字段表](https://www.navcen.uscg.gov/ais-class-a-reports)

本地代码恰好已经把 SOG/COG 除 10，所以原始 `COG=3600` 会沿该路径变成 JSON `cog=360`，原始不可用 SOG 也可能变成 `102.3`；适配时应按来源解码契约处理无效值，不把 360 取模成北向，也不只识别原始编码 3600/1023。[ChUtil.kt 161–182](G:/Work/seaoil/src/main/kotlin/com/shenlan/seaoil/util/ChUtil.kt:161)；[ITU-R M.1371-6 §A7-3.1，true heading 的 360–510 禁用、511 不可用](https://www.itu.int/dms_pubrec/itu-r/rec/m/R-REC-M.1371-6-202602-I%21%21PDF-E.pdf)

## ABCD、报告点与已选估算

官方定义中，A/B/C/D 分别是报告位置参考点至船艏／船艉／左舷／右舷的纵横距离，单位米；`L=A+B`，`W=C+D`。A 的正方向与传送的船艏向一致。报告位置参考点不必是船体中心：可以是定位天线位置，也可以是经过计算的公共参考点，且内外定位系统可以使用不同参考点。[ITU-R M.1371-6 §A7-3.3.3、图38](https://www.itu.int/dms_pubrec/itu-r/rec/m/R-REC-M.1371-6-202602-I%21%21PDF-E.pdf)；[IMO SN/Circ.227 §5.2–5.3，官方托管副本](https://www.navcen.uscg.gov/sites/default/files/pdf/marcomms/imo/Circulars/IMO.SN.Circ.227_AIS_Installation.pdf)

**以下是几何推导，不是对真实船舶的测量。** 以报告点为原点，船艏为纵向正方向、右舷为横向正方向，则长宽包围框／绘制模型中心相对报告点的偏移为：

```text
纵向前移 f = (A − B) / 2
横向右移 s = (D − C) / 2

默认：A = 0.9L，B = 0.1L，C = D = 0.5W
得到：f = 0.4L，s = 0
```

设船艏向 θ 从真北顺时针计，在报告点局部东、北坐标中，`ΔE=f·sinθ+s·cosθ`、`ΔN=f·cosθ−s·sinθ`。默认情况下，北向前移到北侧、东向前移到东侧，南向和西向相反；这核对了 `0.4L` 的方向与符号。经纬度上的实际应用应通过地理坐标／局部坐标转换，不能把米直接加到经纬度数值。这里的中心是模型长宽包围框中心，不是船舶重心或真实外轮廓的面积质心。

已选默认比例允许后端按数据源覆盖；ABCD 与中心偏移可以在展示几何边界派生，无需把估算 ABCD 扩展成统一 AIS 业务字段或改写上游报告经纬度。

用户已选普通船以点表示，仅为当前追踪船绘制带估算偏移的长方体。长宽不能提供船高；长方体所需模拟高度尚未选择，不能当作实测船高，也不因此增加统一业务字段。

边界仍需写入后续展示决策：缺少可用长宽时不能得到完整船体；缺少有效船艏向时不能可靠执行沿船艏的中心平移；用 COG 作为展示方向、追踪船缺少方向或尺寸时如何降级仍需另行选择，不能把推算结果写回 `heading`。如果上游已将报告点归到模型中心，再前移会重复补偿；实际参考点尚未核验，默认“靠船尾天线”必须持续标为建模假设。

## 仍需补齐的契约

1. 核对运行服务版本、全部消息类型和来源路径，确认本地实现的分类、单位、坐标基准及初始窗口是否适用于指定端点；再把有证据的批次合并规则写成接口契约。
2. 确认 `date` 的业务含义、来源时区、数据库／服务时区，以及乱序、同 MMSI 同时间多条和初始列表重复的处理方式；本次没有证明严格顺序或时间同步。
3. 明确离场／删除／过期策略、重连是否重建初始状态及同步完成标志、空批语义；不能把列表中暂未出现当作删除，也不能把初始窗口当作产品过期阈值。
4. 明确应用心跳或传输层保活要求，以及缺失船艏向、长宽、速度的展示策略。5 条消息的短观察不能验收长连接稳定性、异常恢复或现场位置精度。

验证范围：附件解析和脱敏聚合、一次上限内的只读 WebSocket 观察、定向源码检查及官方资料核对。未保存真实报文、目标清单、凭据或数据库；没有运行浏览器、操作云台或进行业务实现。
