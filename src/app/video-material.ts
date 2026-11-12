import { Material } from 'cesium';
import type { Cartesian2 } from 'cesium';

const videoShader = `
czm_material czm_getMaterial(czm_materialInput inputData) {
  vec2 uv = (inputData.st - 0.5) * uvScale + 0.5;
  czm_material material = czm_getDefaultMaterial(inputData);
  material.diffuse = texture(videoImage, uv).rgb;
  material.alpha = opacity * step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  return material;
}`;

export function createVideoMaterial(source: HTMLVideoElement | HTMLImageElement, uvScale: Cartesian2, opacity: number): Material {
  // Fabric 会深拷贝配置，先用占位图声明 sampler，再赋媒体元素，避免克隆原生 DOM 元素。
  const material = new Material({ strict: true, translucent: true, fabric: {
    type: 'CctvLiveVideo', source: videoShader,
    uniforms: { videoImage: Material.DefaultImageId, uvScale, opacity },
  } });
  material.uniforms.videoImage = source;
  return material;
}
