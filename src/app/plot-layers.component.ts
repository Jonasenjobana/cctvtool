import { ChangeDetectionStrategy, Component, ElementRef, EventEmitter, Input, Output, ViewChild, computed, inject, signal } from '@angular/core';
import type { OnChanges, OnDestroy, SimpleChanges } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IconComponent } from './icon.component';
import type { Camera } from './models';
import type { PlotLayerSummary } from './plot-layer.models';
import { PlotLayerState } from './plot-layer-state.service';

const maxFileBytes = 10 * 1024 * 1024;

@Component({
  selector: 'app-plot-layers', standalone: true,
  imports: [FormsModule, IconComponent], changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './plot-layers.component.html', styleUrl: './plot-layers.component.css',
})
export class PlotLayersComponent implements OnChanges, OnDestroy {
  @Input() cameras: readonly Camera[] = [];
  @Input() selectedCameraId = '';
  @Input() focusing = false;
  @Output() readonly focused = new EventEmitter<{ layerId: string; cameraId: string }>();
  @ViewChild('plotFile') fileInput?: ElementRef<HTMLInputElement>;
  readonly plots = inject(PlotLayerState);
  readonly contextId = signal('');
  readonly sourceFileName = signal('');
  readonly importName = signal('');
  readonly importCameraIds = signal<string[]>([]);
  readonly fileText = signal<string | null>(null);
  readonly readingFile = signal(false);
  readonly fileProblem = signal('');
  readonly editingId = signal('');
  readonly editName = signal('');
  readonly editCameraIds = signal<string[]>([]);
  readonly message = signal('');
  readonly canImport = computed(() => this.fileText() !== null && !!this.importName().trim()
    && this.importName().trim().length <= 200 && !this.readingFile());
  private fileRevision = 0;

  ngOnChanges(changes: SimpleChanges) {
    if (changes['selectedCameraId']) {
      this.contextId.set(this.selectedCameraId);
      if (!this.sourceFileName()) this.importCameraIds.set(this.selectedCameraId ? [this.selectedCameraId] : []);
    }
  }

  async readFile(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    const revision = ++this.fileRevision;
    this.fileText.set(null);
    this.sourceFileName.set(file?.name || '');
    this.fileProblem.set('');
    this.message.set('');
    this.readingFile.set(false);
    if (!file) return;
    if (!/\.(geojson|json)$/i.test(file.name)) { this.fileProblem.set('请选择 .geojson 或 .json 文件'); return; }
    if (file.size > maxFileBytes) { this.fileProblem.set('原始文件不能超过 10 MiB'); return; }
    if (file.name.length > 255) { this.fileProblem.set('文件名不能超过 255 个字符'); return; }
    this.readingFile.set(true);
    try {
      const bytes = await file.arrayBuffer();
      // ignoreBOM 保留原文中的 BOM；fatal 使非法 UTF-8 明确失败，避免替换字节后保存。
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      if (revision !== this.fileRevision) return;
      this.fileText.set(text);
      this.importName.set(file.name.replace(/\.(geojson|json)$/i, '').slice(0, 200));
    } catch (error) {
      if (revision === this.fileRevision) this.fileProblem.set(error instanceof TypeError
        ? '文件不是有效的 UTF-8 文本' : '无法读取文件，请重新选择');
    } finally { if (revision === this.fileRevision) this.readingFile.set(false); }
  }

  toggleImportCamera(id: string, event: Event) {
    this.importCameraIds.update((ids) => this.toggleId(ids, id, event));
  }

  toggleEditCamera(id: string, event: Event) {
    this.editCameraIds.update((ids) => this.toggleId(ids, id, event));
  }

  private toggleId(ids: string[], id: string, event: Event) {
    return (event.target as HTMLInputElement).checked ? [...ids, id] : ids.filter((item) => item !== id);
  }

  async importLayer() {
    if (!this.canImport() || this.focusing) return;
    this.message.set('');
    if (!await this.plots.importLayer({ name: this.importName().trim(), sourceFileName: this.sourceFileName(),
      geojsonText: this.fileText()!, cameraIds: [...this.importCameraIds()] })) return;
    this.fileText.set(null);
    this.sourceFileName.set('');
    this.importName.set('');
    this.importCameraIds.set(this.selectedCameraId ? [this.selectedCameraId] : []);
    if (this.fileInput) this.fileInput.nativeElement.value = '';
    this.message.set('标绘图层已导入');
  }

  editLayer(layer: PlotLayerSummary) {
    this.editingId.set(layer.id);
    this.editName.set(layer.name);
    this.editCameraIds.set(layer.associations.map((association) => association.cameraId));
    this.message.set('');
  }

  async saveLayer() {
    const id = this.editingId(), name = this.editName().trim();
    if (!id || !name || name.length > 200 || this.focusing) return;
    this.message.set('');
    if (await this.plots.saveLayer(id, { name, cameraIds: [...this.editCameraIds()] })) {
      this.editingId.set('');
      this.message.set('名称与摄像头关联已保存');
    }
  }

  association(layer: PlotLayerSummary) {
    return layer.associations.find((association) => association.cameraId === this.contextId());
  }

  cameraNames(layer: PlotLayerSummary) {
    return layer.associations.map((association) => this.cameras.find((camera) => camera.id === association.cameraId)?.name || association.cameraId).join('、') || '未关联';
  }

  async setVisibility(layer: PlotLayerSummary) {
    const association = this.association(layer);
    if (association && !this.focusing) await this.plots.setVisibility(layer.id, association.cameraId, !association.visible);
  }

  focusLayer(layer: PlotLayerSummary) {
    if (this.association(layer)) this.focused.emit({ layerId: layer.id, cameraId: this.contextId() });
  }

  async deleteLayer(layer: PlotLayerSummary) {
    if (this.plots.busy() || this.plots.loading() || this.focusing) return;
    if (!window.confirm(`删除标绘图层“${layer.name}”？\n将删除原始数据及全部关联。\n受影响摄像头：${this.cameraNames(layer)}`)) return;
    this.message.set('');
    if (await this.plots.deleteLayer(layer.id)) {
      if (this.editingId() === layer.id) this.editingId.set('');
      this.message.set('标绘图层已删除');
    }
  }

  ngOnDestroy() { this.fileRevision++; }
}
