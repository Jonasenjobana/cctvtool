import { blendPanoramaFrame, createPanoramaPlan } from './panorama-math';
import type { Snapshot } from './models';

export async function renderTaskPanorama(snapshots: Snapshot[], signal: AbortSignal, progress: (done: number, total: number) => void) {
  signal.throwIfAborted();
  const plan = createPanoramaPlan(snapshots);
  const output = new Uint8ClampedArray(plan.width * plan.height * 4);
  const weights = new Float32Array(plan.width * plan.height);
  const sourceCanvas = document.createElement('canvas');
  const canvas = document.createElement('canvas');
  try {
    const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true });
    if (!sourceContext) throw new Error('浏览器无法读取截图像素');
    for (let index = 0; index < plan.frames.length; index++) {
      signal.throwIfAborted();
      const frame = plan.frames[index];
      const response = await fetch(frame.snapshot.imageUrl, { signal });
      if (!response.ok) throw new Error(`第 ${index + 1} 张截图读取失败（HTTP ${response.status}），请刷新任务后重试`);
      const image = await createImageBitmap(await response.blob());
      try {
        signal.throwIfAborted();
        if (image.width !== frame.snapshot.width || image.height !== frame.snapshot.height) throw new Error('截图尺寸与记录不一致，无法生成全景图');
        const scale = Math.min(1, plan.scale / frame.density);
        sourceCanvas.width = Math.max(1, Math.ceil(image.width * scale));
        sourceCanvas.height = Math.max(1, Math.ceil(image.height * scale));
        sourceContext.drawImage(image, 0, 0, sourceCanvas.width, sourceCanvas.height);
        const pixels = sourceContext.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
        blendPanoramaFrame(plan, frame, pixels, output, weights);
      } finally { image.close(); }
      progress(index + 1, plan.frames.length);
      await new Promise((accept) => setTimeout(accept, 0));
    }
    signal.throwIfAborted();
    canvas.width = plan.width;
    canvas.height = plan.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器无法生成全景图');
    context.putImageData(new ImageData(output, plan.width, plan.height), 0, 0);
    const blob = await new Promise<Blob>((accept, reject) => canvas.toBlob(
      (result) => result ? accept(result) : reject(new Error('全景图片编码失败，请缩小截图范围后重试')), 'image/png'));
    signal.throwIfAborted();
    return { blob, width: plan.width, height: plan.height, count: snapshots.length };
  } finally {
    sourceCanvas.width = sourceCanvas.height = 0;
    canvas.width = canvas.height = 0;
  }
}
