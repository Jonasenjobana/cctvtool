import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, EventEmitter, HostListener, Input, Output, signal } from '@angular/core';
import type { Snapshot } from './models';

@Component({
  selector: 'app-snapshot-item',
  standalone: true,
  imports: [DatePipe, DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button type="button" class="snapshot-row" [class.current]="current" [disabled]="disabled"
      title="点击查看，右键删除截图" (click)="opened.emit(snapshot)" (contextmenu)="openMenu($event)">
      <img [src]="snapshot.imageUrl" alt="摄像头快照" loading="lazy">
      <span>{{ snapshot.createdAt | date:'MM-dd HH:mm:ss' }}</span>
      <small>P {{ snapshot.ptz.raw.Pan | number:'1.1-2' }} · T {{ snapshot.ptz.raw.Tilt | number:'1.1-2' }} · Z {{ snapshot.ptz.raw.Zoom | number:'1.1-2' }}</small>
      @if (snapshot.poseChanged) { <em>采样期间姿态变化</em> }
    </button>
    @if (menuOpen()) {
      <div class="snapshot-menu" role="menu" aria-label="截图操作">
        <button type="button" role="menuitem" [disabled]="disabled || deleteDisabled" (click)="menuOpen.set(false); removed.emit(snapshot)">删除截图</button>
      </div>
    }
  `,
  styles: `
    :host{display:block;position:relative;min-width:0}.snapshot-row{display:flex;flex-direction:column;align-items:flex-start;width:100%;gap:7px;padding:12px 0;border-bottom:1px solid #edf0f3;text-align:left}
    img{width:100%;aspect-ratio:16/9;object-fit:contain;background:#eef0f3;border:1px solid #e4e8ee}
    .snapshot-row>span{font-size:12px;color:#424d5f}small{font-size:11px;color:#8b94a1;font-variant-numeric:tabular-nums}
    em{font-style:normal;color:#a56d28;font-size:11px}.snapshot-row:hover>span,.snapshot-row.current>span{color:#3475da}
    .snapshot-menu{position:absolute;right:5px;top:18px;z-index:2;background:#fff;border:1px solid #e1e5eb;box-shadow:0 2px 8px #172b4520;padding:4px;border-radius:3px}
    .snapshot-menu button{padding:8px 16px;font-size:12px;color:#ad493d}.snapshot-menu button:hover{background:#fff3f0}
  `,
})
export class SnapshotItemComponent {
  @Input({ required: true }) snapshot!: Snapshot;
  @Input() current = false;
  @Input() disabled = false;
  @Input() deleteDisabled = false;
  @Output() readonly opened = new EventEmitter<Snapshot>();
  @Output() readonly removed = new EventEmitter<Snapshot>();
  readonly menuOpen = signal(false);

  openMenu(event: MouseEvent) {
    event.preventDefault();
    if (!this.disabled && !this.deleteDisabled) this.menuOpen.set(true);
  }

  @HostListener('document:click')
  @HostListener('document:keydown.escape')
  closeMenu() { this.menuOpen.set(false); }
}
