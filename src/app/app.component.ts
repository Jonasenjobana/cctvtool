import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, HostListener, ViewChild, computed, effect, inject, signal, untracked } from '@angular/core';
import type { OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { EMPTY, catchError, exhaustMap, firstValueFrom, timer } from 'rxjs';
import type { Subscription } from 'rxjs';
import { ApiService, errorMessage } from './api.service';
import { CameraSceneComponent } from './camera-scene.component';
import { IconComponent } from './icon.component';
import { LiveVideoComponent } from './live-video.component';
import { CalibrationHelpComponent } from './calibration-help.component';
import { SnapshotItemComponent } from './snapshot-item.component';
import { SnapshotTasksComponent } from './snapshot-tasks.component';
import { RecognitionTasksComponent } from './recognition-tasks.component';
import { PlotLayersComponent } from './plot-layers.component';
import { PlotLayerState } from './plot-layer-state.service';
import { HoldPtzControl } from './hold-ptz-control';
import { emptyCamera, snapshotTaskName, snapshotTaskStatus } from './models';
import type { Calibration, Camera, CameraDraft, CameraInput, MotionCommand, PlaybackSource, PreciseTarget, PtzReading, Snapshot, SnapshotGroup } from './models';
import type { PlotLayerError, PlotLayerFocusRequest, PlotLayerFocusResult, PlotLayerRenderInput } from './plot-layer.models';

const editableKeys = ['name', 'serial', 'code', 'longitude', 'latitude', 'height', 'pAxisPitch', 'pAxisRoll', 'panOffset', 'tiltOffset', 'imageRoll'] as const;
type NumericField = 'longitude' | 'latitude' | 'height' | 'pAxisPitch' | 'pAxisRoll' | 'panOffset' | 'tiltOffset' | 'imageRoll';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [FormsModule, DatePipe, DecimalPipe, IconComponent, CameraSceneComponent, LiveVideoComponent, CalibrationHelpComponent, SnapshotItemComponent, SnapshotTasksComponent, RecognitionTasksComponent, PlotLayersComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
})
export class AppComponent implements OnDestroy {
  @ViewChild(CameraSceneComponent) scene?: CameraSceneComponent;
  @ViewChild(RecognitionTasksComponent) recognition?: RecognitionTasksComponent;
  private readonly api = inject(ApiService);
  readonly plots = inject(PlotLayerState);
  readonly cameras = signal<Camera[]>([]);
  readonly selectedId = signal('');
  readonly draft = signal<CameraDraft>(emptyCamera());
  readonly reading = signal<PtzReading | null>(null);
  readonly stale = signal(true);
  readonly snapshots = signal<Snapshot[]>([]);
  readonly snapshotGroups = signal<SnapshotGroup[]>([]);
  readonly expandedGroupId = signal('');
  readonly nextGroupOffset = signal<number | null>(null);
  readonly nextSnapshotOffset = signal<number | null>(null);
  readonly groupLoading = signal(false);
  readonly deletingSnapshot = signal(false);
  readonly page = signal<'scene' | 'tasks' | 'recognition' | 'plotting'>('scene');
  readonly showPlotPanel = signal(false);
  readonly plotPreparing = signal(false);
  readonly plotFocusRequest = signal<PlotLayerFocusRequest | null>(null);
  readonly cameraPlotLayers = computed(() => {
    const id = this.selectedId();
    return id ? this.plots.layers().filter((layer) => layer.associations.some((association) => association.cameraId === id)) : [];
  });
  readonly plotRenderLayers = computed<readonly PlotLayerRenderInput[]>(() => {
    const texts = this.plots.texts(), cameraId = this.selectedId();
    return this.cameraPlotLayers().flatMap((layer) => {
      const text = texts.get(layer.id);
      return text === undefined ? [] : [{ id: layer.id, name: layer.name, geojsonText: text,
        visible: layer.associations.find((association) => association.cameraId === cameraId)!.visible }];
    });
  });
  readonly recognitionTaskId = signal('');
  readonly snapshotTaskId = signal('');
  readonly taskStatuses = snapshotTaskStatus;
  readonly taskName = snapshotTaskName;
  readonly scanMode = signal<'fixed' | 'horizon'>('fixed');
  readonly scanPanMin = signal<number | null>(0);
  readonly scanPanMax = signal<number | null>(150);
  readonly preScanZoom = signal<number | null>(1);
  readonly scanTiltMin = signal<number | null>(0);
  readonly scanTiltMax = signal<number | null>(360);
  readonly currentScan = computed(() => this.snapshotGroups().find((group) => group.kind === 'scan' && ['running', 'pausing'].includes(group.status))
    || this.snapshotGroups().find((group) => group.kind === 'scan') || null);
  readonly scanning = computed(() => ['running', 'pausing'].includes(this.currentScan()?.status || ''));
  readonly selectedSnapshot = signal<Snapshot | null>(null);
  readonly lastSnapshot = signal<Snapshot | null>(null);
  readonly hidePreview = signal(false);
  readonly playbackSource = signal<PlaybackSource | null>(null);
  readonly playbackError = signal('');
  readonly showVideo = signal(true);
  readonly liveVideo = signal<HTMLVideoElement | null>(null);
  readonly videoOpacity = signal(1);
  readonly panel = signal<'devices' | 'snapshots' | null>(null);
  readonly following = signal(true);
  readonly saving = signal(false);
  readonly operating = signal<'control' | 'precise' | 'snapshot' | 'scan' | null>(null);
  readonly historyLoading = signal(false);
  readonly apiConnected = signal(false);
  readonly pageError = signal('');
  readonly liveError = signal('');
  readonly operationError = signal('');
  readonly formError = signal('');
  readonly formMessage = signal('');
  readonly operationMessage = signal('');
  readonly controlTarget = signal<{ pan: number; tilt: number; zoom: number } | null>(null);
  readonly controlSpeed = signal<number | null>(129);
  readonly padControls = [
    { command: 'up', slot: 'up', icon: 'up', label: '云台向上' },
    { command: 'left', slot: 'left', icon: 'left', label: '云台向左' },
    { command: 'right', slot: 'right', icon: 'right', label: '云台向右' },
    { command: 'down', slot: 'down', icon: 'down', label: '云台向下' },
    { command: 'zoomin', slot: 'plus', icon: 'plus', label: '放大' },
    { command: 'zoomout', slot: 'minus', icon: 'minus', label: '缩小' },
  ] as const;
  readonly heldCommand = signal<MotionCommand | null>(null);
  readonly stopping = signal(false);
  readonly preciseTarget = signal<{ pan: number | null; tilt: number | null; zoom: number | null }>({ pan: null, tilt: null, zoom: null });
  private pointerId: number | null = null;
  private pressedButton: HTMLButtonElement | null = null;
  private keyboardHeld = false;
  readonly selectedCamera = computed(() => this.cameras().find((camera) => camera.id === this.selectedId()) || null);
  readonly currentReading = computed(() => this.selectedSnapshot()?.ptz || this.reading());
  readonly sceneReading = computed(() => this.selectedSnapshot()?.ptz || (this.stale() ? null : this.reading()));
  readonly formValue = computed<CameraDraft>(() => {
    const snapshot = this.selectedSnapshot();
    return snapshot ? {
      name: snapshot.cameraName, serial: snapshot.serial, code: snapshot.code, ...snapshot.calibration,
    } : this.draft();
  });
  readonly sceneCamera = computed(() => this.selectedId() ? this.formValue() : null);
  readonly videoChannelMatches = computed(() => {
    const source = this.playbackSource();
    const camera = this.selectedCamera();
    const draft = this.sceneCamera();
    return !!source && camera?.serial === source.serial && camera?.code === source.code
      && draft?.serial === source.serial && draft?.code === source.code;
  });
  readonly sceneVideo = computed(() => this.showVideo() && !this.selectedSnapshot() && this.videoChannelMatches()
    ? this.liveVideo() : null);
  readonly preview = computed(() => this.hidePreview() ? null : (this.selectedSnapshot() || this.lastSnapshot()));
  readonly isDirty = computed(() => {
    const original = this.selectedCamera() || emptyCamera();
    return editableKeys.some((key) => original[key] !== this.draft()[key]);
  });
  readonly formValid = computed(() => {
    const draft = this.draft();
    return [draft.name, draft.serial, draft.code].every((value) => value.trim().length > 0)
      && this.inRange(draft.longitude, -180, 180, true)
      && this.inRange(draft.latitude, -90, 90, true)
      && this.inRange(draft.height, 0, 100000, true)
      && this.inRange(draft.pAxisPitch, -180, 180)
      && this.inRange(draft.pAxisRoll, -180, 180)
      && this.inRange(draft.panOffset, -360, 360)
      && this.inRange(draft.tiltOffset, -180, 180)
      && this.inRange(draft.imageRoll, -180, 180);
  });
  readonly canControl = computed(() => Boolean(this.selectedId() && !this.saving() && !this.operating() && !this.selectedSnapshot() && !this.scanning()
    && this.inRange(this.controlSpeed(), 0, 255) && Number.isInteger(this.controlSpeed())));
  readonly canPrecise = computed(() => {
    const target = this.preciseTarget();
    return Boolean(this.selectedId() && !this.saving() && !this.operating() && !this.selectedSnapshot() && !this.scanning()
      && this.inRange(target.pan, 0, 360) && this.inRange(target.tilt, 0, 360) && this.inRange(target.zoom, 1, Number.MAX_VALUE));
  });
  readonly canCapture = computed(() => Boolean(this.selectedId() && !this.saving() && !this.operating() && !this.selectedSnapshot() && !this.scanning() && this.formValid()));
  readonly canScan = computed(() => this.canCapture() && this.inRange(this.scanPanMin(), 0, 360)
    && this.inRange(this.scanPanMax(), 0, 360) && this.scanPanMax()! > this.scanPanMin()!
    && (this.scanMode() === 'fixed' || (!this.stale() && !!this.reading()
      && this.scanPanMax()! - this.scanPanMin()! >= 30
      && this.inRange(this.preScanZoom(), 1, Number.MAX_VALUE) && this.preScanZoom()! < this.reading()!.raw.Zoom
      && this.inRange(this.scanTiltMin(), 0, 360) && this.inRange(this.scanTiltMax(), 0, 360)
      && this.scanTiltMin()! < this.scanTiltMax()!
      && this.inRange(this.reading()!.raw.Tilt, this.scanTiltMin()!, this.scanTiltMax()!))));
  private readonly pollingPaused = computed(() => this.operating() === 'snapshot');
  private readonly holdControl = new HoldPtzControl(
    (id, command, speed, keepalive) => this.api.control(id, command, speed, keepalive),
    (state) => {
      this.heldCommand.set(state.command);
      this.stopping.set(state.stopping);
      this.operating.set(state.busy ? 'control' : null);
      this.operationError.set(state.error);
      this.operationMessage.set(state.message);
    }, errorMessage,
  );
  private historyRevision = 0;
  private groupRevision = 0;
  private preciseRevision = 0;
  private playbackSubscription?: Subscription;
  private plotNavigationRevision = 0;
  private plotRequestId = 0;

  constructor() {
    effect(() => {
      const id = this.selectedId(), page = this.page();
      if ((page === 'scene' && id) || page === 'plotting') untracked(() => { void this.plots.refresh(); });
    });
    effect(() => {
      const layers = this.cameraPlotLayers(), page = this.page(), loading = this.plots.loading();
      if (page === 'scene' && !loading && layers.length) untracked(() => { void this.plots.loadDetails(layers.map((layer) => layer.id)); });
    });
    effect(() => {
      const problem = this.plots.problem(), errors = this.plots.layerErrors();
      const hasLayerError = this.cameraPlotLayers().some((layer) => errors.has(layer.id));
      if (this.page() === 'scene' && (problem || hasLayerError)) this.showPlotPanel.set(true);
    });
    effect((onCleanup) => {
      const id = this.selectedId();
      if (!id || this.pollingPaused()) return;
      const subscription = timer(0, 1000).pipe(exhaustMap(() => this.api.ptz(id).pipe(
        catchError((error: unknown) => {
          this.stale.set(true);
          this.liveError.set(errorMessage(error));
          return EMPTY;
        }),
      ))).subscribe((reading) => {
        this.reading.set(reading);
        this.stale.set(false);
        this.liveError.set('');
      });
      onCleanup(() => subscription.unsubscribe());
    });
    effect((onCleanup) => {
      const id = this.selectedId();
      if (!id) return;
      const subscription = timer(2000, 2000).subscribe(() => {
        if (!this.historyLoading() && !this.deletingSnapshot()) void this.loadSnapshots(id);
      });
      onCleanup(() => subscription.unsubscribe());
    });
    void this.initialize();
  }

  private inRange(value: number | null, min: number, max: number, nullable = false) {
    return value === null ? nullable : Number.isFinite(value) && value >= min && value <= max;
  }

  loadPlayback() {
    this.playbackSubscription?.unsubscribe();
    this.playbackSubscription = undefined;
    this.playbackSource.set(null);
    this.liveVideo.set(null);
    this.playbackError.set('');
    const id = this.selectedId();
    if (!id) return;
    // 取消上次 HTTP 订阅，使旧设备的迟到响应无法重新挂回直播。
    this.playbackSubscription = this.api.playback(id).subscribe({
      next: (source) => this.playbackSource.set(source),
      error: (error: unknown) => this.playbackError.set(errorMessage(error)),
    });
  }

  private async initialize() {
    try {
      const [cameras, health] = await Promise.all([this.api.cameras(), this.api.health()]);
      this.apiConnected.set(true);
      this.cameras.set(cameras);
      if (!health.livegbsConfigured) this.pageError.set('请在后端配置 LiveGBS 服务地址与登录信息');
      if (cameras.length) this.activate(cameras[0]);
      else this.panel.set('devices');
    } catch (error) {
      this.pageError.set(errorMessage(error));
      this.panel.set('devices');
    }
  }

  private activate(camera: Camera) {
    this.plotNavigationRevision++;
    this.plotFocusRequest.set(null);
    const { name, serial, code, longitude, latitude, height, pAxisPitch, pAxisRoll, panOffset, tiltOffset, imageRoll } = camera;
    this.draft.set({ name, serial, code, longitude, latitude, height, pAxisPitch, pAxisRoll, panOffset, tiltOffset, imageRoll });
    this.selectedId.set(camera.id);
    this.reading.set(null);
    this.stale.set(true);
    this.liveError.set('');
    this.operationError.set('');
    this.operationMessage.set('');
    this.controlTarget.set(null);
    this.preciseTarget.set({ pan: null, tilt: null, zoom: null });
    this.selectedSnapshot.set(null);
    this.lastSnapshot.set(null);
    this.following.set(true);
    this.hidePreview.set(false);
    this.snapshots.set([]);
    this.snapshotGroups.set([]);
    this.groupRevision++;
    this.groupLoading.set(false);
    this.expandedGroupId.set('');
    this.nextGroupOffset.set(null);
    this.nextSnapshotOffset.set(null);
    this.formMessage.set('');
    this.formError.set('');
    this.loadPlayback();
    void this.loadSnapshots(camera.id);
  }

  selectCamera(camera: Camera) {
    if (this.operating() || this.saving()) return false;
    if (this.isDirty() && !window.confirm('当前参数尚未保存，确定切换并放弃修改？')) return false;
    this.activate(camera);
    this.panel.set(null);
    return true;
  }

  openRecognition(id: string) {
    this.plotNavigationRevision++;
    this.plotFocusRequest.set(null);
    this.recognitionTaskId.set(id);
    this.page.set('recognition');
    this.panel.set(null);
  }

  openSnapshotTask(group: SnapshotGroup) {
    this.plotNavigationRevision++;
    this.plotFocusRequest.set(null);
    this.snapshotTaskId.set(group.id);
    if (this.selectedId() === group.cameraId) {
      this.snapshotGroups.update((groups) => [group, ...groups.filter((item) => item.id !== group.id)]);
    }
    this.page.set('tasks');
    this.panel.set(null);
  }

  async openPage(page: 'scene' | 'tasks' | 'recognition' | 'plotting') {
    const revision = ++this.plotNavigationRevision;
    if (this.recognition?.busy() || (this.recognition && !await this.recognition.save())) return false;
    if (revision !== this.plotNavigationRevision) return false;
    this.plotFocusRequest.set(null);
    this.page.set(page);
    this.panel.set(null);
    return true;
  }

  togglePlotPanel() {
    this.showPlotPanel.update((show) => !show);
    this.panel.set(null);
    if (this.showPlotPanel() && this.selectedId()) void this.plots.refresh();
  }

  plotVisibility(layerId: string) {
    return this.plots.layers().find((layer) => layer.id === layerId)?.associations.find((association) => association.cameraId === this.selectedId())?.visible;
  }

  async togglePlotVisibility(layerId: string) {
    const visible = this.plotVisibility(layerId);
    if (visible !== undefined && !this.plotPreparing()) await this.plots.setVisibility(layerId, this.selectedId(), !visible);
  }

  async focusPlotLayer(request: { layerId: string; cameraId: string }) {
    if (this.plotPreparing() || this.plots.busy() || this.plots.loading() || this.operating() || this.saving()) return;
    const camera = this.cameras().find((item) => item.id === request.cameraId);
    const association = this.plots.layers().find((layer) => layer.id === request.layerId)?.associations.find((item) => item.cameraId === request.cameraId);
    if (!camera || !association) { this.plots.problem.set('请先将图层关联到目标摄像头'); return; }
    const revision = this.plotNavigationRevision;
    this.plotPreparing.set(true);
    this.plotFocusRequest.set(null);
    this.plots.problem.set('');
    try {
      if (!association.visible && !await this.plots.setVisibility(request.layerId, request.cameraId, true)) return;
      if (revision !== this.plotNavigationRevision) return;
      if (!await this.plots.loadDetails([request.layerId]) || revision !== this.plotNavigationRevision) return;
      if (this.operating() || this.saving()) { this.plots.problem.set('当前操作尚未结束，请稍后定位'); return; }
      if (this.selectedId() !== camera.id && !this.selectCamera(camera)) {
        this.plots.problem.set('摄像头未切换，已取消定位');
        return;
      }
      if (!await this.openPage('scene')) { this.plots.problem.set('当前页面未能离开，已取消定位'); return; }
      if (this.selectedId() !== camera.id || this.page() !== 'scene') return;
      // activate 会恢复跟随；仅在切换摄像头和切页都成功后关闭，定位只改变地图观察。
      this.following.set(false);
      this.showPlotPanel.set(true);
      this.plotFocusRequest.set({ layerId: request.layerId, requestId: ++this.plotRequestId });
    } finally { this.plotPreparing.set(false); }
  }

  onPlotLayerError(error: PlotLayerError) {
    if (this.page() === 'scene' && this.cameraPlotLayers().some((layer) => layer.id === error.layerId)) this.plots.reportLayerError(error);
  }

  onPlotFocusResult(result: PlotLayerFocusResult) {
    if (result.requestId !== this.plotFocusRequest()?.requestId || this.page() !== 'scene') return;
    this.plotFocusRequest.set(null);
    if (!result.success) this.plots.problem.set(result.message || '图层定位失败，请刷新后重试');
  }

  installationApplied(camera: Camera) {
    this.cameras.update((cameras) => cameras.map((item) => item.id === camera.id ? camera : item));
    if (this.selectedId() === camera.id) {
      this.draft.update((draft) => ({ ...draft, pAxisPitch: camera.pAxisPitch, pAxisRoll: camera.pAxisRoll,
        tiltOffset: camera.tiltOffset, imageRoll: camera.imageRoll }));
      this.formMessage.set('已应用识别任务生成的安装参数');
    }
  }

  newCamera() {
    if (this.operating() || this.saving()) return;
    if (this.isDirty() && !window.confirm('当前参数尚未保存，确定放弃修改并注册设备？')) return;
    this.plotNavigationRevision++;
    this.plotFocusRequest.set(null);
    this.selectedId.set('');
    this.draft.set(emptyCamera());
    this.reading.set(null);
    this.stale.set(true);
    this.selectedSnapshot.set(null);
    this.lastSnapshot.set(null);
    this.snapshots.set([]);
    this.snapshotGroups.set([]);
    this.groupRevision++;
    this.groupLoading.set(false);
    this.expandedGroupId.set('');
    this.nextGroupOffset.set(null);
    this.nextSnapshotOffset.set(null);
    this.operationError.set('');
    this.operationMessage.set('');
    this.liveError.set('');
    this.formError.set('');
    this.formMessage.set('');
    this.controlTarget.set(null);
    this.preciseTarget.set({ pan: null, tilt: null, zoom: null });
    this.panel.set(null);
    this.historyRevision++;
    this.historyLoading.set(false);
    this.loadPlayback();
  }

  editText(field: 'name' | 'serial' | 'code', value: string) {
    this.draft.update((draft) => ({ ...draft, [field]: value }));
    this.formMessage.set('');
    this.formError.set('');
  }

  editNumber(field: NumericField, value: number | null) {
    this.draft.update((draft) => ({ ...draft, [field]: value }));
    this.formMessage.set('');
    this.formError.set('');
  }

  private calibration(): Calibration {
    const { longitude, latitude, height, pAxisPitch, pAxisRoll, panOffset, tiltOffset, imageRoll } = this.draft();
    return { longitude, latitude, height, pAxisPitch: pAxisPitch!, pAxisRoll: pAxisRoll!, panOffset: panOffset!,
      tiltOffset: tiltOffset!, imageRoll: imageRoll! };
  }

  async save() {
    if (!this.formValid() || this.saving() || this.operating() || this.scanning() || this.selectedSnapshot()) return;
    const id = this.selectedId();
    const input: CameraInput = {
      name: this.draft().name.trim(), serial: this.draft().serial.trim(), code: this.draft().code.trim(),
      ...this.calibration(),
    };
    const channelChanged = this.selectedCamera()?.serial !== input.serial || this.selectedCamera()?.code !== input.code;
    this.saving.set(true);
    this.formError.set('');
    try {
      const camera = await this.api.saveCamera(id, input);
      this.cameras.update((cameras) => id ? cameras.map((item) => item.id === id ? camera : item) : [...cameras, camera]);
      this.draft.set({ ...input });
      if (!id) this.activate(camera);
      else if (channelChanged) this.loadPlayback();
      this.apiConnected.set(true);
      this.formMessage.set('已保存到数据库');
    } catch (error) {
      this.formError.set(errorMessage(error));
    } finally { this.saving.set(false); }
  }

  pressControl(event: PointerEvent, command: MotionCommand) {
    if (!event.isPrimary || event.button !== 0 || !this.canControl()) return;
    event.preventDefault();
    this.pointerId = event.pointerId;
    this.pressedButton = event.currentTarget as HTMLButtonElement;
    this.holdControl.start(this.selectedId(), command, this.controlSpeed()!);
  }

  keyControl(event: KeyboardEvent, command: MotionCommand) {
    if (![' ', 'Enter'].includes(event.key)) return;
    event.preventDefault();
    if (event.repeat || !this.canControl()) return;
    this.keyboardHeld = true;
    this.holdControl.start(this.selectedId(), command, this.controlSpeed()!);
  }

  @HostListener('document:pointerup', ['$event'])
  @HostListener('document:pointercancel', ['$event'])
  releasePointer(event: PointerEvent) {
    if (event.pointerId === this.pointerId) this.releaseControl();
  }

  leaveControl() { if (this.pointerId !== null) this.releaseControl(); }

  @HostListener('document:pointermove', ['$event'])
  onPointerMove(event: PointerEvent) {
    if (event.pointerId !== this.pointerId || !this.pressedButton) return;
    const rect = this.pressedButton.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) this.releaseControl();
  }

  @HostListener('document:keyup', ['$event'])
  releaseKey(event: KeyboardEvent) {
    if (this.keyboardHeld && [' ', 'Enter'].includes(event.key)) this.releaseControl();
  }

  @HostListener('window:blur')
  releaseControl() {
    this.pointerId = null;
    this.pressedButton = null;
    this.keyboardHeld = false;
    void this.holdControl.release();
  }

  @HostListener('document:visibilitychange')
  onVisibilityChange() { if (document.hidden) this.releaseControl(); }

  @HostListener('window:pagehide')
  onPageHide() { void this.holdControl.release(true); }

  async stopControl() {
    if (this.holdControl.busy) { this.releaseControl(); return; }
    if (!this.selectedId() || this.saving() || this.operating() === 'snapshot') return;
    this.preciseRevision++;
    this.operating.set('control');
    this.stopping.set(true);
    this.operationError.set('');
    this.operationMessage.set('');
    try {
      await this.api.control(this.selectedId(), 'stop', 129);
      this.operationMessage.set('停止指令已发送，状态以回读为准');
    } catch (error) {
      this.operationError.set(errorMessage(error));
    } finally { this.stopping.set(false); this.operating.set(null); }
  }

  editPrecise(field: keyof PreciseTarget, value: number | null) {
    this.preciseTarget.update((target) => ({ ...target, [field]: value }));
  }

  fillPrecise() {
    const raw = this.reading()?.raw;
    if (raw && !this.stale()) this.preciseTarget.set({ pan: raw.Pan, tilt: raw.Tilt, zoom: raw.Zoom });
  }

  async sendPrecise() {
    if (!this.canPrecise()) return;
    const revision = ++this.preciseRevision;
    const id = this.selectedId();
    this.operating.set('precise');
    this.operationError.set('');
    this.operationMessage.set('');
    const { pan, tilt, zoom } = this.preciseTarget();
    try {
      const result = await this.api.precise(id, { pan: pan!, tilt: tilt!, zoom: zoom! });
      if (revision !== this.preciseRevision || this.selectedId() !== id) return;
      this.controlTarget.set(result.target);
      this.operationMessage.set('精确定位指令已发送，位置以回读为准');
    } catch (error) {
      if (revision === this.preciseRevision && this.selectedId() === id) this.operationError.set(errorMessage(error));
    } finally { if (revision === this.preciseRevision && this.operating() === 'precise') this.operating.set(null); }
  }

  async capture() {
    if (!this.canCapture()) return;
    this.operating.set('snapshot');
    this.operationError.set('');
    this.operationMessage.set('');
    try {
      const snapshot = await this.api.capture(this.selectedId(), this.calibration());
      this.lastSnapshot.set(snapshot);
      this.hidePreview.set(false);
      this.reading.set(snapshot.ptzAfter);
      this.stale.set(false);
      this.operationMessage.set(snapshot.poseChanged ? '截图已保存，采样期间姿态有变化' : '截图已保存');
      await this.loadSnapshots();
    } catch (error) {
      this.operationError.set(errorMessage(error));
    } finally { this.operating.set(null); }
  }

  async startSnapshotScan() {
    if (!this.canScan()) return;
    const id = this.selectedId();
    const calibration = this.calibration();
    const panMin = this.scanPanMin()!;
    const panMax = this.scanPanMax()!;
    const horizon = this.scanMode() === 'horizon'
      ? { preScanZoom: this.preScanZoom()!, tiltMin: this.scanTiltMin()!, tiltMax: this.scanTiltMax()! } : undefined;
    this.operating.set('scan');
    this.operationError.set('');
    this.operationMessage.set('');
    try {
      const reading = await firstValueFrom(this.api.ptz(id));
      const { Pan: pan, Tilt: tilt, Zoom: zoom } = reading.raw;
      if (horizon && (horizon.preScanZoom >= zoom || tilt < horizon.tiltMin || tilt > horizon.tiltMax)) {
        this.operationError.set('当前回读已变化：预扫倍率须低于当前倍率，且当前 T 须位于允许范围内');
        return;
      }
      const group = await this.api.startSnapshotScan(id, { pan, tilt, zoom }, panMin, panMax, calibration, horizon);
      this.snapshotGroups.update((groups) => [group, ...groups]);
      this.snapshotTaskId.set(group.id);
      this.operationMessage.set(horizon
        ? `海天线预扫描已开始，计划 ${group.sampleCount} 张，固定 T ${tilt}° / Z ${horizon.preScanZoom}，正式目标 Z ${zoom}`
        : `自动截图已开始，计划 ${group.sampleCount} 张，固定 T ${tilt}° / Z ${zoom}`);
    } catch (error) { this.operationError.set(errorMessage(error)); }
    finally { this.operating.set(null); }
  }

  async scanAction(action: 'pause' | 'start') {
    const group = this.currentScan();
    if (!group || this.operating() || this.saving()) return;
    this.operating.set('scan');
    this.operationError.set('');
    try {
      const updated = await this.api.taskAction(group.id, action);
      this.snapshotGroups.update((groups) => groups.map((item) => item.id === updated.id ? updated : item));
      this.operationMessage.set(`${this.taskName(updated)}${this.taskStatuses[updated.status]}${action === 'start' ? '，沿用本任务原采样计划' : ''}`);
    } catch (error) { this.operationError.set(errorMessage(error)); }
    finally { this.operating.set(null); }
  }

  async loadSnapshots(id = this.selectedId(), append = false) {
    if (!id) return;
    const offset = append ? this.nextGroupOffset() : 0;
    if (offset === null) return;
    const revision = ++this.historyRevision;
    this.historyLoading.set(true);
    try {
      const page = await this.api.snapshotGroups(id, offset);
      if (this.selectedId() !== id || revision !== this.historyRevision) return;
      const previous = this.snapshotGroups().find((group) => group.id === this.expandedGroupId());
      const ids = new Set(page.groups.map((group) => group.id));
      this.snapshotGroups.update((groups) => append
        ? [...groups.filter((group) => !ids.has(group.id)), ...page.groups]
        : [...page.groups, ...groups.filter((group) => !ids.has(group.id))]);
      this.nextGroupOffset.set(this.snapshotGroups().length < page.total ? this.snapshotGroups().length : null);
      const expanded = page.groups.find((group) => group.id === this.expandedGroupId());
      if (expanded && expanded.snapshotCount !== previous?.snapshotCount) {
        if (this.snapshots().length < 50 && !this.groupLoading()) void this.loadGroupSnapshots();
        else this.nextSnapshotOffset.set(expanded.snapshotCount > this.snapshots().length ? this.snapshots().length : null);
      }
    } catch (error) {
      if (this.selectedId() === id && revision === this.historyRevision) this.pageError.set(errorMessage(error));
    } finally {
      if (revision === this.historyRevision) this.historyLoading.set(false);
    }
  }

  toggleGroup(group: SnapshotGroup) {
    this.groupRevision++;
    this.expandedGroupId.set(this.expandedGroupId() === group.id ? '' : group.id);
    this.snapshots.set([]);
    this.nextSnapshotOffset.set(null);
    if (this.expandedGroupId()) void this.loadGroupSnapshots();
  }

  async loadGroupSnapshots(append = false) {
    const id = this.expandedGroupId();
    const revision = this.groupRevision;
    const offset = append ? this.nextSnapshotOffset() : 0;
    if (!id || offset === null) return;
    this.groupLoading.set(true);
    try {
      const page = await this.api.groupSnapshots(id, offset);
      if (this.expandedGroupId() !== id || revision !== this.groupRevision) return;
      const ids = new Set(this.snapshots().map((snapshot) => snapshot.id));
      this.snapshots.set(append ? [...this.snapshots(), ...page.snapshots.filter((snapshot) => !ids.has(snapshot.id))] : page.snapshots);
      this.nextSnapshotOffset.set(page.nextOffset);
    } catch (error) {
      if (this.expandedGroupId() === id && revision === this.groupRevision) this.pageError.set(errorMessage(error));
    } finally { if (revision === this.groupRevision) this.groupLoading.set(false); }
  }

  forgetSnapshot(snapshot: Snapshot) {
    if (this.selectedSnapshot()?.id === snapshot.id) this.selectedSnapshot.set(null);
    if (this.lastSnapshot()?.id === snapshot.id) this.lastSnapshot.set(null);
    this.snapshots.update((snapshots) => snapshots.filter((item) => item.id !== snapshot.id));
    this.snapshotGroups.update((groups) => groups.filter((group) => group.kind !== 'single' || group.id !== snapshot.id));
  }

  async deleteSnapshot(snapshot: Snapshot) {
    if (this.deletingSnapshot() || this.operating() || this.saving()) return;
    this.deletingSnapshot.set(true);
    try {
      await this.api.deleteSnapshot(snapshot.id);
      this.forgetSnapshot(snapshot);
      if (this.expandedGroupId() === snapshot.id) this.expandedGroupId.set('');
      await this.loadSnapshots();
      if (this.expandedGroupId()) await this.loadGroupSnapshots();
    } catch (error) { this.pageError.set(errorMessage(error)); }
    finally { this.deletingSnapshot.set(false); }
  }

  openTaskSnapshot(snapshot: Snapshot) {
    if (this.operating() || this.saving()) return;
    if (snapshot.cameraId !== this.selectedId()) {
      const camera = this.cameras().find((item) => item.id === snapshot.cameraId);
      if (!camera) return;
      if (this.isDirty() && !window.confirm('当前参数尚未保存，确定切换并放弃修改？')) return;
      this.activate(camera);
    }
    this.plotNavigationRevision++;
    this.plotFocusRequest.set(null);
    this.page.set('scene');
    this.viewSnapshot(snapshot);
  }

  async togglePanel(panel: 'devices' | 'snapshots') {
    const previous = this.panel();
    if (!await this.openPage('scene')) return;
    this.showPlotPanel.set(false);
    this.panel.set(previous === panel ? null : panel);
    if (this.panel() === 'snapshots') void this.loadSnapshots();
  }

  viewSnapshot(snapshot: Snapshot) {
    if (this.operating() || this.saving()) return;
    this.plotNavigationRevision++;
    this.plotFocusRequest.set(null);
    this.selectedSnapshot.set(snapshot);
    this.hidePreview.set(false);
    this.following.set(true);
    this.panel.set(null);
  }

  exitHistory() { this.selectedSnapshot.set(null); }
  bestView() { this.scene?.focus(); }
  overview() { this.following.set(false); this.scene?.overview(); }
  ngOnDestroy() {
    this.plotNavigationRevision++;
    this.playbackSubscription?.unsubscribe();
    void this.holdControl.release(true);
  }
}
