import { Injectable, computed, inject, signal } from '@angular/core';
import type { OnDestroy } from '@angular/core';
import { ApiService, errorMessage } from './api.service';
import type { VesselSnapshot, VesselSourceCatalog, VesselTarget } from './ais.models';

@Injectable({ providedIn: 'root' })
export class AisState implements OnDestroy {
  private readonly api = inject(ApiService);
  readonly catalog = signal<VesselSourceCatalog | null>(null);
  readonly selectedId = signal('');
  readonly targets = signal<readonly VesselTarget[]>([]);
  readonly selectedMmsi = signal('');
  readonly trackedMmsi = signal('');
  readonly selectionRevision = signal(0);
  readonly status = signal<VesselSnapshot['status']>('idle');
  readonly problem = signal('');
  readonly preferenceError = signal('');
  readonly loading = signal(false);
  readonly selectedSource = computed(() => this.catalog()?.sources.find(source => source.id === this.selectedId()) ?? null);
  readonly selectedTarget = computed(() => this.targets().find(target => target.mmsi === this.selectedMmsi()) ?? null);
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
    const stream = new EventSource(`/api/data-sources/${encodeURIComponent(id)}/events`);
    this.stream = stream;
    stream.onmessage = event => {
      if (this.stream !== stream || this.selectedId() !== id) return;
      try {
        const snapshot: VesselSnapshot = JSON.parse(event.data);
        if (snapshot.sourceId !== id) throw new Error('数据源响应不匹配');
        this.status.set(snapshot.status);
        this.problem.set(snapshot.error ?? '');
        this.targets.set(snapshot.status === 'connected' ? snapshot.targets : []);
        if (!this.targets().some(target => target.mmsi === this.selectedMmsi())) this.selectTarget('');
        if (!this.targets().some(target => target.mmsi === this.trackedMmsi())) this.trackedMmsi.set('');
      } catch (error) {
        this.status.set('reconnecting');
        this.targets.set([]);
        this.selectTarget('');
        this.clearTracking();
        this.problem.set(errorMessage(error));
      }
    };
    stream.onerror = () => {
      if (this.stream !== stream) return;
      this.status.set('reconnecting');
      this.targets.set([]);
      this.selectTarget('');
      this.clearTracking();
      this.problem.set('AIS 页面连接已断开，正在重连');
    };
  }

  selectTarget(mmsi: string) {
    if (mmsi !== this.selectedMmsi()) this.selectionRevision.update(revision => revision + 1);
    this.selectedMmsi.set(mmsi);
  }
  clearTracking() { this.trackedMmsi.set(''); }

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
