import {
  BlendOption, BoxGeometry, BoxOutlineGeometry, Cartesian2, Cartesian3, Color, ColorGeometryInstanceAttribute,
  Ellipsoid, EllipsoidalOccluder, Entity, GeometryInstance, LabelStyle, Matrix4,
  PerInstanceColorAppearance, PointPrimitiveCollection, Primitive, PrimitiveCollection, ScreenSpaceEventHandler, ScreenSpaceEventType,
} from 'cesium';
import * as Cesium from 'cesium';
import type { PointPrimitive, Viewer } from 'cesium';
import type { VesselBodyDimensions, VesselSourceInfo, VesselTarget } from './ais.models';
import { vesselGeometry } from './ais-math';
import { projectToImagePixel } from './camera-math';
import type { CameraPose } from './camera-math';

// Cesium 的类型声明省略渲染队列；将 AIS 点和船体放在视频合成之后。
const renderPass = (Cesium as unknown as { Pass: { OVERLAY: number; TRANSLUCENT: number } }).Pass;
interface OverlayCommand {
  pass: number;
  execute(context: { uniformState: { updateFrustum(frustum: Viewer['camera']['frustum']): void } }, passState: unknown): void;
}
interface OverlayFrameState {
  passes: { pick: boolean };
  commandList: OverlayCommand[];
}
const PointCollectionWithUpdate = PointPrimitiveCollection as new (options: ConstructorParameters<typeof PointPrimitiveCollection>[0]) =>
  PointPrimitiveCollection & { update(state: OverlayFrameState): void };

function moveToOverlay(viewer: Viewer, wrapped: WeakSet<OverlayCommand>, commands: OverlayCommand[], start: number) {
  for (let index = start; index < commands.length; index++) {
    const command = commands[index];
    command.pass = renderPass.OVERLAY;
    if (wrapped.has(command)) continue;
    const execute = command.execute;
    command.execute = (context, passState) => {
      // 多视锥渲染后恢复完整观察投影，避免远处目标被最近的视锥裁掉。
      if (command.pass === renderPass.OVERLAY) context.uniformState.updateFrustum(viewer.camera.frustum);
      execute.call(command, context, passState);
    };
    wrapped.add(command);
  }
}

class AisOverlayPrimitive extends Primitive {
  private readonly wrapped = new WeakSet<OverlayCommand>();
  constructor(private readonly viewer: Viewer, options: ConstructorParameters<typeof Primitive>[0]) { super(options); }

  override update(): void {
    const state = arguments[0] as OverlayFrameState;
    const start = state.commandList.length;
    Reflect.apply(Primitive.prototype.update, this, arguments);
    if (state.passes.pick) {
      for (let index = start; index < state.commandList.length; index++) state.commandList[index].pass = renderPass.TRANSLUCENT;
    } else {
      moveToOverlay(this.viewer, this.wrapped, state.commandList, start);
    }
  }
}

class AisOverlayPoints extends PointCollectionWithUpdate {
  private readonly wrapped = new WeakSet<OverlayCommand>();
  constructor(private readonly viewer: Viewer) { super({ blendOption: BlendOption.TRANSLUCENT }); }

  override update(state: OverlayFrameState): void {
    const start = state.commandList.length;
    super.update(state);
    if (!state.passes.pick) moveToOverlay(this.viewer, this.wrapped, state.commandList, start);
  }
}

interface VesselSceneEntry {
  entity: Entity;
  key: string;
  reportPosition: Cartesian3;
  point?: PointPrimitive;
  box?: PrimitiveCollection;
}

interface VideoProjection {
  plane: Matrix4;
  width: number;
  height: number;
  radius: number;
  pixels: { mmsi: string; pixel: Cartesian2 }[];
}

/** 仅拥有 AIS 场景资源；数据源选择、缓存和设备控制由页面负责。 */
export class AisScene {
  private readonly entities = new Map<string, VesselSceneEntry>();
  private readonly handler: ScreenSpaceEventHandler;
  private readonly mapPoints: PointPrimitiveCollection;
  private readonly cameraOccluder = new EllipsoidalOccluder(Ellipsoid.WGS84);
  private videoProjection?: VideoProjection;
  private sourceId = '';

  constructor(private readonly viewer: Viewer, selected: (mmsi: string) => void,
    private readonly isVideoVisible: () => boolean = () => false) {
    this.mapPoints = viewer.scene.primitives.add(new AisOverlayPoints(viewer));
    this.handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
    this.handler.setInputAction((event: { position: Cartesian2 }) => {
      const picked = viewer.scene.pick(event.position);
      if (picked?.id instanceof Entity) {
        for (const [mmsi, entry] of this.entities) {
          if (entry.entity === picked.id) { selected(mmsi); return; }
        }
      }
      const mmsi = this.pickVideoPixel(event.position);
      if (mmsi) selected(mmsi);
    }, ScreenSpaceEventType.LEFT_CLICK);
  }

  sync(targets: readonly VesselTarget[], source: VesselSourceInfo | null, trackedMmsi: string,
    bodies: ReadonlyMap<string, VesselBodyDimensions>, useBodyGeometry = false, predictedMmsi = '') {
    if (this.sourceId !== (source?.id ?? '')) { this.clear(); this.sourceId = source?.id ?? ''; }
    const visible = new Set<string>();
    if (source) {
      for (const target of targets) {
        const tracked = target.mmsi === trackedMmsi, predicted = target.mmsi === predictedMmsi;
        const geometry = tracked && useBodyGeometry ? vesselGeometry(target, source.geometry, bodies.get(target.mmsi)) : null;
        visible.add(target.mmsi);
        const key = JSON.stringify([target.longitude, target.latitude, geometry?.position, geometry?.dimensions, geometry?.orientation, tracked, predicted]);
        const previous = this.entities.get(target.mmsi);
        if (previous?.key === key) continue;
        if (previous) this.remove(previous);
        const reportPosition = Cartesian3.fromDegrees(target.longitude, target.latitude);
        const entity = this.viewer.entities.add({
          id: `ais-${source.id}-${target.mmsi}`, position: geometry?.position ?? reportPosition,
          orientation: geometry?.orientation,
          label: tracked ? { text: predicted ? `${target.mmsi} 预判` : target.mmsi, font: '12px sans-serif', fillColor: Color.WHITE,
            outlineColor: Color.BLACK, outlineWidth: 2, style: LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cartesian2(0, -20), disableDepthTestDistance: Infinity } : undefined,
        });
        const box = geometry ? this.addBox(entity, geometry) : undefined;
        const point = geometry ? undefined : this.mapPoints.add({
          id: entity, position: reportPosition, pixelSize: tracked ? 10 : 7, color: tracked ? Color.ORANGE : Color.CYAN,
          outlineColor: Color.BLACK, outlineWidth: 1, disableDepthTestDistance: Infinity,
        });
        this.entities.set(target.mmsi, { entity, key, reportPosition, point, box });
      }
    }
    for (const [mmsi, entry] of this.entities) {
      if (!visible.has(mmsi)) { this.remove(entry); this.entities.delete(mmsi); }
    }
    this.viewer.scene.requestRender();
  }

  projectVideoPixels(pose: CameraPose, plane: Matrix4, width: number, height: number) {
    this.cameraOccluder.cameraPosition = pose.position;
    const pixels: VideoProjection['pixels'] = [];
    for (const [mmsi, entry] of this.entities) {
      const pixel = projectToImagePixel(pose, entry.reportPosition, width, height);
      if (pixel && this.cameraOccluder.isPointVisible(entry.reportPosition)) {
        pixels.push({ mmsi, pixel });
      }
    }
    const radius = Math.max(4, width * 0.008);
    this.videoProjection = { plane, width, height, radius, pixels };
    return { pixels: pixels.map(({ pixel }) => pixel), radius };
  }

  clearVideoProjection() {
    this.videoProjection = undefined;
  }

  private pickVideoPixel(position: Cartesian2) {
    const projection = this.videoProjection;
    if (!projection?.pixels.length || !this.isVideoVisible()) return;
    const ray = this.viewer.camera.getPickRay(position);
    if (!ray) return;
    const worldToPlane = Matrix4.inverse(projection.plane, new Matrix4());
    const origin = Matrix4.multiplyByPoint(worldToPlane, ray.origin, new Cartesian3());
    const direction = Matrix4.multiplyByPointAsVector(worldToPlane, ray.direction, new Cartesian3());
    if (direction.z === 0) return;
    const distance = -origin.z / direction.z;
    if (distance <= 0) return;
    const x = origin.x + distance * direction.x;
    const y = origin.y + distance * direction.y;
    if (Math.abs(x) > 0.5 || Math.abs(y) > 0.5) return;
    // 与视频材质共用原帧像素和绘制半径，避免随 Cesium 观察角度变化发生错选。
    const pixel = new Cartesian2((x + 0.5) * projection.width, (0.5 - y) * projection.height);
    let nearest = projection.radius ** 2;
    let selected: string | undefined;
    for (const marker of projection.pixels) {
      const distanceSquared = Cartesian2.distanceSquared(pixel, marker.pixel);
      if (distanceSquared <= nearest && this.entities.has(marker.mmsi)) {
        nearest = distanceSquared;
        selected = marker.mmsi;
      }
    }
    return selected;
  }

  private addBox(entity: Entity, geometry: NonNullable<ReturnType<typeof vesselGeometry>>): PrimitiveCollection {
    const box = this.viewer.scene.primitives.add(new PrimitiveCollection());
    const modelMatrix = Matrix4.fromTranslationQuaternionRotationScale(geometry.position, geometry.orientation, Cartesian3.ONE);
    const shapes = [
      { geometry: BoxGeometry.fromDimensions({ dimensions: geometry.dimensions, vertexFormat: PerInstanceColorAppearance.FLAT_VERTEX_FORMAT }), color: Color.ORANGE.withAlpha(0.4), closed: true },
      { geometry: BoxOutlineGeometry.fromDimensions({ dimensions: geometry.dimensions }), color: Color.WHITE, closed: false },
    ];
    for (const shape of shapes) {
      box.add(new AisOverlayPrimitive(this.viewer, {
        geometryInstances: new GeometryInstance({ id: entity, geometry: shape.geometry,
          attributes: { color: ColorGeometryInstanceAttribute.fromColor(shape.color) } }),
        modelMatrix, asynchronous: false,
        appearance: new PerInstanceColorAppearance({ flat: true, translucent: true, closed: shape.closed,
          renderState: { depthTest: { enabled: false }, depthMask: false } }),
      }));
    }
    return box;
  }

  private remove(entry: VesselSceneEntry) {
    if (entry.point) this.mapPoints.remove(entry.point);
    if (entry.box) this.viewer.scene.primitives.remove(entry.box);
    this.viewer.entities.remove(entry.entity);
  }

  private clear() {
    this.clearVideoProjection();
    for (const entry of this.entities.values()) this.remove(entry);
    this.entities.clear();
  }

  destroy() {
    this.handler.destroy();
    this.clear();
    this.viewer.scene.primitives.remove(this.mapPoints);
  }
}
