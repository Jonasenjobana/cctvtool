import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, ElementRef, EventEmitter, Input, Output, ViewChild, computed, inject, signal } from '@angular/core';
import type { OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, errorMessage } from './api.service';
import { IconComponent } from './icon.component';
import type { Camera, HorizonPoint, RecognitionItem, RecognitionTask, SnapshotGroup } from './models';
import { extendHorizonLine, movePanoramaEndpoint, projectPanoramaLine } from './panorama-math';
import type { PanoramaFrame, PanoramaPlan } from './panorama-math';
import { renderTaskPanorama } from './task-panorama';

@Component({
  selector: 'app-recognition-tasks', standalone: true,
  imports: [DatePipe, DecimalPipe, FormsModule, IconComponent], changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './recognition-tasks.component.html', styleUrl: './recognition-tasks.component.css',
})
export class RecognitionTasksComponent implements OnInit, OnDestroy {
  @Input() taskId = '';
  @Output() readonly applied = new EventEmitter<Camera>();
  @Output() readonly scanCreated = new EventEmitter<SnapshotGroup>();
  @ViewChild('panoramaViewport') private panoramaViewport?: ElementRef<HTMLDivElement>;
  private readonly api = inject(ApiService);
  readonly tasks = signal<RecognitionTask[]>([]);
  readonly selected = signal<RecognitionTask | null>(null);
  readonly sourceGroup = signal<SnapshotGroup | null>(null);
  readonly items = signal<RecognitionItem[]>([]);
  readonly selectedItemId = signal('');
  readonly item = computed(() => this.items().find((item) => item.snapshotId === this.selectedItemId()) || null);
  readonly points = signal<HorizonPoint[]>([]);
  readonly ignored = signal(false);
  readonly dirty = signal(false);
  readonly busy = signal(false);
  readonly loading = signal(false);
  readonly problem = signal('');
  readonly message = signal('');
  readonly nextTaskOffset = signal<number | null>(null);
  readonly nextItemOffset = signal<number | null>(null);
  readonly panorama = signal<{ url: string; width: number; height: number; count: number; missing: number; plan: PanoramaPlan } | null>(null);
  readonly generatingPanorama = signal(false);
  readonly panoramaProgress = signal('');
  readonly panoramaError = signal('');
  readonly panoramaExpanded = signal(false);
  readonly showPanoramaLines = signal(true);
  readonly activePanoramaEndpoint = signal(0);
  readonly panoramaLines = computed(() => {
    const image = this.panorama();
    if (!image) return [];
    const entries = new Map(this.items().map((entry) => [entry.snapshotId, entry]));
    return image.plan.frames.flatMap((frame) => {
      const entry = entries.get(frame.snapshot.id);
      if (!entry || entry.missing) return [];
      const current = entry.snapshotId === this.selectedItemId();
      const sourcePoints = extendHorizonLine(current ? this.points() : entry.points, current ? 0.03 : 0);
      const points = projectPanoramaLine(image.plan, frame, sourcePoints);
      return points.length ? [{ snapshotId: entry.snapshotId, ignored: current ? this.ignored() : entry.ignored,
        pan: entry.snapshot.ptz.raw.Pan, sourcePoints, endpoints: [points[0], points[points.length - 1]],
        points: points.map((point) => `${point.x},${point.y}`).join(' ') }] : [];
    });
  });
  readonly focusedPanoramaLine = computed(() => this.panoramaLines().find((line) => line.snapshotId === this.selectedItemId()));
  readonly panoramaOutline = computed(() => {
    const image = this.panorama();
    const frame = image?.plan.frames.find((frame) => frame.snapshot.id === this.selectedItemId());
    if (!image || !frame || !this.focusedPanoramaLine()) return '';
    const corners = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    return corners.flatMap((point, index) => projectPanoramaLine(image.plan, frame, [point, corners[(index + 1) % 4]]))
      .map((point) => `${point.x},${point.y}`).join(' ');
  });
  readonly panoramaFocusClip = computed(() => {
    const image = this.panorama(), outline = this.panoramaOutline();
    return image && outline ? `M0,0 H${image.width} V${image.height} H0 Z M${outline.split(' ').join(' L')} Z` : '';
  });
  readonly running = computed(() => ['queued', 'running'].includes(this.selected()?.status || ''));
  readonly coarse = computed(() => this.sourceGroup()?.horizon?.phase === 'coarse');
  readonly horizonReady = computed(() => this.coarse() && this.sourceGroup()?.status === 'completed'
    && !this.running() && !this.busy() && !this.loading() && !this.dirty() && !this.generatingPanorama()
    && this.selected()?.result?.status === 'estimated' && !!this.selected()?.resultId);
  private readonly reviewConfirmation = signal<{ taskId: string; revision: number; resultId: string } | null>(null);
  readonly horizonReviewed = computed(() => {
    const task = this.selected(), confirmation = this.reviewConfirmation();
    return !!task && !!confirmation && confirmation.taskId === task.id
      && confirmation.revision === task.revision && confirmation.resultId === task.resultId;
  });
  readonly fields = [
    { key: 'pAxisPitch', label: 'P 轴前后倾' }, { key: 'pAxisRoll', label: 'P 轴左右倾' },
    { key: 'tiltOffset', label: 'T 偏移' }, { key: 'imageRoll', label: '画面 Roll 修正' },
  ] as const;
  readonly statuses = { queued: '等待识别', running: '识别中', completed: '识别完成', failed: '识别失败', cancelled: '已取消', interrupted: '已中断' };
  private timer?: ReturnType<typeof setInterval>;
  private destroyed = false;
  private revision = 0;
  private dragIndex: number | null = null;
  private panoramaController?: AbortController;
  private panoramaDrag: { pointerId: number; index: number; stage: HTMLElement; frame: PanoramaFrame;
    points: HorizonPoint[]; startY: number; lastY: number } | null = null;

  ngOnInit() {
    void this.refresh();
    this.timer = setInterval(() => { if (this.running()) void this.refresh(); }, 2000);
  }

  async refresh() {
    if (this.busy() || this.loading() || this.dirty() || this.generatingPanorama() || this.destroyed) return;
    this.loading.set(true);
    const revision = this.revision;
    this.problem.set('');
    try {
      const page = await this.api.recognitionTasks();
      if (this.destroyed || revision !== this.revision || this.dirty()) return;
      const ids = new Set(page.tasks.map((task) => task.id));
      this.tasks.update((tasks) => [...page.tasks, ...tasks.filter((task) => !ids.has(task.id))]);
      this.nextTaskOffset.set(this.tasks().length < page.total ? this.tasks().length : null);
      const id = this.selected()?.id || this.taskId || page.tasks[0]?.id;
      if (id) await this.loadTask(id, false);
    } catch (error) { if (!this.destroyed) this.problem.set(errorMessage(error)); }
    finally { this.loading.set(false); }
  }

  async loadTask(id: string, save = true) {
    if (this.busy() || (save && !await this.save())) return;
    this.clearPanorama();
    const revision = ++this.revision;
    this.loading.set(true);
    this.problem.set('');
    try {
      const page = await this.api.recognitionItems(id);
      if (this.destroyed || revision !== this.revision || this.dirty()) return;
      this.setTask(page.task);
      this.items.set(page.items);
      this.nextItemOffset.set(page.nextOffset);
      this.selectItem(page.items.find((item) => item.snapshotId === this.selectedItemId()) || page.items[0]);
      const sourceGroup = await this.api.snapshotGroup(page.task.sourceTaskId);
      if (!this.destroyed && revision === this.revision) this.sourceGroup.set(sourceGroup);
    } catch (error) { if (!this.destroyed && revision === this.revision) this.problem.set(errorMessage(error)); }
    finally { if (revision === this.revision) this.loading.set(false); }
  }

  private setTask(task: RecognitionTask) {
    const previous = this.selected();
    if (previous?.id !== task.id) this.clearPanorama();
    if (previous?.id !== task.id || previous.revision !== task.revision || previous.resultId !== task.resultId) {
      this.reviewConfirmation.set(null);
    }
    if (previous?.sourceTaskId !== task.sourceTaskId) this.sourceGroup.set(null);
    this.selected.set(task);
    this.tasks.update((tasks) => tasks.some((item) => item.id === task.id)
      ? tasks.map((item) => item.id === task.id ? task : item) : [task, ...tasks]);
  }

  selectItem(item?: RecognitionItem) {
    this.endPanoramaDrag();
    if (item?.snapshotId !== this.selectedItemId()) this.activePanoramaEndpoint.set(0);
    this.selectedItemId.set(item?.snapshotId || '');
    this.points.set((item?.points || []).map((point) => ({ ...point })));
    this.ignored.set(item?.ignored ?? true);
    this.dirty.set(false);
    this.dragIndex = null;
  }

  async openItem(item: RecognitionItem) {
    if (!this.busy() && !this.loading() && await this.save()) {
      this.selectItem(this.items().find((entry) => entry.snapshotId === item.snapshotId) || item);
      this.focusPanorama();
    }
  }
  undo() { const item = this.item(); if (item) this.selectItem(item); }

  openPanoramaItem(snapshotId: string) {
    if (snapshotId === this.selectedItemId()) { this.focusPanorama(); return; }
    const entry = this.items().find((item) => item.snapshotId === snapshotId);
    if (entry) void this.openItem(entry);
  }

  clearPanorama() {
    this.endPanoramaDrag();
    this.panoramaController?.abort();
    this.panoramaController = undefined;
    const previous = this.panorama();
    if (previous) URL.revokeObjectURL(previous.url);
    this.panorama.set(null);
    this.generatingPanorama.set(false);
    this.panoramaProgress.set('');
    this.panoramaError.set('');
    this.panoramaExpanded.set(false);
    this.activePanoramaEndpoint.set(0);
  }

  focusPanorama(index?: number) {
    if (index !== undefined) this.activePanoramaEndpoint.set(index);
    const viewport = this.panoramaViewport?.nativeElement;
    const handle = index === undefined ? null : viewport?.querySelector<HTMLButtonElement>(`[data-panorama-endpoint="${index}"]`);
    (handle && !handle.disabled ? handle : viewport)?.focus({ preventScroll: true });
  }

  private panoramaPointerY(event: PointerEvent, stage: HTMLElement) {
    const image = this.panorama(), rect = stage.getBoundingClientRect();
    if (!image || rect.width <= 0 || rect.height <= 0) return null;
    return (event.clientY - rect.top) / rect.height * image.height;
  }

  startPanoramaDrag(event: PointerEvent, index: number) {
    if (event.button !== 0 || this.panoramaDrag || this.dragIndex !== null || this.busy() || this.loading()
      || this.running() || this.generatingPanorama() || this.item()?.missing) return;
    const line = this.focusedPanoramaLine();
    const frame = this.panorama()?.plan.frames.find((frame) => frame.snapshot.id === this.selectedItemId());
    const stage = (event.currentTarget as HTMLElement).parentElement;
    if (!line?.sourcePoints[index] || !frame || !stage) return;
    const startY = this.panoramaPointerY(event, stage);
    if (startY === null) return;
    event.preventDefault();
    this.focusPanorama(index);
    this.panoramaDrag = { pointerId: event.pointerId, index, stage, frame,
      points: line.sourcePoints.map((point) => ({ ...point })),
      startY, lastY: line.sourcePoints[index].y };
    stage.setPointerCapture(event.pointerId);
  }

  dragPanorama(event: PointerEvent) {
    const drag = this.panoramaDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (this.busy() || this.loading() || this.running() || !this.showPanoramaLines()
      || this.selectedItemId() !== drag.frame.snapshot.id) { this.endPanoramaDrag(); return; }
    const image = this.panorama(), pointerY = this.panoramaPointerY(event, drag.stage);
    if (!image || pointerY === null) return;
    const point = movePanoramaEndpoint(image.plan, drag.frame, drag.points[drag.index], pointerY - drag.startY);
    if (!point) return;
    const y = point.y;
    if (Math.abs(y - drag.lastY) < 1e-10) return;
    drag.lastY = y;
    // 留缝端点属于当前原图，固定横坐标以保持左右编辑位置。
    this.points.set(drag.points.map((point) => ({ ...point })));
    this.editPoint(drag.index, 'y', y);
  }

  endPanoramaDrag(event?: PointerEvent) {
    const drag = this.panoramaDrag;
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    this.panoramaDrag = null;
    if (drag.stage.hasPointerCapture(drag.pointerId)) drag.stage.releasePointerCapture(drag.pointerId);
  }

  panoramaKeydown(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null;
    if (event.defaultPrevented || event.isComposing || target?.closest('input, textarea, select, [contenteditable]')) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      event.stopPropagation();
      if (!this.busy() && !this.loading() && !this.running() && !this.generatingPanorama()) void this.save();
      return;
    }
    if (this.busy() || this.loading() || this.running() || this.generatingPanorama() || this.item()?.missing
      || !this.showPanoramaLines() || this.panoramaDrag || this.dragIndex !== null || event.ctrlKey || event.metaKey) return;
    const line = this.focusedPanoramaLine(), item = this.item();
    if (!line || !item) return;
    if (!event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      this.focusPanorama(event.key === 'ArrowLeft' ? 0 : 1);
      return;
    }
    if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const index = this.activePanoramaEndpoint();
    const step = event.altKey ? 0.1 : event.shiftKey ? 10 : 1;
    const y = Math.max(0, Math.min(1,
      line.sourcePoints[index].y + (event.key === 'ArrowUp' ? -step : step) / item.snapshot.height));
    if (Math.abs(y - line.sourcePoints[index].y) < 1e-12) return;
    this.points.set(line.sourcePoints.map((point) => ({ ...point })));
    this.editPoint(index, 'y', y);
  }

  async generatePanorama() {
    if (this.busy() || this.loading() || this.running() || this.generatingPanorama() || !await this.save()) return;
    const task = this.selected();
    if (!task) return;
    this.clearPanorama();
    const controller = new AbortController();
    this.panoramaController = controller;
    this.generatingPanorama.set(true);
    try {
      const entries: RecognitionItem[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        controller.signal.throwIfAborted();
        this.panoramaProgress.set(`正在读取截图与标注 ${entries.length} / ${task.sampleCount}`);
        const page = await this.api.recognitionItems(task.id, offset);
        controller.signal.throwIfAborted();
        if (page.task.revision !== task.revision || page.task.updatedAt !== task.updatedAt || page.total !== task.sampleCount) {
          throw new Error('识别任务或标注已变化，请刷新后重新生成全景图');
        }
        entries.push(...page.items);
        offset = page.nextOffset;
      }
      if (entries.length !== task.sampleCount) throw new Error('识别截图数量已变化，请刷新后重新生成全景图');
      const snapshots = entries.filter((entry) => !entry.missing).map((entry) => entry.snapshot);
      const result = await renderTaskPanorama(snapshots, controller.signal, (done, total) => {
        this.panoramaProgress.set(`正在拼接 ${done} / ${total}`);
      });
      const latest = await this.api.recognitionTask(task.id);
      controller.signal.throwIfAborted();
      if (latest.revision !== task.revision || latest.updatedAt !== task.updatedAt) {
        throw new Error('识别任务或标注已变化，请刷新后重新生成全景图');
      }
      this.items.set(entries);
      this.nextItemOffset.set(null);
      this.selectItem(entries.find((entry) => entry.snapshotId === this.selectedItemId()) || entries[0]);
      this.showPanoramaLines.set(true);
      this.panorama.set({ url: URL.createObjectURL(result.blob), width: result.width, height: result.height,
        count: result.count, missing: entries.length - snapshots.length, plan: result.plan });
    } catch (error) {
      if (!controller.signal.aborted) this.panoramaError.set(error instanceof Error && error.name === 'Error' ? error.message : errorMessage(error));
    } finally {
      if (this.panoramaController === controller) {
        this.panoramaController = undefined;
        this.generatingPanorama.set(false);
        this.panoramaProgress.set('');
      }
    }
  }

  async loadMore(kind: 'tasks' | 'items') {
    if (this.loading() || this.busy() || this.generatingPanorama()) return;
    const offset = kind === 'tasks' ? this.nextTaskOffset() : this.nextItemOffset();
    const id = this.selected()?.id;
    if (offset === null || (kind === 'items' && !id)) return;
    const revision = this.revision;
    this.loading.set(true);
    try {
      if (kind === 'tasks') {
        const page = await this.api.recognitionTasks(offset);
        if (this.destroyed) return;
        const ids = new Set(this.tasks().map((task) => task.id));
        this.tasks.update((tasks) => [...tasks, ...page.tasks.filter((task) => !ids.has(task.id))]);
        this.nextTaskOffset.set(page.nextOffset);
      } else {
        const page = await this.api.recognitionItems(id!, offset);
        if (this.destroyed || revision !== this.revision) return;
        const ids = new Set(this.items().map((item) => item.snapshotId));
        this.items.update((items) => [...items, ...page.items.filter((item) => !ids.has(item.snapshotId))]);
        this.nextItemOffset.set(page.nextOffset);
      }
    } catch (error) { this.problem.set(errorMessage(error)); }
    finally { this.loading.set(false); }
  }

  editPoint(index: number, axis: 'x' | 'y', value: number | null) {
    if (value === null || !Number.isFinite(value) || value < 0 || value > 1) return;
    this.points.update((points) => points.map((point, i) => i === index ? { ...point, [axis]: value } : point));
    this.dirty.set(true);
    this.reviewConfirmation.set(null);
    this.message.set('');
  }
  setIgnored(value: boolean) { this.ignored.set(value); this.dirty.set(true); this.reviewConfirmation.set(null); this.message.set(''); }
  resetLine() {
    this.points.set([{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }]);
    this.dirty.set(true);
    this.reviewConfirmation.set(null);
  }
  startDrag(event: PointerEvent) {
    if (this.running() || this.busy() || this.loading() || this.generatingPanorama() || this.panoramaDrag || this.item()?.missing || this.points().length !== 2 || event.button !== 0) return;
    event.preventDefault();
    const svg = event.currentTarget as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width, y = (event.clientY - rect.top) / rect.height;
    this.dragIndex = this.points().map((point) => Math.hypot(point.x - x, point.y - y)).reduce((best, distance, index, values) => distance < values[best] ? index : best, 0);
    svg.setPointerCapture(event.pointerId);
    this.drag(event);
  }
  drag(event: PointerEvent) {
    if (this.dragIndex === null) return;
    const rect = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
    this.editPoint(this.dragIndex, 'x', Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)));
    this.editPoint(this.dragIndex, 'y', Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)));
  }
  endDrag() { this.dragIndex = null; }

  async save(): Promise<boolean> {
    this.endPanoramaDrag();
    if (!this.dirty()) return true;
    const task = this.selected(), item = this.item();
    if (!task || !item || this.busy()) return false;
    this.busy.set(true);
    this.problem.set('');
    try {
      const points = this.points();
      const changedPoints = points.length !== item.points.length
        || points.some((point, index) => point.x !== item.points[index]?.x || point.y !== item.points[index]?.y);
      const result = await this.api.saveAnnotation(task.id, item.snapshotId, task.revision, this.ignored(), changedPoints ? points : undefined);
      if (this.destroyed) return false;
      this.setTask(result.task);
      this.items.update((items) => items.map((value) => value.snapshotId === item.snapshotId ? { ...result.item, missing: item.missing } : value));
      this.dirty.set(false);
      this.message.set('标注已保存，请重新生成数据');
      return true;
    } catch (error) { this.problem.set(errorMessage(error)); return false; }
    finally { this.busy.set(false); }
  }

  async generate() {
    if (this.busy() || this.loading() || this.running() || this.generatingPanorama() || !await this.save()) return;
    const task = this.selected();
    if (!task) return;
    this.busy.set(true); this.problem.set(''); this.message.set('');
    this.reviewConfirmation.set(null);
    try {
      const result = await this.api.generateInstallation(task.id, task.revision);
      if (!this.destroyed) this.setTask(result);
    } catch (error) { this.problem.set(errorMessage(error)); }
    finally { this.busy.set(false); }
  }
  async apply() {
    const task = this.selected();
    if (!task || !task.resultId || this.busy() || this.loading() || this.dirty() || this.running() || this.generatingPanorama()
      || !this.sourceGroup() || this.coarse() || task.result?.status !== 'estimated') return;
    this.busy.set(true); this.problem.set(''); this.message.set('');
    try {
      const result = await this.api.applyInstallation(task.id, task.revision, task.resultId);
      if (this.destroyed) return;
      this.setTask(result.task);
      this.applied.emit(result.camera);
      this.message.set('四项安装参数已应用到摄像头配置');
    } catch (error) { this.problem.set(errorMessage(error)); }
    finally { this.busy.set(false); }
  }
  confirmHorizonReview(reviewed: boolean) {
    const task = this.selected();
    this.reviewConfirmation.set(reviewed && this.horizonReady() && task?.resultId
      ? { taskId: task.id, revision: task.revision, resultId: task.resultId } : null);
  }
  async startHorizonScan() {
    if (this.busy() || this.loading() || this.running() || this.generatingPanorama() || !await this.save()) return;
    const task = this.selected();
    if (!task?.resultId || !this.horizonReady() || !this.horizonReviewed()) return;
    this.busy.set(true); this.problem.set(''); this.message.set('');
    try {
      const group = await this.api.startHorizonScan(task.id, task.revision, task.resultId);
      if (this.destroyed) return;
      this.reviewConfirmation.set(null);
      this.scanCreated.emit(group);
    } catch (error) { this.reviewConfirmation.set(null); this.problem.set(errorMessage(error)); }
    finally { this.busy.set(false); }
  }
  async cancel() {
    const task = this.selected();
    if (!task || this.busy() || this.loading()) return;
    this.busy.set(true);
    try { this.setTask(await this.api.cancelRecognition(task.id)); }
    catch (error) { this.problem.set(errorMessage(error)); }
    finally { this.busy.set(false); }
  }
  async recreate() {
    const task = this.selected();
    if (!task || this.busy() || this.loading() || this.generatingPanorama() || !await this.save()) return;
    this.busy.set(true); this.problem.set('');
    try {
      const created = await this.api.createRecognition(task.sourceTaskId);
      if (!this.destroyed) { this.setTask(created); this.items.set([]); this.nextItemOffset.set(null); this.selectItem(); }
    } catch (error) { this.problem.set(errorMessage(error)); }
    finally { this.busy.set(false); }
  }
  residual(snapshotId: string) { return this.selected()?.result?.diagnostics?.perSnapshot.find((item) => item.snapshotId === snapshotId)?.rmsResidualPixels; }
  ngOnDestroy() { this.destroyed = true; this.revision++; clearInterval(this.timer); this.clearPanorama(); }
}
