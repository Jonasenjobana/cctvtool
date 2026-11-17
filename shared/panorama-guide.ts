/** 全景参考线使用展开方位和圆柱高度，独立于画布尺寸及正式标注。 */
export interface PanoramaGuidePoint {
  heading: number;
  elevation: number;
}

export type PanoramaGuide =
  | { kind: 'line'; points: [PanoramaGuidePoint, PanoramaGuidePoint] }
  | { kind: 'quadratic'; points: [PanoramaGuidePoint, PanoramaGuidePoint, PanoramaGuidePoint] };

export interface PanoramaGuideState {
  guide: PanoramaGuide | null;
  revision: number;
}
