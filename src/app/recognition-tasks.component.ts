import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, ElementRef, EventEmitter, Input, Output, ViewChild, computed, effect, inject, signal, viewChild } from '@angular/core';
import type { OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, errorMessage } from './api.service';
import { IconComponent } from './icon.component';
import type { Camera, HorizonPoint, InstallationValidation, RecognitionItem, RecognitionTask, RefinementMeasurement, SnapshotGroup,
  ZeroPoseMeasurement } from './models';
import { addPanoramaGuideNode, createPanoramaFrame, extendHorizonLine, imagePointToPanoramaPoint, movePanoramaEndpoint,
  panoramaGuideHeadingOffset, panoramaPixelToPoint, panoramaPointToImagePoint, panoramaPointToPixel, projectImageLine,
  panoramaGuidePointLimit, projectPanoramaGuide, projectPanoramaLine, removePanoramaGuideNode, samplePanoramaGuide } from './panorama-math';
import type { PanoramaFrame, PanoramaPlan } from './panorama-math';
import { fullHorizonView, horizonPixelStep, horizonUpperClip, horizonView, shiftHorizonPixels,
  zoomHorizonView } from './horizon-precision';
import type { HorizonAdjustment, HorizonView } from './horizon-precision';
import { renderTaskPanorama, renderTaskPanoramaFrame } from './task-panorama';
import type { PanoramaGuide, PanoramaGuidePoint } from '../../shared/panorama-guide';

interface ValidationSource {
  key: string; kind: 'ordinary' | 'refinement'; task: RecognitionTask; resultId: string;
  installation: InstallationValidation['installation']; sourceSnapshotIds: string[];
}

@Component({
  selector: 'app-recognition-tasks', standalone: true,
  imports: [DatePipe, DecimalPipe, FormsModule, IconComponent], changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './recognition-tasks.component.html', styleUrl: './recognition-tasks.component.css',
})
export class RecognitionTasksComponent implements OnInit, OnDestroy {
  @Input() taskId = '';
  @Output() readonly applied = new EventEmitter<Camera>();
  private readonly annotationCanvas = viewChild<ElementRef<SVGSVGElement>>('annotationCanvas');
  @ViewChild('panoramaViewport') private panoramaViewport?: ElementRef<HTMLDivElement>;
  private readonly api = inject(ApiService);
  readonly tasks = signal<RecognitionTask[]>([]);
  readonly selected = signal<RecognitionTask | null>(null);
  readonly sourceGroup = signal<SnapshotGroup | null>(null);
  readonly items = signal<RecognitionItem[]>([]);
  readonly selectedItemId = signal('');
  readonly item = computed(() => this.items().find((item) => item.snapshotId === this.selectedItemId()) || null);
  // 外部参与图只用于当前候选的只读对照，不进入主任务的标注草稿和保存路径。
  readonly sourceImage = signal<{ task: RecognitionTask; item: RecognitionItem } | null>(null);
  readonly displayedItem = computed(() => this.sourceImage()?.item || this.item());
  readonly displayedPoints = computed(() => this.sourceImage()?.item.points || this.points());
  readonly points = signal<HorizonPoint[]>([]);
  readonly ignored = signal(false);
  readonly precisionMode = signal(false);
  readonly precisionActive = computed(() => this.precisionMode() && !this.sourceImage());
  readonly precisionView = signal<HorizonView>(fullHorizonView);
  private readonly annotationSize = signal<{ width: number; height: number } | null>(null);
  readonly precisionStep = computed(() => {
    const size = this.annotationSize(), snapshot = this.displayedItem()?.snapshot;
    return size && snapshot ? horizonPixelStep(this.precisionView().zoom, snapshot, size) : null;
  });
  readonly precisionTarget = signal<HorizonAdjustment>('line');
  readonly precisionZooms = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048];
  readonly precisionTargets = [{ value: 'line', label: '整线' }, { value: 0, label: '端点 1' }, { value: 1, label: '端点 2' }] as const;
  readonly originalView = computed(() => this.precisionActive() ? this.precisionView() : fullHorizonView);
  readonly originalViewBox = computed(() => {
    const { width = 1, height = 1 } = this.displayedItem()?.snapshot ?? {};
    const { left, top, zoom } = this.originalView();
    return `${left * width} ${top * height} ${width / zoom} ${height / zoom}`;
  });
  readonly originalLineClip = computed(() => {
    const snapshot = this.displayedItem()?.snapshot;
    return snapshot ? horizonUpperClip(this.displayedPoints(), snapshot.width, snapshot.height) : '';
  });
  readonly originalEditable = computed(() => !this.sourceImage() && !this.running() && !this.busy() && !this.loading()
    && !this.generatingPanorama() && !this.guideDrawing() && !!this.item() && !this.item()?.missing
    && this.singleImageId() === this.selectedItemId());
  readonly dirty = signal(false);
  readonly busy = signal(false);
  readonly loading = signal(false);
  readonly problem = signal('');
  readonly message = signal('');
  readonly nextTaskOffset = signal<number | null>(null);
  readonly nextItemOffset = signal<number | null>(null);
  readonly validationReferenceId = signal('');
  readonly measuring = signal(false);
  private readonly validationResult = signal<InstallationValidation | null>(null);
  readonly comparisonMode = signal<'validation' | 'before' | 'after' | 'zero-pose'>('validation');
  private readonly zeroPoseMeasurementResult = signal<ZeroPoseMeasurement | null>(null);
  readonly zeroPoseCandidate = computed(() => this.selected()?.zeroPoseCandidate);
  readonly canPreviewZeroPose = computed(() => this.zeroPoseCandidate()?.status === 'estimated' && !this.zeroPoseCandidate()?.stale
    && !this.busy() && !this.loading() && !this.dirty() && !this.running() && !this.generatingPanorama() && !this.guideDrawing());
  private readonly refinementMeasurementResult = signal<RefinementMeasurement | null>(null);
  readonly refinement = computed(() => this.selected()?.refinement);
  readonly refinementBaseId = signal('');
  readonly refinementSupplementalIds = signal<string[]>([]);
  readonly refinementSupplementalSources = computed(() => this.tasks().filter((task) => task.id !== this.selected()?.id
    && task.id !== this.selected()?.refinementSelection?.base?.taskId && task.cameraId === this.selected()?.cameraId
    && !['queued', 'running'].includes(task.status)));
  readonly refinementGroups = [{ key: 'overall', label: '总体（两组等权）' }, { key: 'base', label: '基础组' }, { key: 'high', label: '高倍组' }] as const;
  readonly refinementBaseSources = computed(() => this.tasks().filter((task) => task.id !== this.selected()?.id
    && task.cameraId === this.selected()?.cameraId && task.result?.status === 'estimated'
    && task.result.model === 'wgs84-horizon-installation-v1' && task.resultRevision === task.revision
    && !['queued', 'running'].includes(task.status)));
  readonly validationSources = computed<ValidationSource[]>(() => [
    ...this.refinementBaseSources().flatMap((task) => task.resultId && task.result?.installation ? [{
      key: `ordinary:${task.id}`, kind: 'ordinary' as const, task, resultId: task.resultId,
      installation: task.result.installation, sourceSnapshotIds: task.result.sourceSnapshotIds,
    }] : []),
    ...this.tasks().flatMap((task) => task.id !== this.selected()?.id && task.cameraId === this.selected()?.cameraId
      && !['queued', 'running'].includes(task.status) && task.refinement?.status === 'estimated' && !task.refinement.stale
      && task.refinement.model === 'wgs84-horizon-refinement-v1' && task.refinement.installation ? [{
        key: `refinement:${task.id}`, kind: 'refinement' as const, task, resultId: task.refinement.resultId,
        installation: task.refinement.installation, sourceSnapshotIds: task.refinement.sourceSnapshotIds,
      }] : []),
  ]);
  readonly validationSource = computed(() => this.validationSources().find((entry) => entry.key === this.validationReferenceId()));
  readonly validation = computed(() => {
    const result = this.validationResult(), task = this.selected();
    const reference = this.validationSource();
    return result && task && reference && !this.dirty() && result.taskId === task.id && result.revision === task.revision
      && result.reference.kind === reference.kind && result.reference.taskId === reference.task.id
      && result.reference.resultId === reference.resultId ? result : null;
  });
  readonly refinementMeasurement = computed(() => {
    const result = this.refinementMeasurementResult(), task = this.selected();
    return result && task && !this.dirty() && result.taskId === task.id && result.revision === task.revision
      && result.selectionRevision === task.refinementSelection?.revision && result.mode === this.comparisonMode()
      && (result.mode === 'before' || (!task.refinement?.stale && result.resultId === task.refinement?.resultId)) ? result : null;
  });
  private readonly zeroPoseMeasurement = computed(() => {
    const result = this.zeroPoseMeasurementResult(), task = this.selected(), candidate = this.zeroPoseCandidate();
    return result && task && candidate && !this.dirty() && !candidate.stale && result.taskId === task.id
      && result.revision === task.revision && result.resultId === candidate.resultId ? result : null;
  });
  private readonly comparison = computed(() => this.comparisonMode() === 'validation' ? this.validation()
    : this.comparisonMode() === 'zero-pose' ? this.zeroPoseMeasurement() : this.refinementMeasurement());
  readonly measurement = computed(() => this.comparison()
    ?.perSnapshot.find((row) => row.snapshotId === this.displayedItem()?.snapshotId && !this.singleImageError()));
  readonly measurementExclusion = computed(() =>
    (this.comparisonMode() === 'zero-pose' && !this.dirty() && !this.zeroPoseCandidate()?.stale ? this.zeroPoseCandidate() : this.comparison())
      ?.excluded.find((row) => row.snapshotId === this.displayedItem()?.snapshotId)?.reason);
  readonly theoreticalLabel = computed(() => this.comparisonMode() === 'zero-pose' ? '零位候选理论海天线' : this.comparisonMode() === 'validation'
    ? this.validationSource()?.kind === 'refinement' ? '精修独立复核理论海天线' : '普通独立复核理论海天线'
    : this.comparisonMode() === 'after' ? '精修候选理论海天线' : '基础参数理论海天线');
  readonly measurementLabel = computed(() => this.comparisonMode() === 'zero-pose' ? '零位候选原图预览' : this.comparisonMode() === 'validation'
    ? this.validationSource()?.kind === 'refinement' ? '精修候选独立复核' : '普通结果独立复核'
    : this.comparisonMode() === 'after' ? '候选海天线对照' : '基准海天线对照');
  readonly residualPositions = { left: '左端', center: '中点', right: '右端' };
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
  private validationRequest = 0;
  private guideRevision = 0;
  private savedGuide: PanoramaGuide | null = null;
  private dragIndex: number | null = null;
  private precisionDrag: { pointerId: number; start: HorizonPoint; view: HorizonView;
    endpoint: 0 | 1 | null; adjustment: HorizonAdjustment | null; points: HorizonPoint[] } | null = null;
  private panoramaController?: AbortController;
  private focusedImageController?: AbortController;
  private readonly guideHeadingOffset = signal<number | null>(null);
  private guideDrag: { pointerId: number; stage: HTMLElement; index: number | null;
    start: { x: number; y: number }; kind: PanoramaGuide['kind']; headingOffset: number } | null = null;
  private panoramaDrag: { pointerId: number; index: number; stage: HTMLElement; frame: PanoramaFrame;
    points: HorizonPoint[]; startY: number; lastY: number } | null = null;

  constructor() {
    effect((onCleanup) => {
      const container = this.annotationCanvas()?.nativeElement.parentElement;
      this.annotationSize.set(null);
      if (!container) return;
      const observer = new ResizeObserver(([{ contentRect: { width, height } }]) => {
        this.annotationSize.set({ width, height });
      });
      observer.observe(container);
      onCleanup(() => observer.disconnect());
    });
  }

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
    this.validationRequest++;
    this.measuring.set(false);
    this.validationResult.set(null);
    this.refinementMeasurementResult.set(null);
    this.zeroPoseMeasurementResult.set(null);
    this.closeSourceImage();
    this.clearPanorama();
    const revision = ++this.revision;
    this.loading.set(true);
    this.problem.set('');
    this.guideInitialized.set(false);
    this.guideError.set('');
    let loaded = false;
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
      const sourceIds = [...new Set([this.validationSource()?.task.id, page.task.refinementSelection?.base?.taskId,
        ...page.task.refinementSelection?.supplemental.map((source) => source.taskId) || []]
        .filter((source): source is string => !!source))];
      const sourceResults = await Promise.allSettled(sourceIds.map((source) => this.api.recognitionTask(source)));
      if (this.destroyed || revision !== this.revision) return;
      const sources = sourceResults.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
      for (const result of sourceResults) if (result.status === 'rejected') this.problem.set(`标定来源读取失败：${errorMessage(result.reason)}`);
      this.tasks.update((tasks) => [...tasks.filter((task) => !sourceIds.includes(task.id)), ...sources]);
      if (this.validationReferenceId() && !this.validationSource() && !this.problem()) this.problem.set('所选独立复核来源已失效，请选择合格的最新结果');
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
      if (!this.destroyed && revision === this.revision) { this.sourceGroup.set(sourceGroup); loaded = true; }
    } catch (error) {
      if (!this.destroyed && revision === this.revision) this.problem.set(error instanceof Error && error.name === 'Error' ? error.message : errorMessage(error));
    }
    finally {
      if (revision === this.revision) {
        this.loading.set(false);
        if (loaded) void this.measure();
      }
    }
  }

  private setTask(task: RecognitionTask) {
    const previous = this.selected();
    if (previous?.id !== task.id || previous.revision !== task.revision || previous.refinement?.resultId !== task.refinement?.resultId
      || previous.refinementSelection?.revision !== task.refinementSelection?.revision || task.refinement?.stale) {
      this.validationRequest++;
      this.measuring.set(false);
      this.validationResult.set(null);
      this.refinementMeasurementResult.set(null);
      this.closeSourceImage();
    }
    if (previous?.id !== task.id) {
      this.precisionMode.set(false);
      this.comparisonMode.set(task.refinementSelection?.base ? task.refinement && !task.refinement.stale ? 'after' : 'before' : 'validation');
      this.validationReferenceId.set('');
      this.clearPanorama();
      this.guide.set(null);
      this.savedGuide = null;
      this.guideRevision = 0;
      this.guideDirty.set(false);
      this.guideInitialized.set(false);
      this.guideError.set('');
    }
    if (previous?.sourceTaskId !== task.sourceTaskId) this.sourceGroup.set(null);
    if (this.comparisonMode() === 'after' && (!task.refinement || task.refinement.stale)) {
      this.comparisonMode.set(task.refinementSelection?.base ? 'before' : 'validation');
    }
    if (this.comparisonMode() === 'zero-pose' && (!task.zeroPoseCandidate?.zeroPose || task.zeroPoseCandidate.stale)) {
      this.comparisonMode.set('validation');
    }
    this.selected.set(task);
    this.refinementBaseId.set(task.refinementSelection?.base?.taskId || '');
    this.refinementSupplementalIds.set(task.refinementSelection?.supplemental.map((source) => source.taskId) || []);
    this.tasks.update((tasks) => tasks.some((item) => item.id === task.id)
      ? tasks.map((item) => item.id === task.id ? task : item) : [task, ...tasks]);
  }

  selectItem(item?: RecognitionItem) {
    this.endPanoramaDrag();
    this.closeSourceImage();
    const changed = item?.snapshotId !== this.selectedItemId();
    if (changed) {
      this.activePanoramaEndpoint.set(0);
      this.clearFocusedImage();
      this.singleImageId.set('');
      this.singleImageError.set('');
    }
    this.selectedItemId.set(item?.snapshotId || '');
    this.points.set((item?.points || []).map((point) => ({ ...point })));
    this.ignored.set(item?.ignored ?? true);
    this.dirty.set(false);
    this.endDrag();
    if (changed && this.precisionActive()) this.centerPrecision();
  }

  async openItem(item: RecognitionItem) {
    if (!this.busy() && !this.loading() && !this.guideDrawing() && await this.save()) {
      this.selectItem(this.items().find((entry) => entry.snapshotId === item.snapshotId) || item);
      void this.measure();
      if (this.panorama()) this.showFocusedPanorama();
      if (this.precisionActive()) this.focusAnnotationCanvas();
      else this.focusPanorama();
    }
  }
  undo() { const item = this.item(); if (item) { this.selectItem(item); void this.measure(); } }

  openPanoramaItem(snapshotId: string) {
    if (this.guideDrawing()) return;
    if (snapshotId === this.selectedItemId() && !this.sourceImage()) { this.showFocusedPanorama(); this.focusPanorama(); return; }
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
    this.closeSourceImage();
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

  imageLinePoints(points: HorizonPoint[], item: RecognitionItem) {
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
    if (snapshotId === this.displayedItem()?.snapshotId) { this.singleImageId.set(snapshotId); this.singleImageError.set(''); }
  }

  imageFailed(snapshotId: string) {
    if (snapshotId === this.displayedItem()?.snapshotId) {
      this.singleImageId.set('');
      this.singleImageError.set('当前原图读取失败，图片已删除或文件不可用，请刷新后重试');
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
    this.updateEditedPoints(this.points().map((point, i) => i === index ? { ...point, [axis]: value } : point));
  }
  private updateEditedPoints(points: HorizonPoint[]) {
    const before = this.points();
    if (points.length === before.length && points.every((point, i) => point.x === before[i].x && point.y === before[i].y)) return;
    this.points.set(points);
    this.dirty.set(true);
    this.message.set('');
  }
  annotationCoordinate(value: number, dimension: number) {
    return this.precisionActive() ? Number((value * dimension).toFixed(6)) : value;
  }
  editAnnotationCoordinate(index: number, axis: 'x' | 'y', value: number | null, dimension: number) {
    this.editPoint(index, axis, value === null || !this.precisionActive() ? value : value / dimension);
  }
  togglePrecision() {
    if (!this.originalEditable()) return;
    this.endDrag();
    this.precisionMode.update(value => !value);
    if (this.precisionActive()) {
      this.precisionTarget.set('line');
      this.centerPrecision(16);
      this.focusAnnotationCanvas();
    }
  }
  private focusAnnotationCanvas() { this.annotationCanvas()?.nativeElement.focus({ preventScroll: true }); }
  private centerPrecision(zoom = this.precisionView().zoom) {
    const points = this.points(), target = this.precisionTarget();
    const center = points.length !== 2 ? { x: 0.5, y: 0.5 } : target === 'line'
      ? { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 } : points[target];
    this.precisionView.set(horizonView(zoom, center.x - 0.5 / zoom, center.y - 0.5 / zoom));
  }
  selectPrecisionTarget(target: HorizonAdjustment) {
    this.precisionTarget.set(target);
    this.centerPrecision();
    this.focusAnnotationCanvas();
  }
  setPrecisionZoom(zoom: number, anchor: HorizonPoint = { x: 0.5, y: 0.5 }) {
    if (this.precisionZooms.includes(zoom)) this.precisionView.update(view => zoomHorizonView(view, zoom, anchor));
  }
  zoomAnnotation(event: WheelEvent) {
    if (!this.precisionActive() || this.precisionDrag || !event.deltaY) return;
    const anchor = this.annotationPointer(event);
    if (!anchor) return;
    event.preventDefault();
    const next = this.precisionZooms.indexOf(this.precisionView().zoom) + (event.deltaY < 0 ? 1 : -1);
    this.setPrecisionZoom(this.precisionZooms[next], anchor);
  }
  nudgePrecision(direction: 1 | -1) {
    const item = this.item(), step = this.precisionStep();
    if (!this.precisionActive() || !this.originalEditable() || !item || step === null) return;
    this.updateEditedPoints(shiftHorizonPixels(this.points(), this.precisionTarget(),
      direction * step, item.snapshot.height));
    this.focusAnnotationCanvas();
  }
  annotationKeydown(event: KeyboardEvent) {
    if (!this.precisionActive() || !this.originalEditable() || event.defaultPrevented || event.isComposing || event.altKey) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void this.save();
      return;
    }
    if (event.ctrlKey || event.metaKey || this.precisionDrag || this.points().length !== 2) return;
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      this.nudgePrecision(event.key === 'ArrowUp' ? -1 : 1);
    }
  }
  setIgnored(value: boolean) { this.ignored.set(value); this.dirty.set(true); this.message.set(''); }
  resetLine() {
    this.updateEditedPoints([{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }]);
    if (this.precisionActive()) this.centerPrecision();
  }
  private annotationPointer(event: MouseEvent): HorizonPoint | null {
    const rect = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
    return rect.width > 0 && rect.height > 0
      ? { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height } : null;
  }
  startDrag(event: PointerEvent) {
    if (!this.originalEditable() || this.panoramaDrag || this.guideDrag || this.precisionDrag || event.button !== 0) return;
    const svg = event.currentTarget as SVGSVGElement;
    const start = this.annotationPointer(event);
    if (!start) return;
    if (this.precisionActive()) {
      event.preventDefault();
      this.focusAnnotationCanvas();
      const hit = event.shiftKey ? null : event.target as Element | null;
      const mark = hit?.getAttribute('data-annotation-endpoint');
      const endpoint = mark === '0' ? 0 : mark === '1' ? 1 : null;
      if (endpoint !== null) this.precisionTarget.set(endpoint);
      this.precisionDrag = { pointerId: event.pointerId, start, view: this.precisionView(), endpoint,
        adjustment: hit?.hasAttribute('data-annotation-line') ? this.precisionTarget() : null, points: this.points() };
      svg.setPointerCapture(event.pointerId);
      return;
    }
    if (this.points().length !== 2) return;
    event.preventDefault();
    const { x, y } = start;
    this.dragIndex = this.points().map((point) => Math.hypot(point.x - x, point.y - y)).reduce((best, distance, index, values) => distance < values[best] ? index : best, 0);
    svg.setPointerCapture(event.pointerId);
    this.drag(event);
  }
  drag(event: PointerEvent) {
    if (this.precisionDrag) {
      const { pointerId, start, view, endpoint, adjustment, points } = this.precisionDrag;
      if (event.pointerId !== pointerId || !this.originalEditable()) return;
      const cursor = this.annotationPointer(event);
      if (!cursor) return;
      const x = (cursor.x - start.x) / view.zoom, y = (cursor.y - start.y) / view.zoom;
      if (endpoint !== null) {
        const point = points[endpoint];
        const moved = { x: Math.max(0, Math.min(1, point.x + x)), y: Math.max(0, Math.min(1, point.y + y)) };
        this.updateEditedPoints(points.map((value, index) => index === endpoint ? moved : value));
      } else if (adjustment !== null) {
        const height = this.item()!.snapshot.height;
        this.updateEditedPoints(shiftHorizonPixels(points, adjustment, y * height, height));
      } else this.precisionView.set(horizonView(view.zoom, view.left - x, view.top - y));
      return;
    }
    if (this.dragIndex === null) return;
    const cursor = this.annotationPointer(event);
    if (!cursor || !this.originalEditable()) return;
    this.editPoint(this.dragIndex, 'x', Math.max(0, Math.min(1, cursor.x)));
    this.editPoint(this.dragIndex, 'y', Math.max(0, Math.min(1, cursor.y)));
  }
  endDrag(event?: PointerEvent) {
    if (event && this.precisionDrag && event.pointerId !== this.precisionDrag.pointerId) return;
    this.dragIndex = null;
    this.precisionDrag = null;
  }

  async save(annotations = true): Promise<boolean> {
    this.endDrag();
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
    let saved = false;
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
      this.message.set(saveAnnotation ? `${saveGuide ? '标注和全景参考线' : '标注'}已保存` : '全景参考线已保存');
      saved = true;
      return true;
    } catch (error) { this.problem.set(errorMessage(error)); return false; }
    finally {
      this.busy.set(false);
      if (saved && saveAnnotation) void this.measure();
    }
  }

  saveGuide() { return this.save(false); }

  async generate(zeroPose = false) {
    if (this.busy() || this.loading() || this.running() || this.generatingPanorama() || !await this.save()) return;
    const task = this.selected();
    if (!task) return;
    this.busy.set(true); this.problem.set(''); this.message.set('');
    try {
      const result = await this.api.generateInstallation(task.id, task.revision, zeroPose ? 'wgs84-horizon-zero-pose-v1' : undefined);
      if (!this.destroyed) this.setTask(result);
    } catch (error) { this.problem.set(errorMessage(error)); }
    finally { this.busy.set(false); }
    if (zeroPose && this.comparisonMode() === 'zero-pose') void this.measureZeroPose();
  }
  previewZeroPose(snapshotId: string) {
    if (!this.canPreviewZeroPose()) return;
    const item = this.items().find((entry) => entry.snapshotId === snapshotId);
    if (!item || item.missing) {
      this.problem.set('参与原图已删除或尚未加载，请刷新识别任务');
      return;
    }
    this.problem.set('');
    this.comparisonMode.set('zero-pose');
    this.selectItem(item);
    this.focusAnnotationCanvas();
    void this.measureZeroPose();
  }
  stopZeroPosePreview() {
    this.comparisonMode.set('validation');
    void this.measure();
  }
  private async measureZeroPose() {
    const task = this.selected(), candidate = this.zeroPoseCandidate(), item = this.item();
    const request = ++this.validationRequest;
    this.zeroPoseMeasurementResult.set(null);
    this.measuring.set(false);
    if (this.destroyed || !task || !candidate?.zeroPose || candidate.stale || !item || item.missing || this.dirty()
      || !candidate.sourceSnapshotIds.includes(item.snapshotId)) return;
    this.measuring.set(true);
    try {
      const result = await this.api.measureZeroPose(task.id, task.revision, candidate.resultId, item.snapshotId);
      if (!this.destroyed && request === this.validationRequest) this.zeroPoseMeasurementResult.set(result);
    } catch (error) { if (!this.destroyed && request === this.validationRequest) this.problem.set(errorMessage(error)); }
    finally { if (request === this.validationRequest) this.measuring.set(false); }
  }
  async validate() {
    if (this.busy() || this.loading() || this.running() || this.generatingPanorama() || !await this.save()) return;
    this.closeSourceImage();
    this.comparisonMode.set('validation');
    this.problem.set('');
    await this.measure();
  }
  selectValidationSource(id: string) {
    this.problem.set('');
    this.closeSourceImage();
    this.comparisonMode.set('validation');
    this.validationReferenceId.set(id);
    void this.measure();
  }
  private async measure() {
    if (this.comparisonMode() === 'zero-pose') return this.measureZeroPose();
    if (this.comparisonMode() !== 'validation') return this.measureRefinement();
    if (this.destroyed) return;
    const request = ++this.validationRequest;
    this.validationResult.set(null);
    this.measuring.set(false);
    const task = this.selected(), reference = this.validationSource();
    if (!task || !reference?.resultId || this.dirty() || this.running()) return;
    const revision = this.revision;
    this.measuring.set(true);
    try {
      const result = await this.api.validateInstallation(task.id, task.revision, reference.task.id, reference.resultId, reference.kind);
      if (!this.destroyed && request === this.validationRequest && revision === this.revision && !this.dirty()
        && task.revision === this.selected()?.revision && reference.key === this.validationSource()?.key
        && reference.resultId === this.validationSource()?.resultId) this.validationResult.set(result);
    } catch (error) { if (!this.destroyed && request === this.validationRequest) this.problem.set(errorMessage(error)); }
    finally { if (request === this.validationRequest) this.measuring.set(false); }
  }
  selectComparisonMode(mode: 'before' | 'after') {
    this.problem.set('');
    this.comparisonMode.set(mode);
    void this.measure();
  }
  private async measureRefinement() {
    if (this.destroyed) return;
    const request = ++this.validationRequest, task = this.selected(), mode = this.comparisonMode();
    this.refinementMeasurementResult.set(null);
    this.validationResult.set(null);
    this.measuring.set(false);
    if (!task?.refinementSelection?.base || this.dirty() || this.running() || (mode !== 'before' && mode !== 'after')
      || (mode === 'after' && (!task.refinement || task.refinement.stale))) return;
    const revision = this.revision, selectionRevision = task.refinementSelection.revision;
    this.measuring.set(true);
    try {
      const result = await this.api.measureRefinement(task.id, task.revision, selectionRevision, mode, task.refinement?.resultId);
      if (!this.destroyed && request === this.validationRequest && revision === this.revision && !this.dirty()
        && task.revision === this.selected()?.revision && selectionRevision === this.selected()?.refinementSelection?.revision
        && mode === this.comparisonMode()) this.refinementMeasurementResult.set(result);
    } catch (error) {
      if (!this.destroyed && request === this.validationRequest) { this.closeSourceImage(); this.problem.set(errorMessage(error)); }
    }
    finally { if (request === this.validationRequest) this.measuring.set(false); }
  }
  async selectRefinementBase(taskId: string) {
    await this.saveRefinementSources(taskId, this.refinementSupplementalIds().filter((id) => id !== taskId));
  }
  async selectRefinementSupplemental(taskId: string, checked: boolean) {
    const ids = this.refinementSupplementalIds().filter((id) => id !== taskId);
    if (checked) ids.push(taskId);
    await this.saveRefinementSources(this.selected()?.refinementSelection?.base?.taskId || '', ids);
  }
  private async saveRefinementSources(baseId: string, supplementalIds: string[], measure = true): Promise<boolean> {
    if (this.busy() || this.loading() || this.running() || this.generatingPanorama() || !await this.save()) return false;
    const task = this.selected(), base = this.tasks().find((source) => source.id === baseId);
    if (!task || (baseId && !base?.resultId)) return false;
    this.refinementBaseId.set(baseId);
    this.refinementSupplementalIds.set(supplementalIds);
    this.busy.set(true); this.problem.set(''); this.message.set('');
    let saved = false;
    try {
      const result = await this.api.saveRefinementSources(task.id, task.revision, { revision: task.refinementSelection?.revision || 0,
        base: base?.resultId ? { taskId: base.id, revision: base.revision, resultId: base.resultId } : null,
        supplemental: supplementalIds.map((id) => ({ taskId: id, revision: this.tasks().find((source) => source.id === id)!.revision })) });
      if (this.destroyed) return false;
      this.setTask(result);
      this.comparisonMode.set(baseId ? 'before' : 'validation');
      this.message.set('精修来源已保存');
      saved = true;
    } catch (error) { this.problem.set(errorMessage(error)); }
    finally {
      this.busy.set(false);
      this.refinementBaseId.set(this.selected()?.refinementSelection?.base?.taskId || '');
      this.refinementSupplementalIds.set(this.selected()?.refinementSelection?.supplemental.map((source) => source.taskId) || []);
    }
    if (saved && measure) void this.measure();
    return saved;
  }
  async refine() {
    if (this.busy() || this.loading() || this.running() || this.generatingPanorama() || !await this.save()) return;
    const selected = this.selected();
    if (!selected?.refinementSelection?.base || !await this.saveRefinementSources(selected.refinementSelection.base.taskId,
      selected.refinementSelection.supplemental.map((source) => source.taskId), false)) return;
    const task = this.selected()!;
    this.busy.set(true); this.problem.set(''); this.message.set('');
    let generated = false;
    try {
      const result = await this.api.refineInstallation(task.id, task.revision, task.refinementSelection!.revision);
      if (this.destroyed) return;
      this.setTask(result);
      this.comparisonMode.set('after');
      generated = true;
    } catch (error) { this.problem.set(errorMessage(error)); }
    finally { this.busy.set(false); }
    if (generated) void this.measure();
  }
  async openValidationItem(snapshotId: string) {
    const item = this.items().find((entry) => entry.snapshotId === snapshotId);
    if (item) await this.openItem(item);
  }
  async openRefinementItem(snapshotId: string, taskId: string) {
    if (this.busy() || this.loading() || this.running() || this.generatingPanorama() || this.guideDrawing() || this.dirty()) return;
    const task = this.selected(), candidate = task?.refinement;
    const source = candidate?.sources.find((entry) => entry.taskId === taskId && entry.sourceSnapshotIds.includes(snapshotId));
    if (!task || !candidate || candidate.stale || !source) return;
    const mode = this.comparisonMode() === 'before' ? 'before' : 'after';
    if (taskId === task.id) {
      this.comparisonMode.set(mode);
      await this.openValidationItem(snapshotId);
      return;
    }
    const revision = this.revision;
    this.validationRequest++;
    this.refinementMeasurementResult.set(null);
    this.measuring.set(false);
    this.loading.set(true);
    this.problem.set('');
    try {
      let offset: number | null = 0;
      while (offset !== null) {
        const page = await this.api.recognitionItems(taskId, offset);
        if (this.destroyed || revision !== this.revision || this.selected()?.refinement?.resultId !== candidate.resultId
          || this.selected()?.refinementSelection?.revision !== candidate.selectionRevision) return;
        if (page.task.revision !== source.revision || ['queued', 'running'].includes(page.task.status)
          || (source.role === 'base' && page.task.resultId !== source.resultId)) {
          throw new Error('精修参与图的来源版本已变化，请刷新并重新生成候选');
        }
        const item = page.items.find((entry) => entry.snapshotId === snapshotId);
        if (item) {
          if (item.missing) throw new Error('精修参与图的原图已删除，请刷新并重新生成候选');
          this.showOverview();
          this.endDrag();
          this.singleImageId.set('');
          this.singleImageError.set('');
          this.sourceImage.set({ task: page.task, item });
          this.comparisonMode.set(mode);
          await this.measureRefinement();
          return;
        }
        offset = page.nextOffset;
      }
      throw new Error('精修参与图已不存在，请刷新并重新生成候选');
    } catch (error) {
      if (!this.destroyed && revision === this.revision) {
        this.closeSourceImage();
        this.problem.set(error instanceof Error && error.name === 'Error' ? error.message : errorMessage(error));
      }
    } finally { if (revision === this.revision) this.loading.set(false); }
  }
  closeSourceImage() {
    if (!this.sourceImage()) return;
    this.sourceImage.set(null);
    this.singleImageId.set('');
    this.singleImageError.set('');
  }
  calibrationZoom(task: RecognitionTask) {
    const values = task.result?.diagnostics?.perSnapshot.flatMap((row) => row.zoom === undefined ? [] : [row.zoom]) || [];
    if (!values.length) return '—';
    const min = Math.min(...values), max = Math.max(...values);
    return min === max ? min.toFixed(1) : `${min.toFixed(1)}～${max.toFixed(1)}`;
  }
  signedResidual(value: number | null) { return value === null ? '不可比较' : `${value > 0 ? '+' : ''}${value.toFixed(2)}`; }
  async applyRefinement() {
    const task = this.selected(), candidate = task?.refinement;
    if (!task || !candidate || candidate.status !== 'estimated' || candidate.stale || candidate.applied
      || this.busy() || this.loading() || this.dirty() || this.running() || this.generatingPanorama()) return;
    this.busy.set(true); this.problem.set(''); this.message.set('');
    try {
      const result = await this.api.applyRefinement(task.id, task.revision, candidate.resultId);
      if (this.destroyed) return;
      this.setTask(result.task);
      this.applied.emit(result.camera);
      this.message.set('精修四项安装参数已应用到摄像头配置');
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
