import type flvjs from 'flv.js';

type FlvLibrary = Pick<typeof flvjs, 'isSupported' | 'createPlayer' | 'Events'>;
type PlaybackChanged = (video: HTMLVideoElement | null, error: string) => void;

/** 解码器持有唯一的媒体连接，Cesium 直接使用这个 video，不再单独拉流。 */
export class WsFlvPlayer {
  private readonly video: HTMLVideoElement;
  private readonly flv: FlvLibrary;
  private readonly changed: PlaybackChanged;
  private player?: flvjs.Player;
  private disposed = false;
  private url = '';
  private readonly onPlaying = () => {
    if (this.player && !this.disposed) this.changed(this.video, '');
  };
  private readonly onVideoError = () => {
    if (this.player) this.fail(this.player, this.video.error?.message || '浏览器视频解码失败');
  };

  constructor(video: HTMLVideoElement, flv: FlvLibrary, changed: PlaybackChanged) {
    this.video = video;
    this.flv = flv;
    this.changed = changed;
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.addEventListener('playing', this.onPlaying);
    video.addEventListener('error', this.onVideoError);
  }

  setUrl(url: string) {
    if (url === this.url || this.disposed) return;
    this.url = url;
    this.retry();
  }

  retry() {
    if (this.disposed) return;
    this.stop();
    if (!this.url) return;
    if (!/^wss?:\/\//i.test(this.url)) {
      this.changed(null, '直播地址必须使用 WS 或 WSS');
      return;
    }
    if (!this.flv.isSupported()) {
      this.changed(null, '当前浏览器不支持 FLV / MediaSource 播放');
      return;
    }
    try {
      const player = this.flv.createPlayer({ type: 'flv', isLive: true, url: this.url }, {
        enableStashBuffer: false, autoCleanupSourceBuffer: true,
      });
      this.player = player;
      player.on(this.flv.Events.ERROR, (type: string, detail: string) => {
        this.fail(player, `直播流错误：${type} / ${detail}`);
      });
      player.attachMediaElement(this.video);
      player.load();
      if (this.player !== player) return;
      const playing = player.play();
      if (playing) void playing.catch((error: unknown) => {
        this.fail(player, `播放未开始：${error instanceof Error ? error.message : String(error)}，请点击重新连接`);
      });
    } catch (error) {
      this.stop();
      this.changed(null, `直播加载失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private fail(player: flvjs.Player, message: string) {
    if (this.player !== player || this.disposed) return;
    this.stop();
    this.changed(null, message);
  }

  private stop() {
    const player = this.player;
    this.player = undefined;
    // 先撤掉纹理引用，再释放 MediaSource 和 WebSocket。
    this.changed(null, '');
    if (player) {
      try { player.destroy(); } catch (error) { console.error('释放 FLV 播放器失败', error); }
    }
    this.video.removeAttribute('src');
    this.video.load();
  }

  destroy() {
    if (this.disposed) return;
    this.disposed = true;
    this.video.removeEventListener('playing', this.onPlaying);
    this.video.removeEventListener('error', this.onVideoError);
    this.stop();
  }
}
