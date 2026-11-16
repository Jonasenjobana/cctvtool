import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AisState } from './ais-state.service';
import { vesselBodyDimensions, vesselGeometry } from './ais-math';
import type { VesselBodyDimensions } from './ais.models';
import { IconComponent } from './icon.component';
import { CalibrationHelpComponent } from './calibration-help.component';

type BodyDraft = { [K in keyof VesselBodyDimensions]: number | null };

@Component({
  selector: 'app-ais-panel', standalone: true,
  imports: [FormsModule, DatePipe, DecimalPipe, IconComponent, CalibrationHelpComponent],
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
  readonly bodyDraft = signal<BodyDraft | null>(null);
  readonly bodyError = signal('');
  readonly bodyFields = [
    { key: 'a', label: 'A 至船艏（m）' }, { key: 'b', label: 'B 至船艉（m）' },
    { key: 'c', label: 'C 至左舷（m）' }, { key: 'd', label: 'D 至右舷（m）' },
    { key: 'height', label: '船高（m）' },
  ] as const;
  readonly statusText = computed(() => ({ idle: '未订阅', connecting: '正在连接', connected: '已连接', reconnecting: '正在重连', error: '连接失败' })[this.ais.status()]);
  readonly geometry = computed(() => {
    const target = this.ais.selectedTarget(), source = this.ais.selectedSource();
    return target && source ? vesselGeometry(target, source.geometry, this.ais.selectedBodyOverride() ?? undefined) : null;
  });
  readonly bodyValues = computed<BodyDraft>(() => {
    if (this.bodyDraft()) return this.bodyDraft()!;
    const ship = this.ais.selectedTarget(), source = this.ais.selectedSource();
    return this.ais.selectedBodyOverride() ?? (ship && source ? vesselBodyDimensions(ship, source.geometry) : null)
      ?? { a: null, b: null, c: null, d: null, height: source?.geometry.heightMeters ?? null };
  });

  constructor() {
    effect(() => {
      this.ais.selectedId();
      this.ais.selectedMmsi();
      this.bodyDraft.set(null);
      this.bodyError.set('');
    });
  }

  editBody(field: keyof VesselBodyDimensions, value: number | null) {
    this.bodyDraft.set({ ...this.bodyValues(), [field]: value });
    this.bodyError.set('');
  }

  applyBody() {
    const { a, b, c, d, height } = this.bodyValues();
    if (a === null || b === null || c === null || d === null || height === null) {
      this.bodyError.set('请完整填写 ABCD 和船高');
      return;
    }
    try {
      this.ais.setBodyDimensions(this.ais.selectedMmsi(), { a, b, c, d, height });
      this.bodyDraft.set(null);
      this.bodyError.set('');
    } catch (error) { this.bodyError.set(error instanceof Error ? error.message : '船体尺寸应用失败'); }
  }

  resetBody() {
    this.ais.resetBodyDimensions(this.ais.selectedMmsi());
    this.bodyDraft.set(null);
    this.bodyError.set('');
  }

  find() {
    const mmsi = this.search().trim();
    if (!this.ais.targets().some(target => target.mmsi === mmsi)) { this.lookupError.set('未找到该 MMSI 的有效目标'); return; }
    this.lookupError.set('');
    this.ais.selectTarget(mmsi);
  }
}
