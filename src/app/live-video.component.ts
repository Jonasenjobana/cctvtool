import {
  ChangeDetectionStrategy, Component, ElementRef, EventEmitter, Input, NgZone, Output, ViewChild, inject, signal,
} from '@angular/core';
import type { AfterViewInit, OnChanges, OnDestroy, SimpleChanges } from '@angular/core';
import flvjs from 'flv.js';
import { IconComponent } from './icon.component';
import type { PlaybackSource } from './models';
import { WsFlvPlayer } from './ws-flv-player';

@Component({
  selector: 'app-live-video',
  standalone: true,
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <video #video class="decoder-video" muted autoplay playsinline aria-hidden="true"></video>
    <div class="playback-status" [title]="source.serial + ' / ' + source.code">
      <app-icon name="video" />
      <span><strong>直播融合</strong><small [class.failed]="!!problem()" role="status">{{ problem() || (playing() ? warning || '直播中' : '正在连接…') }}</small></span>
      <button type="button" title="重新连接" aria-label="重新连接视频" (click)="retry()"><app-icon name="refresh" /></button>
      <button type="button" title="关闭直播融合" aria-label="关闭直播融合" (click)="closed.emit()"><app-icon name="close" /></button>
    </div>
    <label class="opacity-control">视频不透明度 <input type="range" min="0" max="1" step="0.05" [value]="opacity" aria-label="视频不透明度" (input)="changeOpacity($event)"><span>{{ (opacity * 100).toFixed(0) }}%</span></label>
  `,
  styles: `
    :host{display:block;position:relative;background:#fff;border:1px solid #e0e5ed;border-radius:4px;overflow:hidden}
    .decoder-video{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
    .playback-status{display:flex;align-items:center;gap:9px;padding:9px 10px;color:#6f7989}
    .playback-status>span{flex:1;min-width:0}strong{display:block;font-size:11px;color:#4c5766;font-weight:500}
    small{display:block;font-size:10px;line-height:1.6;margin-top:3px;overflow-wrap:anywhere}.failed{color:#b65345}
    button{width:28px;height:28px;border-radius:3px;padding:0}button:hover{background:#f1f4f8}
    app-icon{width:15px;height:15px}.opacity-control{display:flex;align-items:center;gap:9px;padding:0 12px 11px;font-size:10px;color:#7f8998}
    input{flex:1;min-width:0;accent-color:#3475da}.opacity-control>span{width:28px;text-align:right}
  `,
})
export class LiveVideoComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input({ required: true }) source!: PlaybackSource;
  @Input() opacity = 1;
  @Input() warning = '';
  @Output() readonly ready = new EventEmitter<HTMLVideoElement | null>();
  @Output() readonly opacityChange = new EventEmitter<number>();
  @Output() readonly closed = new EventEmitter<void>();
  @ViewChild('video', { static: true }) private video!: ElementRef<HTMLVideoElement>;
  readonly playing = signal(false);
  readonly problem = signal('');
  private readonly zone = inject(NgZone);
  private decoder?: WsFlvPlayer;

  ngAfterViewInit() {
    this.zone.runOutsideAngular(() => {
      this.decoder = new WsFlvPlayer(this.video.nativeElement, flvjs, (video, error) => {
        this.zone.run(() => {
          this.playing.set(!!video);
          this.problem.set(error);
          this.ready.emit(video);
        });
      });
      this.decoder.setUrl(this.source.url);
    });
  }

  ngOnChanges(changes: SimpleChanges) {
    const source = changes['source'];
    if (!source) return;
    this.zone.runOutsideAngular(() => {
      // 快速切回同一地址时视图可能合并更新，重连以重新交付已被父组件清空的视频引用。
      if (source.previousValue?.url === this.source.url) this.decoder?.retry();
      else this.decoder?.setUrl(this.source.url);
    });
  }

  retry() { this.zone.runOutsideAngular(() => this.decoder?.retry()); }

  changeOpacity(event: Event) { this.opacityChange.emit(Number((event.target as HTMLInputElement).value)); }

  ngOnDestroy() { this.decoder?.destroy(); }
}
