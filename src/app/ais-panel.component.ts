import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AisState } from './ais-state.service';
import { vesselGeometry } from './ais-math';
import { IconComponent } from './icon.component';

@Component({
  selector: 'app-ais-panel', standalone: true,
  imports: [FormsModule, DatePipe, DecimalPipe, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './ais-panel.component.html', styleUrl: './ais-panel.component.css',
})
export class AisPanelComponent {
  readonly ais = inject(AisState);
  @Input() canTrack = false;
  @Input() busy = false;
  @Input() operationError = '';
  @Input() operationMessage = '';
  @Output() readonly tracked = new EventEmitter<string>();
  @Output() readonly closed = new EventEmitter<void>();
  readonly search = signal('');
  readonly lookupError = signal('');
  readonly statusText = computed(() => ({ idle: '未订阅', connecting: '正在连接', connected: '已连接', reconnecting: '正在重连' })[this.ais.status()]);
  readonly geometry = computed(() => {
    const target = this.ais.selectedTarget(), source = this.ais.selectedSource();
    return target && source ? vesselGeometry(target, source.geometry) : null;
  });

  find() {
    const mmsi = this.search().trim();
    if (!this.ais.targets().some(target => target.mmsi === mmsi)) { this.lookupError.set('未找到该 MMSI 的有效目标'); return; }
    this.lookupError.set('');
    this.ais.selectTarget(mmsi);
  }
}
