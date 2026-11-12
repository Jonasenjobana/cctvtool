import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cartesian2 } from 'cesium';
import { createVideoMaterial } from '../src/app/video-material.ts';

test('Cesium 画面材质保留视频及历史截图的原始引用，不克隆或串用 DOM 元素', () => {
  class NativeVideo { constructor() { throw new Error('Illegal constructor'); } }
  class NativeImage { constructor() { throw new Error('Illegal constructor'); } }
  const browserTypes = {
    HTMLVideoElement: NativeVideo, HTMLCanvasElement: class {}, HTMLImageElement: NativeImage,
    ImageBitmap: class {}, OffscreenCanvas: class {},
  };
  const descriptors = new Map(Object.keys(browserTypes).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.assign(globalThis, browserTypes);
  try {
    const firstVideo = Object.create(NativeVideo.prototype) as HTMLVideoElement;
    const nextVideo = Object.create(NativeVideo.prototype) as HTMLVideoElement;
    const snapshotImage = Object.create(NativeImage.prototype) as HTMLImageElement;
    const first = createVideoMaterial(firstVideo, new Cartesian2(1, 1), 0.8);
    const next = createVideoMaterial(nextVideo, new Cartesian2(2, 1), 1);
    const snapshot = createVideoMaterial(snapshotImage, new Cartesian2(1, 1.5), 0.5);
    assert.equal(first.uniforms.videoImage, firstVideo);
    assert.equal(next.uniforms.videoImage, nextVideo);
    assert.equal(snapshot.uniforms.videoImage, snapshotImage);
    assert.equal(snapshot.uniforms.opacity, 0.5);
    assert.equal(snapshot.uniforms.uvScale.y, 1.5);
    assert.equal(first.uniforms.opacity, 0.8);
    assert.equal(next.uniforms.uvScale.x, 2);
    assert.match(first.shaderSource, /sampler2D/);
    first.destroy();
    next.destroy();
    snapshot.destroy();
  } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
