import { Injectable, inject, signal } from '@angular/core';
import { ApiService, errorMessage } from './api.service';
import type { PlotLayerDetail, PlotLayerError, PlotLayerImportInput, PlotLayerSummary, PlotLayerUpdateInput } from './plot-layer.models';

@Injectable({ providedIn: 'root' })
export class PlotLayerState {
  private readonly api = inject(ApiService);
  readonly layers = signal<PlotLayerSummary[]>([]);
  readonly texts = signal<ReadonlyMap<string, string>>(new Map());
  readonly layerErrors = signal<ReadonlyMap<string, string>>(new Map());
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly problem = signal('');
  private revision = 0;
  private readonly detailRequests = new Map<string, Promise<boolean>>();

  async refresh() {
    if (this.busy() || this.loading()) return;
    const revision = ++this.revision;
    this.detailRequests.clear();
    this.loading.set(true);
    this.problem.set('');
    this.layerErrors.set(new Map());
    try {
      const layers = await this.api.plotLayers();
      if (revision !== this.revision) return;
      const ids = new Set(layers.map((layer) => layer.id));
      this.texts.update((texts) => new Map([...texts].filter(([id]) => ids.has(id))));
      this.layers.set(layers);
    } catch (error) {
      if (revision === this.revision) this.problem.set(errorMessage(error));
    } finally {
      if (revision === this.revision) this.loading.set(false);
    }
  }

  async loadDetails(ids: readonly string[]) {
    const results = await Promise.all(ids.map((id) => this.loadDetail(id)));
    return results.every(Boolean);
  }

  private loadDetail(id: string): Promise<boolean> {
    if (this.texts().has(id)) return Promise.resolve(true);
    const pending = this.detailRequests.get(id);
    if (pending) return pending;
    const revision = this.revision;
    const request = this.api.plotLayer(id).then((detail) => {
      if (revision !== this.revision || !this.layers().some((layer) => layer.id === id)) return false;
      this.cacheText(detail);
      this.clearLayerError(id);
      return true;
    }).catch((error: unknown) => {
      if (revision === this.revision && this.layers().some((layer) => layer.id === id)) {
        this.reportLayerError({ layerId: id, message: errorMessage(error) });
      }
      return false;
    }).finally(() => {
      if (this.detailRequests.get(id) === request) this.detailRequests.delete(id);
    });
    this.detailRequests.set(id, request);
    return request;
  }

  private cacheText(detail: PlotLayerDetail) {
    this.texts.update((texts) => new Map(texts).set(detail.id, detail.geojsonText));
  }

  private replaceLayer(layer: PlotLayerSummary) {
    this.layers.update((layers) => layers.some((item) => item.id === layer.id)
      ? layers.map((item) => item.id === layer.id ? layer : item) : [...layers, layer]);
  }

  async importLayer(input: PlotLayerImportInput) {
    if (this.busy() || this.loading()) return false;
    this.busy.set(true);
    this.problem.set('');
    try {
      const detail = await this.api.importPlotLayer(input);
      this.cacheText(detail);
      const { geojsonText: _text, ...summary } = detail;
      this.replaceLayer(summary);
      return true;
    } catch (error) {
      this.problem.set(errorMessage(error));
      return false;
    } finally { this.busy.set(false); }
  }

  async saveLayer(id: string, input: PlotLayerUpdateInput) {
    if (this.busy() || this.loading()) return false;
    this.busy.set(true);
    this.problem.set('');
    try {
      this.replaceLayer(await this.api.savePlotLayer(id, input));
      return true;
    } catch (error) {
      this.problem.set(errorMessage(error));
      return false;
    } finally { this.busy.set(false); }
  }

  async setVisibility(id: string, cameraId: string, visible: boolean) {
    if (this.busy() || this.loading()) return false;
    this.busy.set(true);
    this.problem.set('');
    try {
      const association = await this.api.setPlotLayerVisibility(id, cameraId, visible);
      this.layers.update((layers) => layers.map((layer) => layer.id === id ? {
        ...layer, associations: layer.associations.map((item) => item.cameraId === cameraId ? association : item),
      } : layer));
      return true;
    } catch (error) {
      this.problem.set(errorMessage(error));
      return false;
    } finally { this.busy.set(false); }
  }

  async deleteLayer(id: string) {
    if (this.busy() || this.loading()) return false;
    this.busy.set(true);
    this.problem.set('');
    try {
      await this.api.deletePlotLayer(id);
      this.layers.update((layers) => layers.filter((layer) => layer.id !== id));
      this.texts.update((texts) => { const next = new Map(texts); next.delete(id); return next; });
      this.clearLayerError(id);
      return true;
    } catch (error) {
      this.problem.set(errorMessage(error));
      return false;
    } finally { this.busy.set(false); }
  }

  reportLayerError(error: PlotLayerError) {
    this.layerErrors.update((errors) => new Map(errors).set(error.layerId, error.message));
  }

  private clearLayerError(id: string) {
    this.layerErrors.update((errors) => { const next = new Map(errors); next.delete(id); return next; });
  }
}
