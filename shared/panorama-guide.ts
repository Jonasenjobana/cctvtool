/** 全景参考线使用展开方位和圆柱高度，独立于画布尺寸及正式标注。 */
export interface PanoramaGuidePoint {
  heading: number;
  elevation: number;
}

export type PanoramaGuide =
  | { kind: 'line'; points: [PanoramaGuidePoint, PanoramaGuidePoint] }
  | { kind: 'quadratic'; points: [PanoramaGuidePoint, PanoramaGuidePoint, PanoramaGuidePoint] }
  // 分段二次贝塞尔按起点、控制点、连接节点、控制点、终点交替排列。
  | { kind: 'bezier'; points: PanoramaGuidePoint[] };

export interface PanoramaGuideState {
  guide: PanoramaGuide | null;
  revision: number;
}
