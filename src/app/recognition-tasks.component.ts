import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output, computed, inject, signal } from '@angular/core';
import type { OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, errorMessage } from './api.service';
import { IconComponent } from './icon.component';
import type { Camera, HorizonPoint, RecognitionItem, RecognitionTask } from './models';

@Component({
  selector: 'app-recognition-tasks', standalone: true,
  imports: [DatePipe, DecimalPipe, FormsModule, IconComponent], changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './recognition-tasks.component.html', styleUrl: './recognition-tasks.component.css',
})
export class RecognitionTasksComponent implements OnInit, OnDestroy {
  @Input() taskId = '';
  @Output() readonly applied = new EventEmitter<Camera>();
  private readonly api = inject(ApiService);
  readonly tasks = signal<RecognitionTask[]>([]);
  readonly selected = signal<RecognitionTask | null>(null);
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
  readonly running = computed(() => ['queued', 'running'].includes(this.selected()?.status || ''));
  readonly fields = [
    { key: 'pAxisPitch', label: 'P 轴前后倾' }, { key: 'pAxisRoll', label: 'P 轴左右倾' },
    { key: 'tiltOffset', label: 'T 偏移' }, { key: 'imageRoll', label: '画面 Roll 修正' },
  ] as const;
  readonly statuses = { queued: '等待识别', running: '识别中', completed: '识别完成', failed: '识别失败', cancelled: '已取消', interrupted: '已中断' };
  private timer?: ReturnType<typeof setInterval>;
  private destroyed = false;
  private revision = 0;
  private dragIndex: number | null = null;

  ngOnInit() {
    void this.refresh();
    this.timer = setInterval(() => { if (this.running()) void this.refresh(); }, 2000);
  }

  async refresh() {
    if (this.busy() || this.loading() || this.dirty() || this.destroyed) return;
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
    const revision = ++this.revision;
    this.problem.set('');
    try {
      const page = await this.api.recognitionItems(id);
      if (this.destroyed || revision !== this.revision || this.dirty()) return;
      this.setTask(page.task);
      this.items.set(page.items);
      this.nextItemOffset.set(page.nextOffset);
      this.selectItem(page.items.find((item) => item.snapshotId === this.selectedItemId()) || page.items[0]);
    } catch (error) { if (!this.destroyed && revision === this.revision) this.problem.set(errorMessage(error)); }
  }

  private setTask(task: RecognitionTask) {
    this.selected.set(task);
    this.tasks.update((tasks) => tasks.some((item) => item.id === task.id)
      ? tasks.map((item) => item.id === task.id ? task : item) : [task, ...tasks]);
  }

  selectItem(item?: RecognitionItem) {
    this.selectedItemId.set(item?.snapshotId || '');
    this.points.set((item?.points || []).map((point) => ({ ...point })));
    this.ignored.set(item?.ignored ?? true);
    this.dirty.set(false);
    this.dragIndex = null;
  }

  async openItem(item: RecognitionItem) { if (!this.busy() && await this.save()) this.selectItem(item); }
  undo() { const item = this.item(); if (item) this.selectItem(item); }

  async loadMore(kind: 'tasks' | 'items') {
    if (this.loading() || this.busy()) return;
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
    this.message.set('');
  }
  setIgnored(value: boolean) { this.ignored.set(value); this.dirty.set(true); this.message.set(''); }
  resetLine() {
    this.points.set([{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }]);
    this.dirty.set(true);
  }
  startDrag(event: PointerEvent) {
    if (this.running() || this.busy() || this.item()?.missing || this.points().length !== 2 || event.button !== 0) return;
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
    if (this.busy() || this.running() || !await this.save()) return;
    const task = this.selected();
    if (!task) return;
    this.busy.set(true); this.problem.set(''); this.message.set('');
    try {
      const result = await this.api.generateInstallation(task.id, task.revision);
      if (!this.destroyed) this.setTask(result);
    } catch (error) { this.problem.set(errorMessage(error)); }
    finally { this.busy.set(false); }
  }
  async apply() {
    const task = this.selected();
    if (!task || !task.resultId || this.busy() || this.dirty() || task.result?.status !== 'estimated') return;
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
  async cancel() {
    const task = this.selected();
    if (!task || this.busy()) return;
    this.busy.set(true);
    try { this.setTask(await this.api.cancelRecognition(task.id)); }
    catch (error) { this.problem.set(errorMessage(error)); }
    finally { this.busy.set(false); }
  }
  async recreate() {
    const task = this.selected();
    if (!task || this.busy() || !await this.save()) return;
    this.busy.set(true); this.problem.set('');
    try {
      const created = await this.api.createRecognition(task.sourceTaskId);
      if (!this.destroyed) { this.setTask(created); this.items.set([]); this.nextItemOffset.set(null); this.selectItem(); }
    } catch (error) { this.problem.set(errorMessage(error)); }
    finally { this.busy.set(false); }
  }
  residual(snapshotId: string) { return this.selected()?.result?.diagnostics?.perSnapshot.find((item) => item.snapshotId === snapshotId)?.rmsResidualPixels; }
  ngOnDestroy() { this.destroyed = true; this.revision++; clearInterval(this.timer); }
}
