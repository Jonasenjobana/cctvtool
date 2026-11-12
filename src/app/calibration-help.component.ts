import { ChangeDetectionStrategy, Component, ElementRef, Input, ViewChild, signal } from '@angular/core';
import type { AfterViewInit, OnDestroy } from '@angular/core';

type HelpTopic = 'p-axis' | 'tilt-offset' | 'image-roll';
const helpContent = {
  'p-axis': {
    title: 'P 轴安装倾斜',
    image: '/help/p-axis.png',
    alt: '现场悬挂式云台的侧视与正视手绘图，比较铅垂方向和实际 P 轴的前后倾、左右倾',
    description: '还原整根 P 旋转轴相对铅垂方向的安装倾斜。转动 P 时，底座的歪斜会影响不同朝向的俯仰和画面倾斜。',
  },
  'tilt-offset': {
    title: 'T 偏移：校准上下朝向',
    image: '/help/tilt-offset.png',
    alt: 'P 轴保持竖直，镜头名义视线与实际视线存在俯仰差值，海天线在画面中上下移动的手绘图',
    description: '补偿 T 读数与实际镜头俯仰之间的固定差值。正值上抬，主要用于对齐模型与实拍中海天线的上下位置。',
  },
  'image-roll': {
    title: '画面 Roll：校准画面歪斜',
    image: '/help/image-roll.png',
    alt: '镜头绕最终光轴的旋转与海天线斜率变化的手绘示意图，P 轴保持不变',
    description: '补偿绕最终光轴的固定旋转，主要用于对齐模型与实拍中海天线的斜率。镜头朝向保持不变，实拍视频不会被旋正。',
  },
} as const;

@Component({
  selector: 'app-calibration-help',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button #trigger type="button" class="help-trigger" [attr.aria-label]="'查看' + content.title + '说明'"
      [attr.aria-describedby]="popoverId" [attr.aria-expanded]="visible()"
      (mouseenter)="show()" (mouseleave)="scheduleHide()" (focus)="show()" (blur)="scheduleHide()" (click)="show()">?</button>
    <div #popover class="help-popover" popover="auto" role="tooltip" [id]="popoverId"
      (toggle)="onToggle()" (mouseenter)="cancelHide()" (mouseleave)="scheduleHide()">
      <strong>{{ content.title }}</strong>
      <img [src]="content.image" [alt]="content.alt" width="1536" height="1024" loading="lazy" (load)="position()">
      <p>{{ content.description }}</p>
      <small>仅校准三维模型，不会控制云台移动。</small>
    </div>
  `,
  styles: `
    :host{display:inline-flex;flex-shrink:0;vertical-align:middle}
    .help-trigger{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;padding:0;border:1px solid #9ba6b5;border-radius:50%;background:transparent;color:#7b8797;font:600 11px/1 sans-serif;cursor:help}
    .help-trigger:hover,.help-trigger:focus-visible{border-color:#3974d7;color:#3974d7;background:#f1f6ff}
    .help-trigger:focus-visible{outline:2px solid #b8cdf0;outline-offset:2px}
    .help-popover{position:fixed;inset:auto;margin:0;box-sizing:border-box;width:min(460px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:auto;padding:13px;border:1px solid #dce2e9;border-radius:4px;background:#fff;color:#4d5867;box-shadow:0 5px 22px #16283d24}
    .help-popover::backdrop{background:transparent;pointer-events:none}
    strong{display:block;font-size:13px;font-weight:600;line-height:1.5}
    img{display:block;width:100%;height:auto;aspect-ratio:3/2;object-fit:contain;margin-top:9px;background:#fcfaf6}
    p{margin:10px 0 7px;font-size:12px;line-height:1.8}small{display:block;color:#8c96a4;font-size:11px;line-height:1.6}
  `,
})
export class CalibrationHelpComponent implements AfterViewInit, OnDestroy {
  @Input({ required: true }) topic!: HelpTopic;
  @ViewChild('trigger', { static: true }) private trigger!: ElementRef<HTMLButtonElement>;
  @ViewChild('popover', { static: true }) private popover!: ElementRef<HTMLDivElement>;
  readonly visible = signal(false);
  private hideTimer?: ReturnType<typeof setTimeout>;
  private readonly onScroll = (event: Event) => {
    if (!this.popover.nativeElement.contains(event.target as Node)) this.hide();
  };
  private readonly onResize = () => this.hide();

  get content() { return helpContent[this.topic]; }
  get popoverId() { return `calibration-help-${this.topic}`; }

  ngAfterViewInit() {
    // 使用浏览器顶层浮层，避免图片被安装表单的滚动容器裁切。
    document.addEventListener('scroll', this.onScroll, true);
    window.addEventListener('resize', this.onResize);
  }

  show() {
    this.cancelHide();
    const popover = this.popover.nativeElement;
    if (!popover.matches(':popover-open')) popover.showPopover();
    this.visible.set(true);
    this.position();
  }

  position() {
    if (!this.visible()) return;
    const popover = this.popover.nativeElement;
    const trigger = this.trigger.nativeElement.getBoundingClientRect();
    const gap = 12;
    popover.style.left = `${Math.max(gap, trigger.left - popover.offsetWidth - gap)}px`;
    popover.style.top = `${Math.max(gap, Math.min(trigger.top - 36, window.innerHeight - popover.offsetHeight - gap))}px`;
  }

  cancelHide() { clearTimeout(this.hideTimer); }

  scheduleHide() {
    this.cancelHide();
    this.hideTimer = setTimeout(() => {
      if (!this.trigger.nativeElement.matches(':hover,:focus') && !this.popover.nativeElement.matches(':hover')) this.hide();
    }, 160);
  }

  onToggle() { this.visible.set(this.popover.nativeElement.matches(':popover-open')); }

  private hide() {
    this.cancelHide();
    if (this.popover.nativeElement.matches(':popover-open')) this.popover.nativeElement.hidePopover();
    this.visible.set(false);
  }

  ngOnDestroy() {
    this.cancelHide();
    document.removeEventListener('scroll', this.onScroll, true);
    window.removeEventListener('resize', this.onResize);
  }
}
