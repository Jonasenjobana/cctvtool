import {
  ChangeDetectionStrategy, Component, ElementRef, EventEmitter, Input, NgZone, Output, ViewChild, inject, signal,
} from '@angular/core';
import type { AfterViewInit, OnChanges, OnDestroy, SimpleChanges } from '@angular/core';
import {
  ArcType, Cartesian2, Cartesian3, Color, ConstantPositionProperty, ConstantProperty, Ellipsoid, EllipsoidalOccluder, Entity, GeometryInstance,
  HeadingPitchRange, LabelStyle, Material, MaterialAppearance, Matrix3, Matrix4, PerspectiveFrustum, PlaneGeometry, PolylineCollection,
  Primitive, Quaternion, SceneTransforms, Transforms, Viewer,
} from 'cesium';
import type { Polyline } from 'cesium';
import { createCameraPose, createZeroPosePreview, footprintSegments, frustumCorners, imageDragZoomBox, observationFov, vesselCorners, videoFovPlane } from './camera-math';
import type { CameraBasis, CameraPose, ScreenBox, VesselDimensions } from './camera-math';
import type { ZeroPose } from '#zero-pose';
import type { CameraDraft, DragZoomBox, DragZoomDirection, PtzReading } from './models';
import { createAmapImagery } from './amap-imagery';
import { startVideoFrameLoop } from './video-frame-loop';
import { createVideoMaterial } from './video-material';
import { PlotLayerScene } from './plot-layer-scene';
import type { PlotLayerError, PlotLayerFocusRequest, PlotLayerFocusResult, PlotLayerRenderInput } from './plot-layer.models';
import { AisScene } from './ais-scene';
import type { VesselBodyDimensions, VesselSourceInfo, VesselTarget } from './ais.models';

const videoPlaneDistance = 500;

export interface TemporaryMapPoint {
  id: number;
  longitude: number;
  latitude: number;
  vessel?: VesselDimensions;
}

/** 纹理上传失败时关闭画面截面，让底图和控制界面继续工作。 */
class VideoPlanePrimitive extends Primitive {
  private readonly failed: (error: unknown) => void;

  constructor(options: ConstructorParameters<typeof Primitive>[0], failed: (error: unknown) => void) {
    super(options);
    this.failed = failed;
  }

  override update(): void {
    try {
      // Cesium 的类型声明省略了内部 frameState，转发实际实参。
      Reflect.apply(Primitive.prototype.update, this, arguments);
    } catch (error) {
      this.show = false;
      this.failed(error);
    }
  }
}

export type ZeroPoseView = 'current' | 'external' | 'lens';

@Component({
  selector: 'app-camera-scene',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div #container class="cesium-host"></div>@if (snapshotUrl) { <img hidden [src]="snapshotUrl" alt="" (load)="onSnapshotLoad($event)" (error)="onSnapshotError()"> }@if (problem()) { <div class="scene-problem" role="status">{{ problem() }}</div> }@if (videoProblem()) { <div class="scene-problem video-problem" role="alert">{{ videoProblem() }}</div> }
    @if (dragZoom) {
      <div class="drag-zoom-surface" [class.busy]="dragZoomBusy"
        (pointerdown)="startZoomDrag($event)" (pointermove)="moveZoomDrag($event)" (pointerup)="finishZoomDrag($event)"
        (pointercancel)="cancelZoomDrag($event.pointerId)" (lostpointercapture)="cancelZoomDrag($event.pointerId)"
        (wheel)="$event.preventDefault()" (contextmenu)="$event.preventDefault()">
        @if (zoomSelection(); as box) {
          <div class="drag-zoom-box" [style.left.px]="box.left" [style.top.px]="box.top"
            [style.width.px]="box.width" [style.height.px]="box.height"></div>
        }
      </div>
    }
  `,
  styles: `:host{display:block;position:absolute;inset:0}.cesium-host{position:absolute;inset:0}.scene-problem{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);max-width:360px;background:rgba(255,255,255,.95);color:#4d5563;padding:12px 18px;border:1px solid #e2e6ec;border-radius:4px;font-size:13px;line-height:1.7;text-align:center;pointer-events:none}.video-problem{top:80px;transform:translateX(-50%);color:#b65345}
    .drag-zoom-surface{position:absolute;inset:0;cursor:crosshair;touch-action:none;user-select:none}
    .drag-zoom-surface.busy{cursor:progress}
    .drag-zoom-box{position:absolute;box-sizing:border-box;border:1px solid #3687ff;background:rgba(54,135,255,.18);pointer-events:none}
  `,
})
export class CameraSceneComponent implements AfterViewInit, OnChanges, OnDestroy {
  @ViewChild('container', { static: true }) container!: ElementRef<HTMLDivElement>;
  @Input() camera: CameraDraft | null = null;
  @Input() reading: PtzReading | null = null;
  @Input() zeroPosePreview: { pose: ZeroPose; view: ZeroPoseView; showDraft: boolean } | null = null;
  @Input() following = true;
  @Input() dragZoom: DragZoomDirection | null = null;
  @Input() dragZoomBusy = false;
  @Output() readonly zoomBoxSelected = new EventEmitter<DragZoomBox>();
  readonly zoomSelection = signal<ScreenBox | null>(null);
  private zoomDrag?: { pointerId: number; start: Cartesian2; bounds: ScreenBox; length: number; width: number };
  @Input() video: HTMLVideoElement | null = null;
  @Input() snapshotUrl: string | null = null;
  @Input() videoOpacity = 1;
  @Input() plotLayers: readonly PlotLayerRenderInput[] = [];
  @Input() plotFocus: PlotLayerFocusRequest | null = null;
  @Input() temporaryPoints: readonly TemporaryMapPoint[] = [];
  @Input() vessels: readonly VesselTarget[] = [];
  @Input() vesselSource: VesselSourceInfo | null = null;
  @Input() vesselBodies: ReadonlyMap<string, VesselBodyDimensions> = new Map();
  @Input() useVesselBodyGeometry = false;
  @Input() trackedMmsi = '';
  @Input() predictedMmsi = '';
  @Output() readonly vesselSelected = new EventEmitter<string>();
  @Output() readonly plotLayerError = new EventEmitter<PlotLayerError>();
  @Output() readonly plotFocusResult = new EventEmitter<PlotLayerFocusResult>();
  readonly problem = signal('');
  readonly videoProblem = signal('');
  private readonly zone = inject(NgZone);
  private viewer?: Viewer;
  private lines?: PolylineCollection;
  private readonly lineMap = new Map<string, Polyline>();
  private readonly temporaryPointEntities = new Map<number, { entity: Entity; position: Cartesian3; input: TemporaryMapPoint }>();
  private readonly previewEntities = new Map<string, Entity>();
  private marker?: Entity;
  private pose?: CameraPose;
  private previewBasis?: CameraBasis;
  private previewView?: ZeroPoseView;
  private observer?: ResizeObserver;
  private previousKey = '';
  private wasFollowing = false;
  private videoPlane?: Primitive;
  private videoMaterial?: ReturnType<typeof createVideoMaterial>;
  private boundMedia?: HTMLVideoElement | HTMLImageElement;
  private snapshotImage?: HTMLImageElement;
  private videoDimensions = '';
  private videoFailed = false;
  private stopVideoFrames?: () => void;
  private stopVisibility?: () => void;
  private plotScene?: PlotLayerScene;
  private aisScene?: AisScene;
  private sceneFailed = false;
  private readonly occluder = new EllipsoidalOccluder(Ellipsoid.WGS84);

  ngAfterViewInit() {
    this.zone.runOutsideAngular(() => {
      try {
        Object.assign(window, { CESIUM_BASE_URL: '/Cesium/' });
        this.viewer = new Viewer(this.container.nativeElement, {
          animation: false, timeline: false, baseLayerPicker: false, geocoder: false,
          homeButton: false, sceneModePicker: false, navigationHelpButton: false,
          fullscreenButton: false, infoBox: false, selectionIndicator: false,
          baseLayer: false, requestRenderMode: true, maximumRenderTimeChange: Infinity,
        });
        this.viewer.imageryLayers.addImageryProvider(createAmapImagery());
        this.viewer.scene.globe.depthTestAgainstTerrain = false;
        this.viewer.scene.screenSpaceCameraController.minimumZoomDistance = 0.1;
        this.viewer.scene.screenSpaceCameraController.enableInputs = !this.dragZoom;
        this.stopVisibility = this.viewer.scene.preRender.addEventListener(() => {
          this.occluder.cameraPosition = this.viewer!.camera.positionWC;
          if (this.videoPlane && this.pose) this.videoPlane.show = !this.videoFailed && this.occluder.isPointVisible(this.pose.position);
          for (const { entity, position } of this.temporaryPointEntities.values()) {
            entity.show = this.occluder.isPointVisible(position);
          }
        });
        this.lines = this.viewer.scene.primitives.add(new PolylineCollection());
        this.marker = this.viewer.entities.add({
          show: false,
          point: { pixelSize: 8, color: Color.fromCssColorString('#3687ff'), outlineColor: Color.WHITE, outlineWidth: 2 },
          label: { text: '摄像头', font: '12px sans-serif', fillColor: Color.WHITE,
            outlineColor: Color.BLACK, outlineWidth: 2, style: LabelStyle.FILL_AND_OUTLINE },
        });
        this.observer = new ResizeObserver(() => {
          if (!this.viewer || this.viewer.isDestroyed()) return;
          this.cancelZoomDrag();
          this.viewer.resize();
          this.focusIfFollowing();
          this.viewer.scene.requestRender();
        });
        this.observer.observe(this.container.nativeElement);
        this.syncTemporaryPoints();
        this.aisScene = new AisScene(this.viewer, mmsi => this.zone.run(() => this.vesselSelected.emit(mmsi)),
          () => !this.snapshotUrl && !!this.videoPlane?.show && this.videoOpacity > 0 && this.videoMaterial?.uniforms.hasAisPixels === true);
        this.aisScene.sync(this.vessels, this.vesselSource, this.trackedMmsi, this.vesselBodies, this.useVesselBodyGeometry, this.predictedMmsi);
        this.update();
        this.plotScene = new PlotLayerScene(this.viewer,
          (error) => this.zone.run(() => this.plotLayerError.emit(error)),
          (result) => this.zone.run(() => this.plotFocusResult.emit(result)));
        this.plotScene.sync(this.plotLayers);
        this.plotScene.focus(this.plotFocus);
      } catch (error) {
        this.sceneFailed = true;
        this.problem.set('三维场景初始化失败，请检查显卡与 WebGL 支持');
        this.rejectPlotFocus();
        console.error('Cesium 初始化失败', error);
      }
    });
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['dragZoom'] || changes['dragZoomBusy'] || changes['video']) this.cancelZoomDrag();
    if (changes['dragZoom'] && this.viewer && !this.viewer.isDestroyed()) {
      this.viewer.scene.screenSpaceCameraController.enableInputs = !this.dragZoom;
    }
    if (changes['snapshotUrl']) {
      this.snapshotImage = undefined;
      this.releaseVideo();
    }
    this.aisScene?.sync(this.vessels, this.vesselSource, this.trackedMmsi, this.vesselBodies, this.useVesselBodyGeometry, this.predictedMmsi);
    this.update();
    if (changes['dragZoom'] && this.dragZoom) this.focus();
    if (changes['temporaryPoints']) this.syncTemporaryPoints();
    if (changes['plotLayers']) this.plotScene?.sync(this.plotLayers);
    if (changes['plotFocus']) {
      this.plotScene?.focus(this.plotFocus);
      if (this.sceneFailed) this.rejectPlotFocus();
    }
  }

  private rejectPlotFocus() {
    if (!this.plotFocus) return;
    const requestId = this.plotFocus.requestId;
    this.zone.run(() => this.plotFocusResult.emit({
      requestId, success: false, message: '三维场景初始化失败，无法定位标绘图层',
    }));
  }

  onSnapshotLoad(event: Event) {
    this.snapshotImage = event.target as HTMLImageElement;
    this.updateVideo();
  }

  onSnapshotError() {
    this.snapshotImage = undefined;
    this.releaseVideo();
    this.videoProblem.set('历史快照加载失败，请重新选择记录或打开原图检查');
  }

  private setLine(id: string, positions: Cartesian3[], color: Color, width = 2) {
    let line = this.lineMap.get(id);
    if (!line) {
      line = this.lines!.add({ positions, width, material: Material.fromType('Color', { color }) });
      this.lineMap.set(id, line!);
    }
    line!.positions = positions;
    line!.show = true;
  }

  private syncTemporaryPoints() {
    const viewer = this.viewer;
    if (!viewer || viewer.isDestroyed()) return;
    const ids = new Set(this.temporaryPoints.map((point) => point.id));
    for (const [id, { entity }] of this.temporaryPointEntities) {
      if (!ids.has(id)) {
        viewer.entities.remove(entity);
        this.temporaryPointEntities.delete(id);
      }
    }
    for (const point of this.temporaryPoints) {
      const previous = this.temporaryPointEntities.get(point.id);
      if (previous?.input === point) continue;
      if (previous) viewer.entities.remove(previous.entity);
      const position = Cartesian3.fromDegrees(point.longitude, point.latitude, 0);
      const footprint = point.vessel ? vesselCorners(point, point.vessel).slice(0, 4) : null;
      // 点和标签在视频截面上方可见；地球背面仍由同一椭球遮挡判断隐藏。
      const entity = viewer.entities.add({
        id: `temporary-point-${point.id}`, position,
        point: { pixelSize: 10, color: Color.YELLOW, outlineColor: Color.BLACK, outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: { text: `点 ${point.id}`, font: '12px sans-serif', pixelOffset: new Cartesian2(0, -18),
          fillColor: Color.WHITE, outlineColor: Color.BLACK, outlineWidth: 2, style: LabelStyle.FILL_AND_OUTLINE,
          disableDepthTestDistance: Number.POSITIVE_INFINITY },
        polyline: footprint ? { positions: [...footprint, footprint[0]], width: 2, arcType: ArcType.NONE,
          material: Color.YELLOW, depthFailMaterial: Color.YELLOW, clampToGround: false } : undefined,
      });
      this.temporaryPointEntities.set(point.id, { entity, position, input: point });
    }
    viewer.scene.requestRender();
  }

  private usesCurrentView() {
    return !this.zeroPosePreview || this.zeroPosePreview.view === 'current';
  }

  private focusIfFollowing() {
    if (this.zeroPosePreview?.view === 'lens' || (this.usesCurrentView() && (this.following || this.dragZoom) && this.pose)) this.focus();
  }

  private update() {
    const viewer = this.viewer;
    if (!viewer || viewer.isDestroyed()) return;
    const raw = this.reading?.raw;
    const preview = this.zeroPosePreview;
    const currentView = this.usesCurrentView();
    const key = JSON.stringify([this.camera, preview, raw?.Pan, raw?.Tilt, raw?.Zoom, raw?.HorizontalFieldAngle, raw?.VerticalFieldAngle]);
    if (key === this.previousKey) {
      if (currentView && this.following && !this.wasFollowing && this.pose) this.focus();
      this.wasFollowing = this.following;
      this.updateVideo();
      return;
    }
    this.cancelZoomDrag();
    const exterior = preview?.view === 'external';
    const centerExterior = exterior && (this.previewView !== 'external' || !this.previewBasis);
    const openingEditor = preview?.view === 'current' && this.previewView === undefined;
    this.previewView = preview?.view;
    this.previousKey = key;
    this.pose = undefined;
    this.previewBasis = undefined;
    for (const line of this.lineMap.values()) line.show = false;
    for (const entity of this.previewEntities.values()) entity.show = false;
    if (this.marker) this.marker.show = false;
    try {
      if (!this.camera) throw new Error('请选择或注册摄像头');
      if (this.camera.longitude !== null && this.camera.latitude !== null && this.camera.height !== null && this.marker) {
        this.marker.position = new ConstantPositionProperty(Cartesian3.fromDegrees(this.camera.longitude, this.camera.latitude, this.camera.height));
        this.marker.show = currentView;
      }
      if (preview) {
        const geometry = createZeroPosePreview(this.camera, preview.showDraft ? preview.pose : null, raw ?? null);
        this.previewBasis = geometry.basis;
        this.pose = geometry.pose ?? undefined;
        if (exterior) this.drawZeroPoseModel(geometry.basis);
      } else {
        if (!raw) throw new Error('等待有效的 PTZ 回读');
        this.pose = createCameraPose(this.camera, raw);
      }
      const pose = this.pose;
      if (pose) {
        const corners = frustumCorners(pose, videoPlaneDistance);
        const frustumColor = Color.fromCssColorString('#ffd77a');
        corners.forEach((corner, index) => this.setLine(`ray-${index}`, [pose.position, corner], frustumColor));
        this.setLine('frame', [...corners, corners[0]], frustumColor);
        if (currentView) {
          this.setLine('axis', [pose.position, Cartesian3.add(pose.position,
            Cartesian3.multiplyByScalar(pose.panAxis, 50, new Cartesian3()), new Cartesian3())], Color.fromCssColorString('#68cda4'));
        }
        footprintSegments(pose).forEach((points, index) => this.setLine(`footprint-${index}`, points, Color.fromCssColorString('#54c5ff'), 3));
      }
      this.problem.set(preview && raw && !pose ? '回读视场角无效，当前显示相机姿态' : '');
      if (centerExterior) this.focusZeroPoseExterior();
      else if (!openingEditor) this.focusIfFollowing();
    } catch (error) {
      this.problem.set(error instanceof Error ? error.message : '无法生成当前视场');
    }
    this.wasFollowing = this.following;
    this.updateVideo();
    viewer.scene.requestRender();
  }

  private drawZeroPoseModel(basis: CameraBasis) {
    const { position, right, direction, up } = basis;
    const rotation = new Matrix3(right.x, direction.x, up.x, right.y, direction.y, up.y, right.z, direction.z, up.z);
    const orientation = Quaternion.fromRotationMatrix(rotation);
    const modelFrame = Matrix4.fromRotationTranslation(rotation, position);
    this.showPreviewEntity('body', Matrix4.multiplyByPoint(modelFrame, new Cartesian3(0, -5.5, 0), new Cartesian3()), {
      box: { dimensions: new Cartesian3(5, 7, 4), material: Color.fromCssColorString('#52617a') },
    }, orientation);
    // Cesium 圆柱沿自身 Z 轴，旋到相机 Y 轴后，镜头前端位于光轴起点。
    const lensOrientation = Quaternion.multiply(orientation,
      Quaternion.fromAxisAngle(Cartesian3.UNIT_X, -Math.PI / 2), new Quaternion());
    this.showPreviewEntity('lens', Matrix4.multiplyByPoint(modelFrame, new Cartesian3(0, -1, 0), new Cartesian3()), {
      cylinder: { length: 2, topRadius: 1.5, bottomRadius: 1.5, slices: 32, material: Color.fromCssColorString('#263a53') },
    }, lensOrientation);
    const enu = Transforms.eastNorthUpToFixedFrame(position);
    const axes = [
      ['east', '东', Matrix4.multiplyByPoint(enu, new Cartesian3(15, 0, 0), new Cartesian3()), Color.SALMON],
      ['north', '北', Matrix4.multiplyByPoint(enu, new Cartesian3(0, 15, 0), new Cartesian3()), Color.LIGHTGREEN],
      ['up', '天', Matrix4.multiplyByPoint(enu, new Cartesian3(0, 0, 15), new Cartesian3()), Color.SKYBLUE],
      ['optical', '光轴', Matrix4.multiplyByPoint(modelFrame, new Cartesian3(0, 26, 0), new Cartesian3()), Color.GOLD],
    ] as const;
    for (const [key, label, end, color] of axes) {
      this.setLine(`preview-${key}`, [position, end], color, 3);
      this.showPreviewEntity(key, end, {
        label: { text: label, font: '12px sans-serif', fillColor: color, outlineColor: Color.BLACK,
          outlineWidth: 2, style: LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cartesian2(0, -8) },
      });
    }
  }

  private showPreviewEntity(key: string, position: Cartesian3, options: Entity.ConstructorOptions, orientation?: Quaternion) {
    let entity = this.previewEntities.get(key);
    if (!entity) {
      entity = this.viewer!.entities.add(options);
      this.previewEntities.set(key, entity);
    }
    entity.position = new ConstantPositionProperty(position);
    if (orientation) entity.orientation = new ConstantProperty(orientation);
    entity.show = true;
  }

  private updateVideo() {
    const viewer = this.viewer;
    if (!viewer || viewer.isDestroyed()) return;
    const image = this.snapshotUrl ? this.snapshotImage : undefined;
    const video = this.snapshotUrl ? null : this.video;
    const source = image || video;
    const width = image?.naturalWidth || video?.videoWidth || 0;
    const height = image?.naturalHeight || video?.videoHeight || 0;
    if (!this.pose || !source || !width || !height || (video && video.readyState < 2)) {
      if (this.boundMedia) this.releaseVideo();
      return;
    }
    const dimensions = `${width}x${height}`;
    const plane = videoFovPlane(this.pose, videoPlaneDistance);
    if (source !== this.boundMedia || dimensions !== this.videoDimensions) {
      this.releaseVideo();
      this.boundMedia = source;
      this.videoDimensions = dimensions;
      try {
        this.videoMaterial = createVideoMaterial(source, plane.uvScale, this.videoOpacity);
        this.videoPlane = viewer.scene.primitives.add(new VideoPlanePrimitive({
          geometryInstances: new GeometryInstance({ geometry: new PlaneGeometry({
            vertexFormat: MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
          }) }),
          appearance: new MaterialAppearance({ material: this.videoMaterial, flat: true, translucent: true,
            // 画面截面可能穿入近似海面，关闭深度测试以保留完整画面。
            renderState: { depthTest: { enabled: false }, depthMask: false } }),
          // 可见性由摄像头位置判断，避免截面穿入椭球后被整块裁掉。
          asynchronous: false, allowPicking: false, cull: false,
        }, (error) => this.onVideoFailure(error)));
        if (video) {
          this.stopVideoFrames = this.zone.runOutsideAngular(() => startVideoFrameLoop(video, () => {
            if (`${video.videoWidth}x${video.videoHeight}` !== this.videoDimensions) this.updateVideo();
            viewer.scene.requestRender();
          }));
        } else {
          // Cesium 先将图片入队，下一帧才上传纹理；静态截图需要再请求一次绘制。
          this.stopVideoFrames = viewer.scene.postRender.addEventListener(() => {
            this.stopVideoFrames?.();
            this.stopVideoFrames = undefined;
            viewer.scene.requestRender();
          });
        }
      } catch (error) {
        this.onVideoFailure(error);
      }
    }
    if (this.videoFailed || !this.videoPlane || !this.videoMaterial) return;
    Matrix4.clone(plane.matrix, this.videoPlane.modelMatrix);
    this.videoMaterial.uniforms.uvScale = plane.uvScale;
    this.videoMaterial.uniforms.opacity = this.videoOpacity;
    if (video) {
      const projection = this.videoOpacity > 0 ? this.aisScene?.projectVideoPixels(this.pose, plane.matrix, width, height) : undefined;
      this.videoMaterial.setAisPixels(projection?.pixels ?? [], width, height, projection?.radius ?? 0);
    }
    viewer.scene.requestRender();
  }

  private onVideoFailure(error: unknown) {
    this.cancelZoomDrag();
    this.videoFailed = true;
    if (this.videoPlane) this.videoPlane.show = false;
    this.viewer?.scene.requestRender();
    this.stopVideoFrames?.();
    this.stopVideoFrames = undefined;
    const media = this.snapshotUrl ? '历史快照' : '视频';
    const retry = this.snapshotUrl ? '请重新选择快照' : '请重新连接视频';
    this.videoProblem.set(`${media}纹理加载失败：${error instanceof Error ? error.message : String(error)}，${retry}`);
    console.error(`Cesium ${media}纹理加载失败`, error);
  }

  private releaseVideo() {
    this.cancelZoomDrag();
    this.aisScene?.clearVideoProjection();
    this.stopVideoFrames?.();
    this.stopVideoFrames = undefined;
    if (this.videoPlane) this.viewer!.scene.primitives.remove(this.videoPlane);
    this.videoMaterial?.destroy();
    this.videoPlane = undefined;
    this.videoMaterial = undefined;
    this.boundMedia = undefined;
    this.videoDimensions = '';
    this.videoFailed = false;
    this.videoProblem.set('');
    this.viewer?.scene.requestRender();
  }

  canBoxZoom() {
    return !!this.pose && !!this.videoPlane && this.boundMedia === this.video && !this.videoFailed && (this.video?.readyState ?? 0) >= 2;
  }

  startZoomDrag(event: PointerEvent) {
    if (event.button !== 0 || !event.isPrimary || this.zoomDrag || this.dragZoomBusy || !this.canBoxZoom()) return;
    const surface = event.currentTarget as HTMLElement;
    const scene = this.viewer!.scene;
    const [upperLeft, , lowerRight] = frustumCorners(this.pose!, videoPlaneDistance);
    const first = SceneTransforms.worldToWindowCoordinates(scene, upperLeft);
    const last = SceneTransforms.worldToWindowCoordinates(scene, lowerRight);
    if (!first || !last || first.x >= last.x || first.y >= last.y) return;
    const origin = surface.getBoundingClientRect();
    const canvas = scene.canvas.getBoundingClientRect();
    const bounds = {
      left: canvas.left - origin.left + first.x, top: canvas.top - origin.top + first.y,
      width: last.x - first.x, height: last.y - first.y,
    };
    const start = new Cartesian2(event.clientX - origin.left, event.clientY - origin.top);
    if (start.x < bounds.left || start.x > bounds.left + bounds.width
      || start.y < bounds.top || start.y > bounds.top + bounds.height) return;
    event.preventDefault();
    surface.setPointerCapture(event.pointerId);
    this.zoomDrag = { pointerId: event.pointerId, start, bounds, length: this.video!.videoWidth, width: this.video!.videoHeight };
  }

  moveZoomDrag(event: PointerEvent) {
    const drag = this.zoomDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const origin = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const { start, bounds } = drag;
    const x = Math.min(bounds.left + bounds.width, Math.max(bounds.left, event.clientX - origin.left));
    const y = Math.min(bounds.top + bounds.height, Math.max(bounds.top, event.clientY - origin.top));
    this.zoomSelection.set({ left: Math.min(start.x, x), top: Math.min(start.y, y),
      width: Math.abs(x - start.x), height: Math.abs(y - start.y) });
  }

  finishZoomDrag(event: PointerEvent) {
    const drag = this.zoomDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    this.moveZoomDrag(event);
    const selection = this.zoomSelection();
    this.cancelZoomDrag();
    if (!selection || selection.width < 4 || selection.height < 4 || !this.canBoxZoom()
      || this.video!.videoWidth !== drag.length || this.video!.videoHeight !== drag.width) return;
    const { bounds, length, width } = drag;
    const box = imageDragZoomBox(selection, bounds, length, width);
    if (box) this.zoomBoxSelected.emit(box);
  }

  cancelZoomDrag(pointerId?: number) {
    if (pointerId !== undefined && this.zoomDrag?.pointerId !== pointerId) return;
    this.zoomDrag = undefined;
    this.zoomSelection.set(null);
  }

  focus() {
    const basis = this.previewBasis ?? this.pose;
    if (!this.viewer || !basis) return;
    const camera = this.viewer.camera;
    const aspect = Math.max(1, this.container.nativeElement.clientWidth) / Math.max(1, this.container.nativeElement.clientHeight);
    const frustum = camera.frustum as PerspectiveFrustum;
    frustum.aspectRatio = aspect;
    frustum.fov = this.pose ? observationFov(this.pose, aspect) : Math.PI / 3;
    frustum.near = 0.1;
    frustum.far = 50000000;
    camera.cancelFlight();
    camera.lookAtTransform(Matrix4.IDENTITY);
    camera.setView({ destination: basis.position, orientation: { direction: basis.direction, up: basis.up } });
    this.viewer.scene.requestRender();
  }

  focusZeroPoseExterior() {
    if (!this.viewer || !this.previewBasis) return;
    const camera = this.viewer.camera;
    (camera.frustum as PerspectiveFrustum).fov = Math.PI / 3;
    camera.cancelFlight();
    camera.lookAt(this.previewBasis.position, new HeadingPitchRange(3 * Math.PI / 4, -Math.PI / 6, 45));
    camera.lookAtTransform(Matrix4.IDENTITY);
    this.viewer.scene.requestRender();
  }

  focusTemporaryPoint(point: TemporaryMapPoint) {
    if (!this.viewer) return;
    const camera = this.viewer.camera;
    (camera.frustum as PerspectiveFrustum).fov = Math.PI / 3;
    camera.cancelFlight();
    camera.lookAt(Cartesian3.fromDegrees(point.longitude, point.latitude, 0), new HeadingPitchRange(0, -Math.PI / 3, 1500));
    camera.lookAtTransform(Matrix4.IDENTITY);
    this.viewer.scene.requestRender();
  }

  overview() {
    if (!this.viewer || !this.camera || this.camera.longitude === null || this.camera.latitude === null) return;
    const frustum = this.viewer.camera.frustum as PerspectiveFrustum;
    frustum.fov = Math.PI / 3;
    this.viewer.camera.setView({
      destination: Cartesian3.fromDegrees(this.camera.longitude, this.camera.latitude, Math.max(1500, (this.camera.height || 0) + 1500)),
      orientation: { heading: 0, pitch: -Math.PI / 3, roll: 0 },
    });
    this.viewer.scene.requestRender();
  }

  ngOnDestroy() {
    this.aisScene?.destroy();
    this.aisScene = undefined;
    this.plotScene?.destroy();
    this.plotScene = undefined;
    this.observer?.disconnect();
    this.stopVisibility?.();
    this.releaseVideo();
    if (this.viewer && !this.viewer.isDestroyed()) this.viewer.destroy();
    this.lineMap.clear();
    this.temporaryPointEntities.clear();
    this.previewEntities.clear();
  }
}
