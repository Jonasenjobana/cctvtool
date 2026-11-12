/** 只在解码出新帧时请求 Cesium 绘制；取消后不再调度下一帧。 */
export function startVideoFrameLoop(video: HTMLVideoElement, requestRender: () => void): () => void {
  let stopped = false;
  let handle = 0;
  if (typeof video.requestVideoFrameCallback === 'function') {
    const next = () => {
      if (stopped) return;
      requestRender();
      if (!stopped) handle = video.requestVideoFrameCallback(next);
    };
    handle = video.requestVideoFrameCallback(next);
    return () => { stopped = true; video.cancelVideoFrameCallback(handle); };
  }
  let previousTime = -1;
  const next = () => {
    if (stopped) return;
    if (video.readyState >= 2 && video.currentTime !== previousTime) {
      previousTime = video.currentTime;
      requestRender();
    }
    if (!stopped) handle = requestAnimationFrame(next);
  };
  handle = requestAnimationFrame(next);
  return () => { stopped = true; cancelAnimationFrame(handle); };
}
