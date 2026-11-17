import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, ElementRef, EventEmitter, Input, Output, ViewChild, computed, inject, signal } from '@angular/core';
import type { OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, errorMessage } from './api.service';
import { IconComponent } from './icon.component';
import type { Camera, HorizonPoint, RecognitionItem, RecognitionTask, SnapshotGroup } from './models';
import { addPanoramaGuideNode, createPanoramaFrame, extendHorizonLine, imagePointToPanoramaPoint, movePanoramaEndpoint,
  panoramaGuideHeadingOffset, panoramaPixelToPoint, panoramaPointToImagePoint, panoramaPointToPixel, projectImageLine,
  panoramaGuidePointLimit, projectPanoramaGuide, projectPanoramaLine, removePanoramaGuideNode, samplePanoramaGuide } from './panorama-math';
import type { PanoramaFrame, PanoramaPlan } from './panorama-math';
import { renderTaskPanorama, renderTaskPanoramaFrame } from './task-panorama';
import type { PanoramaGuide, PanoramaGuidePoint } from '../../shared/panorama-guide';

@Component({
  selector: 'app-recognition-tasks', standalone: true,
  imports: [DatePipe, DecimalPipe, FormsModule, IconComponent], changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './recognition-tasks.component.html', styleUrl: './recognition-tasks.component.css',
})
export class RecognitionTasksComponent implements OnInit, OnDestroy {
  @Input() taskId = '';
  @Output() readonly applied = new EventEmitter<Camera>();
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
  readonly panoramaFocused = signal(false);
  readonly focusedImage = signal<{ snapshotId: string; url: string } | null>(null);
  readonly loadingFocusedImage = signal(false);
  readonly focusedImageError = signal('');
  readonly showPanoramaLines = signal(true);
  readonly showNeighbors = signal(true);
  readonly showGuide = signal(true);
  readonly guide = signal<PanoramaGuide | null>(null);
  readonly guideDirty = signal(false);
  readonly guideInitialized = signal(false);
  readonly guideError = signal('');
  readonly activeGuidePoint = signal(1);
  readonly canAddGuideNode = computed(() => {
    const guide = this.guide();
    return !!guide && guide.kind !== 'line' && guide.points.length < panoramaGuidePointLimit;
  });
  readonly canRemoveGuideNode = computed(() => {
    const guide = this.guide(), index = this.activeGuidePoint();
    return guide?.kind === 'bezier' && index > 0 && index < guide.points.length - 1 && index % 2 === 0;
  });
  readonly guideValidation = computed(() => {
    const guide = this.guide();
    if (!guide) return '';
    const headings = guide.points.map((point) => point.heading);
    if (Math.max(...headings) - Math.min(...headings) > 2 * Math.PI) return '参考线的全部节点和控制点不能超过一周方位';
    return Math.abs(guide.points[0].heading - guide.points[guide.points.length - 1].heading) <= 1e-9
      ? '参考线没有有效方位跨度，请调整起点或终点' : '';
  });
  readonly guideDrawing = signal<'line' | 'quadratic' | null>(null);
  readonly guidePreview = signal<PanoramaGuide | null>(null);
  readonly singleImageId = signal('');
  readonly singleImageError = signal('');
  readonly hasDraft = computed(() => this.dirty() || this.guideDirty());
  readonly navigation = computed(() => {
    const entries = this.items(), index = entries.findIndex((entry) => entry.snapshotId === this.selectedItemId());
    return {
      previous: index < 0 ? undefined : entries.slice(0, index).reverse().find((entry) => !entry.missing),
      next: index < 0 ? undefined : entries.slice(index + 1).find((entry) => !entry.missing),
    };
  });
  readonly neighbors = computed(() => {
    const current = this.item();
    if (!current) return [];
    const entries = this.items(), index = entries.findIndex((entry) => entry.snapshotId === current.snapshotId);
    return [{ side: 'previous', label: '上一张', entry: entries[index - 1] },
      { side: 'next', label: '下一张', entry: entries[index + 1] }].map(({ side, label, entry }) => {
      const reference = { side, label, snapshotId: entry?.snapshotId || '', ignored: entry?.ignored || false,
        state: '', lines: [] as string[], endpoints: [] as HorizonPoint[] };
      if (!entry) { reference.state = '无相邻截图'; return reference; }
      if (entry.missing) { reference.state = '原图已删除'; return reference; }
      if (entry.points.length !== 2) { reference.state = '无有效标注'; return reference; }
      if (current.missing) { reference.state = '当前原图已删除'; return reference; }
      try {
        const target = createPanoramaFrame(current.snapshot);
        const source = createPanoramaFrame(entry.snapshot, target.heading);
        reference.lines = projectImageLine(source, target, extendHorizonLine(entry.points))
          .map((points) => this.imageLinePoints(points, current));
        reference.endpoints = entry.points.flatMap((point) => {
          const direction = imagePointToPanoramaPoint(source, point);
          const projected = direction && panoramaPointToImagePoint(target, direction);
          return projected ? [projected] : [];
        });
        reference.state = [entry.ignored ? '已忽略' : '',
          reference.lines.length || reference.endpoints.length ? '' : '无可见重叠'].filter(Boolean).join(' · ') || '可见参照';
      } catch (error) { reference.state = error instanceof Error ? error.message : errorMessage(error); }
      return reference;
    });
  });
  readonly singleGuide = computed(() => {
    const current = this.item(), guide = this.guide();
    if (!current || current.missing || !guide) return { lines: [] as string[], error: '' };
    try {
      return { lines: projectPanoramaGuide(createPanoramaFrame(current.snapshot), guide)
        .map((points) => this.imageLinePoints(points, current)), error: '' };
    } catch (error) {
      return { lines: [] as string[], error: error instanceof Error ? error.message : errorMessage(error) };
    }
  });
  readonly panoramaGuide = computed(() => {
    const image = this.panorama(), guide = this.guidePreview() || this.guide();
    if (!image || !guide) return null;
    const offset = this.guideHeadingOffset() ?? panoramaGuideHeadingOffset(image.plan, guide);
    const pixel = (point: PanoramaGuidePoint) => panoramaPointToPixel(image.plan, { ...point, heading: point.heading + offset });
    const points = samplePanoramaGuide(guide).map(pixel);
    const controls = guide.points.map(pixel);
    return { points: points.map((point) => `${point.x},${point.y}`).join(' '), controls,
      controlPolygon: controls.map((point) => `${point.x},${point.y}`).join(' ') };
  });
  readonly activePanoramaEndpoint = signal(0);
  readonly panoramaLines = computed(() => {
    const image = this.panorama();
    if (!image) return [];
    const entries = new Map(this.items().map((entry) => [entry.snapshotId, entry]));
    return image.plan.frames.flatMap((frame) => {
      const entry = entries.get(frame.snapshot.id);
      if (!entry || entry.missing) return [];
      const current = entry.snapshotId === this.selectedItemId();
      const sourcePoints = extendHorizonLine(current ? this.points() : entry.points, current && this.panoramaFocused() ? 0.03 : 0);
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
    if (!image || !frame || !this.panoramaFocused()) return '';
    const corners = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    return corners.flatMap((point, index) => projectPanoramaLine(image.plan, frame, [point, corners[(index + 1) % 4]]))
      .map((point) => `${point.x},${point.y}`).join(' ');
  });
  readonly running = computed(() => ['queued', 'running'].includes(this.selected()?.status || ''));
  readonly coarse = computed(() => this.sourceGroup()?.horizon?.phase === 'coarse');
  readonly fields = [
    { key: 'pAxisPitch', label: 'P 轴前后倾' }, { key: 'pAxisRoll', label: 'P 轴左右倾' },
    { key: 'tiltOffset', label: 'T 偏移' }, { key: 'imageRoll', label: '画面 Roll 修正' },
  ] as const;
  readonly statuses = { queued: '等待识别', running: '识别中', completed: '识别完成', failed: '识别失败', cancelled: '已取消', interrupted: '已中断' };
  private timer?: ReturnType<typeof setInterval>;
  private destroyed = false;
  private revision = 0;
  private guideRevision = 0;
  private savedGuide: PanoramaGuide | null = null;
  private dragIndex: number | null = null;
  private panoramaController?: AbortController;
  private focusedImageController?: AbortController;
  private readonly guideHeadingOffset = signal<number | null>(null);
  private guideDrag: { pointerId: number; stage: HTMLElement; index: number | null;
    start: { x: number; y: number }; kind: PanoramaGuide['kind']; headingOffset: number } | null = null;
  private panoramaDrag: { pointerId: number; index: number; stage: HTMLElement; frame: PanoramaFrame;
    points: HorizonPoint[]; startY: number; lastY: number } | null = null;

  ngOnInit() {
    void this.refresh();
    this.timer = setInterval(() => { if (this.running()) void this.refresh(); }, 2000);
  }

  async refresh() {
    if (this.busy() || this.loading() || this.hasDraft() || this.generatingPanorama() || this.destroyed) return;
    this.loading.set(true);
    const revision = this.revision;
    this.problem.set('');
    try {
      const page = await this.api.recognitionTasks();
      if (this.destroyed || revision !== this.revision || this.hasDraft()) return;
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
    this.guideInitialized.set(false);
    this.guideError.set('');
    try {
      const [itemsResult, guideResult] = await Promise.allSettled([
        this.api.recognitionItems(id), this.api.recognitionPanoramaGuide(id),
      ]);
      if (itemsResult.status === 'rejected') throw itemsResult.reason;
      const page = itemsResult.value, entries = [...page.items];
      let offset = page.nextOffset;
      // 识别停止后只补齐条目元数据，单图参照和导航不依赖是否已生成全景。
      while (!['queued', 'running'].includes(page.task.status) && offset !== null) {
        const next = await this.api.recognitionItems(id, offset);
        if (this.destroyed || revision !== this.revision) return;
        if (next.task.revision !== page.task.revision || next.task.updatedAt !== page.task.updatedAt || next.total !== page.total) {
          throw new Error('识别任务或标注已变化，请刷新后重新读取');
        }
        entries.push(...next.items);
        offset = next.nextOffset;
      }
      if (this.destroyed || revision !== this.revision || this.hasDraft()) return;
      this.setTask(page.task);
      this.items.set(entries);
      this.nextItemOffset.set(offset);
      this.selectItem(entries.find((item) => item.snapshotId === this.selectedItemId()) || entries[0]);
      if (guideResult.status === 'fulfilled') {
        this.guide.set(structuredClone(guideResult.value.guide));
        this.savedGuide = structuredClone(guideResult.value.guide);
        this.guideRevision = guideResult.value.revision;
        this.guideDirty.set(false);
        this.guideInitialized.set(true);
      } else {
        this.guide.set(null);
        this.guideError.set(`全景参考线读取失败：${errorMessage(guideResult.reason)}`);
      }
      const sourceGroup = await this.api.snapshotGroup(page.task.sourceTaskId);
      if (!this.destroyed && revision === this.revision) this.sourceGroup.set(sourceGroup);
    } catch (error) {
      if (!this.destroyed && revision === this.revision) this.problem.set(error instanceof Error && error.name === 'Error' ? error.message : errorMessage(error));
    }
    finally { if (revision === this.revision) this.loading.set(false); }
  }

  private setTask(task: RecognitionTask) {
    const previous = this.selected();
    if (previous?.id !== task.id) {
      this.clearPanorama();
      this.guide.set(null);
      this.savedGuide = null;
      this.guideRevision = 0;
      this.guideDirty.set(false);
      this.guideInitialized.set(false);
      this.guideError.set('');
    }
    if (previous?.sourceTaskId !== task.sourceTaskId) this.sourceGroup.set(null);
    this.selected.set(task);
    this.tasks.update((tasks) => tasks.some((item) => item.id === task.id)
      ? tasks.map((item) => item.id === task.id ? task : item) : [task, ...tasks]);
  }

  selectItem(item?: RecognitionItem) {
    this.endPanoramaDrag();
    if (item?.snapshotId !== this.selectedItemId()) {
      this.activePanoramaEndpoint.set(0);
      this.clearFocusedImage();
      this.singleImageId.set('');
      this.singleImageError.set('');
    }
    this.selectedItemId.set(item?.snapshotId || '');
    this.points.set((item?.points || []).map((point) => ({ ...point })));
    this.ignored.set(item?.ignored ?? true);
    this.dirty.set(false);
    this.dragIndex = null;
  }

  async openItem(item: RecognitionItem) {
    if (!this.busy() && !this.loading() && !this.guideDrawing() && await this.save()) {
      this.selectItem(this.items().find((entry) => entry.snapshotId === item.snapshotId) || item);
      if (this.panorama()) this.showFocusedPanorama();
      this.focusPanorama();
    }
  }
  undo() { const item = this.item(); if (item) this.selectItem(item); }

  openPanoramaItem(snapshotId: string) {
    if (this.guideDrawing()) return;
    if (snapshotId === this.selectedItemId()) { this.showFocusedPanorama(); this.focusPanorama(); return; }
    const entry = this.items().find((item) => item.snapshotId === snapshotId);
    if (entry) void this.openItem(entry);
  }

  clearPanorama() {
    this.endPanoramaDrag();
    this.endGuideDrag(undefined, false);
    this.guideDrawing.set(null);
    this.clearFocusedImage();
    this.panoramaController?.abort();
    this.panoramaController = undefined;
    const previous = this.panorama();
    if (previous) URL.revokeObjectURL(previous.url);
    this.panorama.set(null);
    this.generatingPanorama.set(false);
    this.panoramaProgress.set('');
    this.panoramaError.set('');
    this.panoramaExpanded.set(false);
    this.panoramaFocused.set(false);
    this.activePanoramaEndpoint.set(0);
  }

  navigate(direction: 'previous' | 'next') {
    const entry = this.navigation()[direction];
    if (entry) void this.openItem(entry);
  }

  showOverview() {
    this.endPanoramaDrag();
    this.panoramaFocused.set(false);
    this.clearFocusedImage();
  }

  showFocusedPanorama() {
    if (!this.panorama() || this.item()?.missing || !this.item()) return;
    this.endGuideDrag(undefined, false);
    this.guideDrawing.set(null);
    this.panoramaFocused.set(true);
    void this.loadFocusedImage();
    this.positionPanoramaFrame();
  }

  private clearFocusedImage() {
    this.focusedImageController?.abort();
    this.focusedImageController = undefined;
    const previous = this.focusedImage();
    if (previous) URL.revokeObjectURL(previous.url);
    this.focusedImage.set(null);
    this.loadingFocusedImage.set(false);
    this.focusedImageError.set('');
  }

  private async loadFocusedImage() {
    const image = this.panorama(), snapshotId = this.selectedItemId(), taskId = this.selected()?.id;
    if (!image || !this.panoramaFocused() || this.focusedImage()?.snapshotId === snapshotId) return;
    this.clearFocusedImage();
    const frame = image.plan.frames.find((entry) => entry.snapshot.id === snapshotId);
    if (!frame) { this.focusedImageError.set('当前截图不在全景中，请重新生成全景图'); return; }
    const controller = new AbortController();
    this.focusedImageController = controller;
    this.loadingFocusedImage.set(true);
    try {
      const result = await renderTaskPanoramaFrame(image.plan, frame, controller.signal);
      if (this.destroyed || controller.signal.aborted || this.focusedImageController !== controller
        || !this.panoramaFocused() || this.panorama() !== image || this.selected()?.id !== taskId || this.selectedItemId() !== snapshotId) return;
      this.focusedImage.set({ snapshotId, url: URL.createObjectURL(result.blob) });
    } catch (error) {
      if (!controller.signal.aborted && this.focusedImageController === controller) {
        this.focusedImageError.set(error instanceof Error ? error.message : errorMessage(error));
      }
    } finally {
      if (this.focusedImageController === controller) {
        this.focusedImageController = undefined;
        this.loadingFocusedImage.set(false);
      }
    }
  }

  private positionPanoramaFrame() {
    const snapshotId = this.selectedItemId(), image = this.panorama();
    requestAnimationFrame(() => {
      if (this.destroyed || !this.panoramaFocused() || this.selectedItemId() !== snapshotId || this.panorama() !== image) return;
      const viewport = this.panoramaViewport?.nativeElement, frame = image?.plan.frames.find((entry) => entry.snapshot.id === snapshotId);
      const stage = viewport?.querySelector<HTMLElement>('.panorama-stage');
      if (!viewport || !stage || !frame || !image) return;
      const scale = stage.clientWidth / image.width;
      const left = (frame.minHeading - image.plan.minHeading) * image.plan.scale * scale;
      const right = (frame.maxHeading - image.plan.minHeading) * image.plan.scale * scale;
      const top = (image.plan.maxY - frame.maxY) * image.plan.scale * scale;
      const bottom = (image.plan.maxY - frame.minY) * image.plan.scale * scale;
      // 只滚动全景容器，保持当前缩放及下方单图所在页面位置。
      if (left < viewport.scrollLeft || right > viewport.scrollLeft + viewport.clientWidth) viewport.scrollLeft = (left + right - viewport.clientWidth) / 2;
      if (top < viewport.scrollTop || bottom > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = (top + bottom - viewport.clientHeight) / 2;
    });
  }

  private imageLinePoints(points: HorizonPoint[], item: RecognitionItem) {
    return points.map((point) => `${point.x * item.snapshot.width},${point.y * item.snapshot.height}`).join(' ');
  }

  async reloadGuide() {
    const task = this.selected(), revision = this.revision;
    if (!task || this.busy() || this.loading() || this.guideDirty()) return;
    this.loading.set(true);
    this.guideInitialized.set(false);
    this.guideError.set('');
    try {
      const result = await this.api.recognitionPanoramaGuide(task.id);
      if (this.destroyed || revision !== this.revision || this.selected()?.id !== task.id) return;
      this.guide.set(structuredClone(result.guide));
      this.savedGuide = structuredClone(result.guide);
      this.guideRevision = result.revision;
      this.guideInitialized.set(true);
    } catch (error) {
      if (!this.destroyed && revision === this.revision) this.guideError.set(`全景参考线读取失败：${errorMessage(error)}`);
    } finally { if (revision === this.revision) this.loading.set(false); }
  }

  beginGuide(kind: 'line' | 'quadratic') {
    if (!this.guideInitialized() || !this.panorama() || this.busy() || this.loading() || this.running() || this.generatingPanorama()) return;
    this.endGuideDrag(undefined, false);
    this.showOverview();
    this.guideDrawing.set(kind);
    this.showGuide.set(true);
    this.focusPanorama();
  }

  cancelGuideDrawing() {
    this.endGuideDrag(undefined, false);
    this.guideDrawing.set(null);
  }

  undoGuide() {
    this.cancelGuideDrawing();
    this.guide.set(structuredClone(this.savedGuide));
    this.activeGuidePoint.set(1);
    this.guideDirty.set(false);
  }

  isGuideControl(index: number) { return this.guide()?.kind !== 'line' && index % 2 === 1; }

  guidePointLabel(index: number) {
    if (index === 0) return '参考线起点';
    if (index === (this.guide()?.points.length ?? 0) - 1) return '参考线终点';
    return this.isGuideControl(index) ? `弯曲控制点 ${(index + 1) / 2}` : `连接节点 ${index / 2}`;
  }

  addGuideNode() {
    const guide = this.guide();
    if (!guide || !this.canAddGuideNode() || !this.guideInitialized() || !this.panorama()
      || this.busy() || this.loading() || this.running() || this.generatingPanorama() || this.guideDrawing()) return;
    this.cancelGuideDrawing();
    const segment = Math.min((guide.points.length - 3) / 2, Math.max(0, Math.floor((this.activeGuidePoint() - 1) / 2)));
    this.setGuideDraft(addPanoramaGuideNode(guide, segment));
    this.activeGuidePoint.set(segment * 2 + 2);
    this.showGuide.set(true);
    this.showOverview();
  }

  removeGuideNode() {
    const guide = this.guide(), index = this.activeGuidePoint();
    if (!guide || !this.canRemoveGuideNode() || !this.guideInitialized() || !this.panorama()
      || this.busy() || this.loading() || this.running() || this.generatingPanorama() || this.guideDrawing()) return;
    this.cancelGuideDrawing();
    const reduced = removePanoramaGuideNode(guide, index), image = this.panorama()!;
    const offset = panoramaGuideHeadingOffset(image.plan, reduced), control = reduced.points[index - 1];
    const pixel = panoramaPointToPixel(image.plan, { ...control, heading: control.heading + offset });
    // 合并后的控制点可能越出画布，把新控制点留在可拖动范围内。
    const visible = panoramaPixelToPoint(image.plan, { x: Math.max(0, Math.min(image.width, pixel.x)),
      y: Math.max(0, Math.min(image.height, pixel.y)) });
    reduced.points[index - 1] = { ...visible, heading: visible.heading - offset };
    this.setGuideDraft(reduced);
    this.activeGuidePoint.set(index - 1);
    this.showGuide.set(true);
    this.showOverview();
  }

  deleteGuide() {
    if (!this.guideInitialized()) return;
    this.cancelGuideDrawing();
    this.setGuideDraft(null);
  }

  private setGuideDraft(guide: PanoramaGuide | null) {
    this.guide.set(guide);
    if (!guide || this.activeGuidePoint() >= guide.points.length) this.activeGuidePoint.set(1);
    this.guideDirty.set(JSON.stringify(guide) !== JSON.stringify(this.savedGuide));
    this.message.set('');
  }

  private panoramaPointer(event: PointerEvent, stage: HTMLElement) {
    const image = this.panorama(), rect = stage.getBoundingClientRect();
    if (!image || rect.width <= 0 || rect.height <= 0) return null;
    return { x: Math.max(0, Math.min(image.width, (event.clientX - rect.left) / rect.width * image.width)),
      y: Math.max(0, Math.min(image.height, (event.clientY - rect.top) / rect.height * image.height)) };
  }

  startGuideDraw(event: PointerEvent) {
    const kind = this.guideDrawing(), image = this.panorama();
    if (event.button !== 0 || event.defaultPrevented || !kind || !image || this.guideDrag || !this.guideInitialized()
      || this.panoramaFocused() || this.busy() || this.loading() || this.running() || this.generatingPanorama()) return;
    const stage = event.currentTarget as HTMLElement, start = this.panoramaPointer(event, stage);
    if (!start) return;
    event.preventDefault();
    const point = panoramaPixelToPoint(image.plan, start);
    this.guideDrag = { pointerId: event.pointerId, stage, index: null, start, kind, headingOffset: 0 };
    this.guidePreview.set(kind === 'line' ? { kind, points: [point, { ...point }] }
      : { kind, points: [point, { ...point }, { ...point }] });
    stage.setPointerCapture(event.pointerId);
  }

  startGuidePointDrag(event: PointerEvent, index: number) {
    const guide = this.guide(), image = this.panorama();
    if (event.button !== 0 || !guide?.points[index] || !image || this.guideDrag || this.guideDrawing() || !this.guideInitialized()
      || this.panoramaFocused() || this.busy() || this.loading() || this.running() || this.generatingPanorama()) return;
    const stage = (event.currentTarget as HTMLElement).parentElement;
    if (!stage) return;
    const start = this.panoramaPointer(event, stage);
    if (!start) return;
    event.preventDefault();
    event.stopPropagation();
    this.activeGuidePoint.set(index);
    this.guideDrag = { pointerId: event.pointerId, stage, index, start, kind: guide.kind,
      headingOffset: panoramaGuideHeadingOffset(image.plan, guide) };
    this.guideHeadingOffset.set(this.guideDrag.headingOffset);
    stage.setPointerCapture(event.pointerId);
  }

  dragGuide(event: PointerEvent) {
    const drag = this.guideDrag, image = this.panorama();
    if (!drag || drag.pointerId !== event.pointerId || !image) return;
    const pixel = this.panoramaPointer(event, drag.stage);
    if (!pixel) return;
    const point = panoramaPixelToPoint(image.plan, pixel);
    if (drag.index === null) {
      const start = panoramaPixelToPoint(image.plan, drag.start);
      this.guidePreview.set(drag.kind === 'line' ? { kind: 'line', points: [start, point] }
        : { kind: 'quadratic', points: [start,
          { heading: (start.heading + point.heading) / 2, elevation: (start.elevation + point.elevation) / 2 }, point] });
    } else {
      const guide = structuredClone(this.guide());
      if (!guide) return;
      point.heading -= drag.headingOffset;
      guide.points[drag.index] = point;
      this.setGuideDraft(guide);
    }
  }

  endGuideDrag(event?: PointerEvent, commit = true) {
    const drag = this.guideDrag;
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    this.guideDrag = null;
    const preview = this.guidePreview();
    if (drag.index === null && commit && preview) {
      const first = preview.points[0], last = preview.points[preview.points.length - 1];
      if (first.heading !== last.heading || first.elevation !== last.elevation) {
        this.setGuideDraft(preview);
        this.guideDrawing.set(null);
      }
    }
    this.guidePreview.set(null);
    this.guideHeadingOffset.set(null);
    if (drag.stage.hasPointerCapture(drag.pointerId)) drag.stage.releasePointerCapture(drag.pointerId);
  }

  imageLoaded(snapshotId: string) {
    if (snapshotId === this.selectedItemId()) { this.singleImageId.set(snapshotId); this.singleImageError.set(''); }
  }

  imageFailed(snapshotId: string) {
    if (snapshotId === this.selectedItemId()) {
      this.singleImageId.set('');
      this.singleImageError.set('当前原图加载失败，请检查截图文件后重试');
    }
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
      || this.running() || this.generatingPanorama() || this.item()?.missing || !this.panoramaFocused()
      || this.focusedImage()?.snapshotId !== this.selectedItemId() || this.guideDrawing() || this.guideDrag) return;
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
    if (event.key === 'Escape' && (this.guideDrawing() || this.guideDrag)) {
      event.preventDefault();
      this.cancelGuideDrawing();
      return;
    }
    if (this.busy() || this.loading() || this.running() || this.generatingPanorama() || this.item()?.missing
      || !this.showPanoramaLines() || !this.panoramaFocused() || this.focusedImage()?.snapshotId !== this.selectedItemId()
      || this.guideDrawing() || this.guideDrag || this.panoramaDrag || this.dragIndex !== null || event.ctrlKey || event.metaKey) return;
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
    this.message.set('');
  }
  setIgnored(value: boolean) { this.ignored.set(value); this.dirty.set(true); this.message.set(''); }
  resetLine() {
    this.points.set([{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }]);
    this.dirty.set(true);
  }
  startDrag(event: PointerEvent) {
    if (this.running() || this.busy() || this.loading() || this.generatingPanorama() || this.panoramaDrag || this.guideDrawing()
      || this.guideDrag || this.item()?.missing || this.singleImageId() !== this.selectedItemId() || this.points().length !== 2 || event.button !== 0) return;
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

  async save(annotations = true): Promise<boolean> {
    this.endPanoramaDrag();
    this.endGuideDrag();
    this.guideDrawing.set(null);
    const saveAnnotation = annotations && this.dirty(), saveGuide = this.guideDirty();
    if (!saveAnnotation && !saveGuide) return true;
    if (saveGuide && this.guideValidation()) { this.problem.set(this.guideValidation()); return false; }
    const task = this.selected(), item = this.item();
    if (!task || (saveAnnotation && !item) || (saveGuide && !this.guideInitialized()) || this.busy()) return false;
    this.busy.set(true);
    this.problem.set('');
    try {
      if (saveAnnotation && item) {
        const points = this.points();
        const changedPoints = points.length !== item.points.length
          || points.some((point, index) => point.x !== item.points[index]?.x || point.y !== item.points[index]?.y);
        const result = await this.api.saveAnnotation(task.id, item.snapshotId, task.revision, this.ignored(), changedPoints ? points : undefined);
        if (this.destroyed) return false;
        this.setTask(result.task);
        this.items.update((items) => items.map((value) => value.snapshotId === item.snapshotId ? { ...result.item, missing: item.missing } : value));
        this.dirty.set(false);
      }
      if (saveGuide) {
        const result = await this.api.savePanoramaGuide(task.id, this.guideRevision, this.guide());
        if (this.destroyed) return false;
        this.guide.set(structuredClone(result.guide));
        this.savedGuide = structuredClone(result.guide);
        this.guideRevision = result.revision;
        this.guideDirty.set(false);
      }
      this.message.set(saveAnnotation ? `${saveGuide ? '标注和全景参考线' : '标注'}已保存，请重新生成安装参数` : '全景参考线已保存');
      return true;
    } catch (error) { this.problem.set(errorMessage(error)); return false; }
    finally { this.busy.set(false); }
  }

  saveGuide() { return this.save(false); }

  async generate() {
    if (this.busy() || this.loading() || this.running() || this.generatingPanorama() || !await this.save()) return;
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
