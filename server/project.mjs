// 各部署的项目身份、来源地址与适配规则集中在后端，前端不依赖供应商报文。
export const vesselProject = {
  id: 'tianjin-lock', name: '天津船闸',
  sources: [{
    id: 'tianjin-lock-ais', name: '天津船闸 AIS', adapter: 'seaoil-ais',
    url: 'ws://192.168.1.20:4323/websocket', timeOffsetMinutes: 480,
    expireAfterMs: 10 * 60 * 1000,
    geometry: { antennaFromSternRatio: 0.1, antennaFromPortRatio: 0.5, heightMeters: 10 },
  }, {
    id: 'dagu-ais', name: '大沽 AIS', adapter: 'seaoil-ais',
    url: 'ws://192.168.1.21:5345/websocket', timeOffsetMinutes: 480,
    expireAfterMs: 10 * 60 * 1000,
    geometry: { antennaFromSternRatio: 0.1, antennaFromPortRatio: 0.5, heightMeters: 10 },
  }],
};
