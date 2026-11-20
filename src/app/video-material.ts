import { Material } from 'cesium';
import * as Cesium from 'cesium';
import type { Cartesian2 } from 'cesium';

interface PixelTexture {
  copyFrom(options: { source: HTMLCanvasElement }): void;
  isDestroyed(): boolean;
  destroy(): void;
}

// Cesium 材质更新时才提供 WebGL 上下文，复用像素遮罩纹理以避免反复分配。
const Texture = (Cesium as unknown as {
  Texture: new (options: { context: object; source: HTMLCanvasElement }) => PixelTexture;
}).Texture;
const MaterialWithUpdate = Material as unknown as new (options: ConstructorParameters<typeof Material>[0]) =>
  Material & { update(context: object): void };

const videoShader = `
czm_material czm_getMaterial(czm_materialInput inputData) {
  vec2 uv = (inputData.st - 0.5) * uvScale + 0.5;
  czm_material material = czm_getDefaultMaterial(inputData);
  material.diffuse = texture(videoImage, uv).rgb;
  if (hasAisPixels) {
    material.diffuse = mix(material.diffuse, vec3(0.0, 1.0, 0.0), texture(aisPixels, uv).a);
  }
  material.alpha = opacity * step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  return material;
}`;

class VideoMaterial extends MaterialWithUpdate {
  private pendingPixels?: { points: readonly Cartesian2[]; width: number; height: number; radius: number };
  private drawing?: CanvasRenderingContext2D;
  private pixelTexture?: PixelTexture;

  constructor(source: HTMLVideoElement | HTMLImageElement, uvScale: Cartesian2, opacity: number) {
    // 先用占位图声明 sampler，避免 Fabric 克隆原生媒体元素。
    super({ strict: true, translucent: true, fabric: {
      type: 'CctvLiveVideo', source: videoShader,
      uniforms: { videoImage: Material.DefaultImageId, aisPixels: Material.DefaultImageId, hasAisPixels: false, uvScale, opacity },
    } });
    this.uniforms.videoImage = source;
  }

  setAisPixels(points: readonly Cartesian2[], width: number, height: number, radius: number) {
    this.pendingPixels = points.length ? { points, width, height, radius } : undefined;
    this.uniforms.hasAisPixels = false;
  }

  override update(context: object) {
    if (this.pendingPixels) {
      const { points, width, height, radius } = this.pendingPixels;
      if (!this.drawing) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        this.drawing = canvas.getContext('2d') ?? undefined;
        if (!this.drawing) throw new Error('无法创建 AIS 视频像素遮罩');
      }
      const drawing = this.drawing;
      drawing.clearRect(0, 0, width, height);
      drawing.fillStyle = '#fff';
      for (const { x, y } of points) {
        drawing.beginPath();
        drawing.arc(x, y, radius, 0, 2 * Math.PI);
        drawing.fill();
      }
      if (this.pixelTexture) this.pixelTexture.copyFrom({ source: drawing.canvas });
      else this.uniforms.aisPixels = this.pixelTexture = new Texture({ context, source: drawing.canvas });
      this.uniforms.hasAisPixels = true;
      this.pendingPixels = undefined;
    }
    super.update(context);
  }

  override destroy() {
    const texture = this.pixelTexture;
    super.destroy();
    // 视频纹理更新若先失败，材质可能还未接管刚创建的 AIS 遮罩。
    if (texture && !texture.isDestroyed()) texture.destroy();
  }
}

export function createVideoMaterial(source: HTMLVideoElement | HTMLImageElement, uvScale: Cartesian2, opacity: number) {
  return new VideoMaterial(source, uvScale, opacity);
}
