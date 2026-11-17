import {
  BoxGeometry, BoxOutlineGeometry, Cartesian2, Cartesian3, Color, ColorGeometryInstanceAttribute,
  Ellipsoid, EllipsoidalOccluder, Entity, GeometryInstance, LabelStyle, Matrix4,
  PerInstanceColorAppearance, Primitive, PrimitiveCollection, ScreenSpaceEventHandler, ScreenSpaceEventType,
} from 'cesium';
import * as Cesium from 'cesium';
import type { Viewer } from 'cesium';
import type { CameraPose } from './camera-math';
import type { VesselBodyDimensions, VesselSourceInfo, VesselTarget } from './ais.models';
import { isInCameraView, vesselGeometry } from './ais-math';

// Cesium 的类型声明省略渲染队列；仅将本模块的盒命令放在视频合成之后。
const renderPass = (Cesium as unknown as { Pass: { OVERLAY: number; TRANSLUCENT: number } }).Pass;
interface OverlayCommand {
  pass: number;
  execute(context: { uniformState: { updateFrustum(frustum: Viewer['camera']['frustum']): void } }, passState: unknown): void;
}

class AisOverlayPrimitive extends Primitive {
  private readonly wrapped = new WeakSet<OverlayCommand>();
  constructor(private readonly viewer: Viewer, options: ConstructorParameters<typeof Primitive>[0]) { super(options); }

  override update(): void {
    const state = arguments[0] as { passes: { pick: boolean }; commandList: OverlayCommand[] };
    const start = state.commandList.length;
    Reflect.apply(Primitive.prototype.update, this, arguments);
    for (let index = start; index < state.commandList.length; index++) {
      const command = state.commandList[index];
      command.pass = state.passes.pick ? renderPass.TRANSLUCENT : renderPass.OVERLAY;
      if (this.wrapped.has(command)) continue;
      const execute = command.execute;
      command.execute = (context, passState) => {
        // Overlay 在多视锥渲染后执行，必须恢复完整投影，避免远处船体被最近视锥裁掉。
        if (command.pass === renderPass.OVERLAY) context.uniformState.updateFrustum(this.viewer.camera.frustum);
        execute.call(command, context, passState);
      };
      this.wrapped.add(command);
    }
  }
}

interface VesselSceneEntry { entity: Entity; key: string; occlusionPoint: Cartesian3; box?: PrimitiveCollection }

/** 仅拥有 AIS 场景资源；数据源选择、缓存和设备控制由页面负责。 */
export class AisScene {
  private readonly entities = new Map<string, VesselSceneEntry>();
  private readonly handler: ScreenSpaceEventHandler;
  private readonly stopVisibility: () => void;
  private readonly occluder = new EllipsoidalOccluder(Ellipsoid.WGS84);
  private sourceId = '';

  constructor(private readonly viewer: Viewer, selected: (mmsi: string) => void) {
    this.handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
    this.handler.setInputAction((event: { position: Cartesian2 }) => {
      const picked = viewer.scene.pick(event.position);
      if (!(picked?.id instanceof Entity)) return;
      for (const [mmsi, entry] of this.entities) {
        if (entry.entity === picked.id) { selected(mmsi); break; }
      }
    }, ScreenSpaceEventType.LEFT_CLICK);
    this.stopVisibility = viewer.scene.preRender.addEventListener(() => {
      this.occluder.cameraPosition = viewer.camera.positionWC;
      for (const entry of this.entities.values()) {
        const visible = this.occluder.isPointVisible(entry.occlusionPoint);
        entry.entity.show = visible;
        if (entry.box) entry.box.show = visible;
      }
    });
  }

  sync(targets: readonly VesselTarget[], source: VesselSourceInfo | null, pose: CameraPose | undefined, trackedMmsi: string,
    bodies: ReadonlyMap<string, VesselBodyDimensions>) {
    if (this.sourceId !== (source?.id ?? '')) { this.clear(); this.sourceId = source?.id ?? ''; }
    const visible = new Set<string>();
    if (source && pose) {
      for (const target of targets) {
        const tracked = target.mmsi === trackedMmsi;
        const geometry = tracked ? vesselGeometry(target, source.geometry, bodies.get(target.mmsi)) : null;
        const position = geometry?.position ?? Cartesian3.fromDegrees(target.longitude, target.latitude);
        const radius = geometry ? Cartesian3.magnitude(geometry.dimensions) / 2 : 0;
        if (!isInCameraView(pose, position, radius)) continue;
        visible.add(target.mmsi);
        const key = JSON.stringify([target.longitude, target.latitude, geometry?.position, geometry?.dimensions, geometry?.orientation, tracked]);
        const previous = this.entities.get(target.mmsi);
        if (previous?.key === key) continue;
        if (previous) this.remove(previous);
        const entity = this.viewer.entities.add({
          id: `ais-${source.id}-${target.mmsi}`, position,
          orientation: geometry?.orientation,
          point: geometry ? undefined : { pixelSize: tracked ? 10 : 7, color: tracked ? Color.ORANGE : Color.CYAN,
            outlineColor: Color.BLACK, outlineWidth: 1, disableDepthTestDistance: Infinity },
          label: tracked ? { text: target.mmsi, font: '12px sans-serif', fillColor: Color.WHITE,
            outlineColor: Color.BLACK, outlineWidth: 2, style: LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cartesian2(0, -20), disableDepthTestDistance: Infinity } : undefined,
        });
        const box = geometry ? this.addBox(entity, geometry) : undefined;
        const occlusionPoint = Cartesian3.add(position, Cartesian3.multiplyByScalar(
          Ellipsoid.WGS84.geodeticSurfaceNormal(position, new Cartesian3()), radius, new Cartesian3()), new Cartesian3());
        this.entities.set(target.mmsi, { entity, key, occlusionPoint, box });
      }
    }
    for (const [mmsi, entry] of this.entities) {
      if (!visible.has(mmsi)) { this.remove(entry); this.entities.delete(mmsi); }
    }
    this.viewer.scene.requestRender();
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
    if (entry.box) this.viewer.scene.primitives.remove(entry.box);
    this.viewer.entities.remove(entry.entity);
  }

  private clear() {
    for (const entry of this.entities.values()) this.remove(entry);
    this.entities.clear();
  }

  destroy() {
    this.handler.destroy();
    this.stopVisibility();
    this.clear();
  }
}
