import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, EventEmitter, Output, inject, signal } from '@angular/core';
import type { OnDestroy, OnInit } from '@angular/core';
import { ApiService, errorMessage } from './api.service';
import { SnapshotItemComponent } from './snapshot-item.component';
import { snapshotTaskStatus } from './models';
import { renderTaskPanorama } from './task-panorama';
import type { Snapshot, SnapshotGroup } from './models';

@Component({
  selector: 'app-snapshot-tasks',
  standalone: true,
  imports: [DatePipe, DecimalPipe, SnapshotItemComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './snapshot-tasks.component.html',
  styleUrl: './snapshot-tasks.component.css',
})
export class SnapshotTasksComponent implements OnInit, OnDestroy {
  @Output() readonly opened = new EventEmitter<Snapshot>();
  @Output() readonly removed = new EventEmitter<Snapshot>();
  @Output() readonly changed = new EventEmitter<void>();
  @Output() readonly recognitionCreated = new EventEmitter<string>();
  private readonly api = inject(ApiService);
  readonly tasks = signal<SnapshotGroup[]>([]);
  readonly selected = signal<SnapshotGroup | null>(null);
  readonly snapshots = signal<Snapshot[]>([]);
  readonly nextTaskOffset = signal<number | null>(null);
  readonly nextSnapshotOffset = signal<number | null>(null);
  readonly loading = signal(false);
  readonly acting = signal(false);
  readonly problem = signal('');
  readonly statuses = snapshotTaskStatus;
  readonly panorama = signal<{ url: string; width: number; height: number; count: number } | null>(null);
  readonly generatingPanorama = signal(false);
  readonly panoramaProgress = signal('');
  readonly panoramaError = signal('');
  private panoramaController?: AbortController;
  private timer?: ReturnType<typeof setInterval>;
  private destroyed = false;
  private detailRevision = 0;

  ngOnInit() {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 2000);
  }

  async refresh() {
    if (this.loading() || this.acting() || this.generatingPanorama() || this.destroyed) return;
    this.loading.set(true);
    const selectedId = this.selected()?.id;
    const revision = this.detailRevision;
    try {
      const page = await this.api.snapshotTasks();
      if (this.destroyed) return;
      const freshIds = new Set(page.groups.map((group) => group.id));
      this.tasks.update((tasks) => [...page.groups, ...tasks.filter((task) => !freshIds.has(task.id))]);
      this.nextTaskOffset.set(this.tasks().length < page.total ? this.tasks().length : null);
      if (selectedId && selectedId === this.selected()?.id && revision === this.detailRevision) {
        const group = await this.api.snapshotGroup(selectedId);
        if (this.destroyed || revision !== this.detailRevision) return;
        const previous = this.selected();
        this.selected.set(group);
        if (previous?.snapshotCount !== group.snapshotCount || previous.status !== group.status) {
          this.clearPanorama();
          const images = await this.api.groupSnapshots(group.id, 0, Math.min(100, Math.max(50, this.snapshots().length)));
          if (!this.destroyed && revision === this.detailRevision) {
            this.snapshots.set(images.snapshots);
            this.nextSnapshotOffset.set(images.nextOffset);
          }
        }
      } else if (!this.selected() && page.groups.length) {
        await this.selectTask(page.groups[0]);
      }
    } catch (error) {
      if (!this.destroyed) this.problem.set(errorMessage(error));
    } finally { this.loading.set(false); }
  }

  async selectTask(group: SnapshotGroup) {
    this.clearPanorama();
    const revision = ++this.detailRevision;
    this.selected.set(group);
    this.snapshots.set([]);
    this.nextSnapshotOffset.set(null);
    this.problem.set('');
    try {
      const page = await this.api.groupSnapshots(group.id);
      if (this.destroyed || revision !== this.detailRevision) return;
      this.selected.set(page.group);
      this.snapshots.set(page.snapshots);
      this.nextSnapshotOffset.set(page.nextOffset);
    } catch (error) {
      if (revision === this.detailRevision && !this.destroyed) this.problem.set(errorMessage(error));
    }
  }

  async loadMoreTasks() {
    const offset = this.nextTaskOffset();
    if (offset === null || this.loading()) return;
    this.loading.set(true);
    try {
      const page = await this.api.snapshotTasks(offset);
      if (this.destroyed) return;
      const ids = new Set(this.tasks().map((task) => task.id));
      this.tasks.update((tasks) => [...tasks, ...page.groups.filter((task) => !ids.has(task.id))]);
      this.nextTaskOffset.set(page.nextOffset);
    } catch (error) { this.problem.set(errorMessage(error)); }
    finally { this.loading.set(false); }
  }

  async loadMoreSnapshots() {
    const offset = this.nextSnapshotOffset();
    const group = this.selected();
    if (offset === null || !group || this.loading()) return;
    const revision = this.detailRevision;
    this.loading.set(true);
    try {
      const page = await this.api.groupSnapshots(group.id, offset);
      if (this.destroyed || revision !== this.detailRevision) return;
      const ids = new Set(this.snapshots().map((snapshot) => snapshot.id));
      this.snapshots.update((snapshots) => [...snapshots, ...page.snapshots.filter((snapshot) => !ids.has(snapshot.id))]);
      this.nextSnapshotOffset.set(page.nextOffset);
    } catch (error) { this.problem.set(errorMessage(error)); }
    finally { this.loading.set(false); }
  }

  async act(action: 'pause' | 'start' | 'cancel') {
    const group = this.selected();
    if (!group || this.acting() || this.generatingPanorama()) return;
    this.acting.set(true);
    this.problem.set('');
    try {
      const updated = await this.api.taskAction(group.id, action);
      if (this.destroyed) return;
      this.tasks.update((tasks) => tasks.map((task) => task.id === updated.id ? updated : task));
      if (this.selected()?.id === updated.id) await this.selectTask(updated);
      this.changed.emit();
    } catch (error) { this.problem.set(errorMessage(error)); }
    finally { this.acting.set(false); }
  }

  async deleteSnapshot(snapshot: Snapshot) {
    if (this.acting() || this.generatingPanorama()) return;
    this.acting.set(true);
    this.problem.set('');
    try {
      await this.api.deleteSnapshot(snapshot.id);
      if (this.destroyed) return;
      this.removed.emit(snapshot);
      const group = this.selected();
      if (group) await this.selectTask(await this.api.snapshotGroup(group.id));
      this.changed.emit();
    } catch (error) { this.problem.set(errorMessage(error)); }
    finally { this.acting.set(false); }
  }

  clearPanorama() {
    this.panoramaController?.abort();
    this.panoramaController = undefined;
    const previous = this.panorama();
    if (previous) URL.revokeObjectURL(previous.url);
    this.panorama.set(null);
    this.generatingPanorama.set(false);
    this.panoramaProgress.set('');
    this.panoramaError.set('');
  }

  async generatePanorama() {
    const group = this.selected();
    if (!group || this.acting() || this.generatingPanorama() || group.snapshotCount < 2
      || ['running', 'pausing'].includes(group.status)) return;
    this.clearPanorama();
    const controller = new AbortController();
    this.panoramaController = controller;
    this.generatingPanorama.set(true);
    try {
      const snapshots: Snapshot[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        controller.signal.throwIfAborted();
        this.panoramaProgress.set(`正在读取截图记录 ${snapshots.length} / ${group.snapshotCount}`);
        const page = await this.api.groupSnapshots(group.id, offset, 100);
        controller.signal.throwIfAborted();
        if (page.total !== group.snapshotCount || ['running', 'pausing'].includes(page.group.status)) {
          throw new Error('任务截图已变化，请暂停任务并刷新后重新生成');
        }
        snapshots.push(...page.snapshots);
        offset = page.nextOffset;
      }
      if (snapshots.length !== group.snapshotCount) throw new Error('任务截图数量已变化，请刷新后重新生成');
      const result = await renderTaskPanorama(snapshots, controller.signal, (done, total) => {
        this.panoramaProgress.set(`正在拼接 ${done} / ${total}`);
      });
      const latest = await this.api.snapshotGroup(group.id);
      controller.signal.throwIfAborted();
      if (latest.snapshotCount !== group.snapshotCount || latest.completedCount !== group.completedCount
        || ['running', 'pausing'].includes(latest.status)) throw new Error('任务截图已变化，请刷新后重新生成');
      this.panorama.set({ url: URL.createObjectURL(result.blob), width: result.width, height: result.height, count: result.count });
    } catch (error) {
      if (!controller.signal.aborted) this.panoramaError.set(errorMessage(error));
    } finally {
      if (this.panoramaController === controller) {
        this.panoramaController = undefined;
        this.generatingPanorama.set(false);
        this.panoramaProgress.set('');
      }
    }
  }

  async createRecognition() {
    const task = this.selected();
    if (!task || this.acting() || this.generatingPanorama()) return;
    this.acting.set(true); this.problem.set('');
    try {
      const created = await this.api.createRecognition(task.id);
      if (!this.destroyed) this.recognitionCreated.emit(created.id);
    } catch (error) { this.problem.set(errorMessage(error)); }
    finally { this.acting.set(false); }
  }

  ngOnDestroy() { this.destroyed = true; clearInterval(this.timer); this.clearPanorama(); }
}
