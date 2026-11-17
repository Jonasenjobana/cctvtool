import { Injectable, computed, inject, signal } from '@angular/core';
import type { OnDestroy } from '@angular/core';
import { ApiService, errorMessage } from './api.service';
import { vesselBodyDimensions } from './ais-math';
import type { VesselBodyDimensions, VesselPrediction, VesselSnapshot, VesselSourceCatalog, VesselTarget } from './ais.models';

@Injectable({ providedIn: 'root' })
export class AisState implements OnDestroy {
  private readonly api = inject(ApiService);
  readonly catalog = signal<VesselSourceCatalog | null>(null);
  readonly selectedId = signal('');
  readonly targets = signal<readonly VesselTarget[]>([]);
  readonly selectedMmsi = signal('');
  readonly trackedMmsi = signal('');
  readonly selectionRevision = signal(0);
  readonly bodyRevision = signal(0);
  readonly useBodyGeometry = signal(false);
  readonly trackingZoom = signal<number | null>(null);
  readonly predictionSeconds = signal<number | null>(null);
  readonly predictionTarget = signal<VesselTarget | null>(null);
  readonly predictedPosition = signal<VesselPrediction | null>(null);
  readonly status = signal<VesselSnapshot['status'] | 'error'>('idle');
  readonly problem = signal('');
  readonly preferenceError = signal('');
  readonly loading = signal(false);
  readonly selectedSource = computed(() => this.catalog()?.sources.find(source => source.id === this.selectedId()) ?? null);
  readonly selectedTarget = computed(() => {
    const predicted = this.predictionTarget();
    return predicted?.mmsi === this.selectedMmsi() ? predicted : this.targets().find(target => target.mmsi === this.selectedMmsi()) ?? null;
  });
  readonly predictedTarget = computed(() => {
    const target = this.predictionTarget(), position = this.predictedPosition();
    return target && position ? { ...target, longitude: position.longitude, latitude: position.latitude } : null;
  });
  private readonly bodySettings = signal<ReadonlyMap<string, ReadonlyMap<string, VesselBodyDimensions>>>(new Map());
  readonly bodyOverrides = computed(() => this.bodySettings().get(this.selectedId()) ?? new Map<string, VesselBodyDimensions>());
  readonly selectedBodyOverride = computed(() => this.bodyOverrides().get(this.selectedMmsi()) ?? null);
  private active = false;
  private stream?: EventSource;

  async load() {
    if (this.loading()) return;
    this.loading.set(true);
    this.problem.set('');
    try {
      const catalog = await this.api.dataSources();
      this.catalog.set(catalog);
      let remembered: string | null = null;
      try { remembered = localStorage.getItem(this.storageKey()); }
      catch { this.preferenceError.set('浏览器无法读取数据源选择'); }
      const id = remembered === null ? catalog.sources[0]?.id ?? '' : remembered;
      this.selectSource(catalog.sources.some(source => source.id === id) ? id : '');
    } catch (error) { this.problem.set(errorMessage(error)); }
    finally { this.loading.set(false); }
  }

  private storageKey() { return `cctv-tool:${this.catalog()!.project.id}:ais-source`; }

  selectSource(id: string) {
    if (id && !this.catalog()?.sources.some(source => source.id === id)) return;
    this.disconnect();
    this.selectedId.set(id);
    this.preferenceError.set('');
    if (this.catalog()) {
      try { localStorage.setItem(this.storageKey(), id); }
      catch { this.preferenceError.set('浏览器无法记住数据源选择'); }
    }
    this.openStream();
  }

  setActive(active: boolean) {
    if (this.active === active) return;
    this.active = active;
    this.disconnect();
    this.openStream();
  }

  private openStream() {
    const id = this.selectedId();
    if (!this.active || !id || this.stream) return;
    this.status.set('connecting');
    try {
      const stream = new EventSource(`/api/data-sources/${encodeURIComponent(id)}/events`);
      this.stream = stream;
      // 注入脚本可能代理 EventSource，事件属性 setter 会因 receiver 不是原生实例而失败。
      stream.addEventListener('message', event => {
        if (this.stream !== stream || this.selectedId() !== id) return;
        try {
          const snapshot: VesselSnapshot = JSON.parse(event.data);
          if (snapshot.sourceId !== id) throw new Error('数据源响应不匹配');
          this.status.set(snapshot.status);
          this.problem.set(snapshot.error ?? '');
          this.targets.set(snapshot.status === 'connected' ? snapshot.targets : []);
          const previous = this.predictionTarget(), latest = this.targets().find(target => target.mmsi === previous?.mmsi);
          if (latest && previous && Date.parse(latest.time) >= Date.parse(previous.time)) this.predictionTarget.set({ ...latest });
          if (!this.hasPrediction()) {
            if (!this.targets().some(target => target.mmsi === this.selectedMmsi())) this.selectTarget('');
            if (!this.targets().some(target => target.mmsi === this.trackedMmsi())) this.clearTracking();
          }
        } catch (error) {
          this.status.set('reconnecting');
          this.targets.set([]);
          if (!this.hasPrediction()) { this.selectTarget(''); this.clearTracking(); }
          this.problem.set(errorMessage(error));
        }
      });
      stream.addEventListener('error', () => {
        if (this.stream !== stream) return;
        this.status.set('reconnecting');
        this.targets.set([]);
        if (!this.hasPrediction()) { this.selectTarget(''); this.clearTracking(); }
        this.problem.set('AIS 页面连接已断开，正在重连');
      });
    } catch (error) {
      this.disconnect();
      this.status.set('error');
      this.problem.set(`AIS 订阅初始化失败：${error instanceof Error ? error.message : errorMessage(error)}`);
    }
  }

  selectTarget(mmsi: string) {
    if (mmsi !== this.selectedMmsi()) {
      this.selectionRevision.update(revision => revision + 1);
      this.clearTracking();
    }
    this.selectedMmsi.set(mmsi);
  }
  clearTracking() {
    if (this.trackedMmsi()) this.selectionRevision.update(revision => revision + 1);
    this.trackedMmsi.set('');
    this.predictionSeconds.set(null);
    this.predictionTarget.set(null);
    this.predictedPosition.set(null);
  }

  private hasPrediction() {
    return this.predictionSeconds() !== null && this.predictionTarget()?.mmsi === this.trackedMmsi();
  }

  startPrediction(seconds: number | null) {
    if (seconds === null || !Number.isFinite(seconds) || seconds < 0) throw new Error('预判秒数须为大于或等于 0 的数字');
    const target = this.selectedTarget();
    if (!target || !this.selectedSource()) throw new Error('该 AIS 目标已失效或未选择数据源');
    this.clearTracking();
    this.predictionTarget.set({ ...target });
    this.predictionSeconds.set(seconds);
    this.trackedMmsi.set(target.mmsi);
  }

  setUseBodyGeometry(enabled: boolean) {
    if (enabled === this.useBodyGeometry()) return;
    this.useBodyGeometry.set(enabled);
    this.bodyRevision.update(revision => revision + 1);
  }

  setTrackingZoom(zoom: number | null, maxZoom: number) {
    if (!Number.isFinite(maxZoom) || maxZoom < 1) throw new Error('摄像头最大倍率必须大于或等于 1');
    if (zoom === null || !Number.isFinite(zoom) || zoom < 1 || zoom > maxZoom) throw new Error(`跟踪倍率须位于 1～${maxZoom}`);
    if (zoom === this.trackingZoom()) return;
    this.trackingZoom.set(zoom);
    this.bodyRevision.update(revision => revision + 1);
  }

  setBodyDimensions(mmsi: string, dimensions: VesselBodyDimensions) {
    const cached = this.predictionTarget();
    const ship = this.targets().find(target => target.mmsi === mmsi) ?? (cached?.mmsi === mmsi ? cached : null), source = this.selectedSource();
    if (!ship || !source) throw new Error('该 AIS 目标已失效或未选择数据源');
    if (!vesselBodyDimensions(ship, source.geometry, dimensions)) {
      throw new Error('ABCD 须为非负数，A+B、C+D 和船高须大于 0');
    }
    const settings = new Map(this.bodySettings()), bodies = new Map(settings.get(source.id));
    bodies.set(mmsi, { ...dimensions });
    settings.set(source.id, bodies);
    this.bodySettings.set(settings);
    this.bodyRevision.update(revision => revision + 1);
  }

  resetBodyDimensions(mmsi: string) {
    if (!this.bodyOverrides().has(mmsi)) return;
    const settings = new Map(this.bodySettings()), bodies = new Map(settings.get(this.selectedId()));
    bodies.delete(mmsi);
    settings.set(this.selectedId(), bodies);
    this.bodySettings.set(settings);
    this.bodyRevision.update(revision => revision + 1);
  }

  private disconnect() {
    this.selectionRevision.update(revision => revision + 1);
    this.stream?.close();
    this.stream = undefined;
    this.targets.set([]);
    this.selectTarget('');
    this.clearTracking();
    this.status.set('idle');
    this.problem.set('');
  }

  ngOnDestroy() { this.disconnect(); }
}
