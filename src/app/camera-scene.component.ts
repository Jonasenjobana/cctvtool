import {
  ChangeDetectionStrategy, Component, ElementRef, Input, NgZone, ViewChild, inject, signal,
} from '@angular/core';
import type { AfterViewInit, OnChanges, OnDestroy, SimpleChanges } from '@angular/core';
import {
  Cartesian3, Color, ConstantPositionProperty, Ellipsoid, EllipsoidalOccluder, Entity, GeometryInstance,
  LabelStyle, Material, MaterialAppearance, Matrix4, PerspectiveFrustum, PlaneGeometry, PolylineCollection, Primitive, Viewer,
} from 'cesium';
import type { Polyline } from 'cesium';
import { createCameraPose, footprintSegments, frustumCorners, observationFov, videoFovPlane } from './camera-math';
import type { CameraPose } from './camera-math';
import type { CameraDraft, PtzReading } from './models';
import { createAmapImagery } from './amap-imagery';
import { startVideoFrameLoop } from './video-frame-loop';
import { createVideoMaterial } from './video-material';

const videoPlaneDistance = 500;

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

@Component({
  selector: 'app-camera-scene',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '<div #container class="cesium-host"></div>@if (snapshotUrl) { <img hidden [src]="snapshotUrl" alt="" (load)="onSnapshotLoad($event)" (error)="onSnapshotError()"> }@if (problem()) { <div class="scene-problem" role="status">{{ problem() }}</div> }@if (videoProblem()) { <div class="scene-problem video-problem" role="alert">{{ videoProblem() }}</div> }',
  styles: `:host{display:block;position:absolute;inset:0}.cesium-host{position:absolute;inset:0}.scene-problem{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);max-width:360px;background:rgba(255,255,255,.95);color:#4d5563;padding:12px 18px;border:1px solid #e2e6ec;border-radius:4px;font-size:13px;line-height:1.7;text-align:center;pointer-events:none}.video-problem{top:80px;transform:translateX(-50%);color:#b65345}`,
})
export class CameraSceneComponent implements AfterViewInit, OnChanges, OnDestroy {
  @ViewChild('container', { static: true }) container!: ElementRef<HTMLDivElement>;
  @Input() camera: CameraDraft | null = null;
  @Input() reading: PtzReading | null = null;
  @Input() following = true;
  @Input() video: HTMLVideoElement | null = null;
  @Input() snapshotUrl: string | null = null;
  @Input() videoOpacity = 1;
  readonly problem = signal('');
  readonly videoProblem = signal('');
  private readonly zone = inject(NgZone);
  private viewer?: Viewer;
  private lines?: PolylineCollection;
  private readonly lineMap = new Map<string, Polyline>();
  private marker?: Entity;
  private pose?: CameraPose;
  private observer?: ResizeObserver;
  private previousKey = '';
  private wasFollowing = false;
  private videoPlane?: Primitive;
  private videoMaterial?: Material;
  private boundMedia?: HTMLVideoElement | HTMLImageElement;
  private snapshotImage?: HTMLImageElement;
  private videoDimensions = '';
  private videoFailed = false;
  private stopVideoFrames?: () => void;
  private stopVisibility?: () => void;
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
        this.stopVisibility = this.viewer.scene.preRender.addEventListener(() => {
          if (!this.videoPlane || !this.pose) return;
          this.occluder.cameraPosition = this.viewer!.camera.positionWC;
          this.videoPlane.show = !this.videoFailed && this.occluder.isPointVisible(this.pose.position);
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
          this.viewer.resize();
          if (this.following && this.pose) this.focus();
          this.viewer.scene.requestRender();
        });
        this.observer.observe(this.container.nativeElement);
        this.update();
      } catch (error) {
        this.problem.set('三维场景初始化失败，请检查显卡与 WebGL 支持');
        console.error('Cesium 初始化失败', error);
      }
    });
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['snapshotUrl']) {
      this.snapshotImage = undefined;
      this.releaseVideo();
    }
    this.update();
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

  private update() {
    const viewer = this.viewer;
    if (!viewer || viewer.isDestroyed()) return;
    const raw = this.reading?.raw;
    const key = JSON.stringify([this.camera, raw?.Pan, raw?.Tilt, raw?.Zoom, raw?.HorizontalFieldAngle, raw?.VerticalFieldAngle]);
    if (key === this.previousKey) {
      if (this.following && !this.wasFollowing) this.focus();
      this.wasFollowing = this.following;
      this.updateVideo();
      return;
    }
    this.previousKey = key;
    this.pose = undefined;
    for (const line of this.lineMap.values()) line.show = false;
    if (this.marker) this.marker.show = false;
    try {
      if (!this.camera) throw new Error('请选择或注册摄像头');
      if (this.camera.longitude !== null && this.camera.latitude !== null && this.camera.height !== null && this.marker) {
        this.marker.position = new ConstantPositionProperty(Cartesian3.fromDegrees(this.camera.longitude, this.camera.latitude, this.camera.height));
        this.marker.show = true;
      }
      if (!raw) throw new Error('等待有效的 PTZ 回读');
      this.pose = createCameraPose(this.camera, raw);
      const corners = frustumCorners(this.pose, videoPlaneDistance);
      const frustumColor = Color.fromCssColorString('#ffd77a');
      corners.forEach((corner, index) => this.setLine(`ray-${index}`, [this.pose!.position, corner], frustumColor));
      this.setLine('frame', [...corners, corners[0]], frustumColor);
      this.setLine('axis', [this.pose.position, Cartesian3.add(this.pose.position,
        Cartesian3.multiplyByScalar(this.pose.panAxis, 50, new Cartesian3()), new Cartesian3())], Color.fromCssColorString('#68cda4'));
      footprintSegments(this.pose).forEach((points, index) => this.setLine(`footprint-${index}`, points, Color.fromCssColorString('#54c5ff'), 3));
      this.problem.set('');
      if (this.following) this.focus();
    } catch (error) {
      this.problem.set(error instanceof Error ? error.message : '无法生成当前视场');
    }
    this.wasFollowing = this.following;
    this.updateVideo();
    viewer.scene.requestRender();
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
    const plane = videoFovPlane(this.pose, videoPlaneDistance, width / height);
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
    viewer.scene.requestRender();
  }

  private onVideoFailure(error: unknown) {
    this.videoFailed = true;
    if (this.videoPlane) this.videoPlane.show = false;
    this.stopVideoFrames?.();
    this.stopVideoFrames = undefined;
    const media = this.snapshotUrl ? '历史快照' : '视频';
    const retry = this.snapshotUrl ? '请重新选择快照' : '请重新连接视频';
    this.videoProblem.set(`${media}纹理加载失败：${error instanceof Error ? error.message : String(error)}，${retry}`);
    console.error(`Cesium ${media}纹理加载失败`, error);
  }

  private releaseVideo() {
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

  focus() {
    if (!this.viewer || !this.pose) return;
    const camera = this.viewer.camera;
    const aspect = Math.max(1, this.container.nativeElement.clientWidth) / Math.max(1, this.container.nativeElement.clientHeight);
    const frustum = camera.frustum as PerspectiveFrustum;
    frustum.aspectRatio = aspect;
    frustum.fov = observationFov(this.pose, aspect);
    frustum.near = 0.1;
    frustum.far = 50000000;
    camera.cancelFlight();
    camera.lookAtTransform(Matrix4.IDENTITY);
    camera.setView({ destination: this.pose.position, orientation: { direction: this.pose.direction, up: this.pose.up } });
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
    this.observer?.disconnect();
    this.stopVisibility?.();
    this.releaseVideo();
    if (this.viewer && !this.viewer.isDestroyed()) this.viewer.destroy();
    this.lineMap.clear();
  }
}
