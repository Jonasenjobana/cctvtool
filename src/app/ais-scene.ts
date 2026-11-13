import {
  Cartesian2, Cartesian3, Color, Ellipsoid, EllipsoidalOccluder, Entity, LabelStyle,
  ScreenSpaceEventHandler, ScreenSpaceEventType,
} from 'cesium';
import type { Viewer } from 'cesium';
import type { CameraPose } from './camera-math';
import type { VesselSourceInfo, VesselTarget } from './ais.models';
import { isInCameraView, vesselGeometry } from './ais-math';

/** 仅拥有 AIS 场景资源；数据源选择、缓存和设备控制由页面负责。 */
export class AisScene {
  private readonly entities = new Map<string, { entity: Entity; key: string; occlusionPoint: Cartesian3 }>();
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
      for (const entry of this.entities.values()) entry.entity.show = this.occluder.isPointVisible(entry.occlusionPoint);
    });
  }

  sync(targets: readonly VesselTarget[], source: VesselSourceInfo | null, pose: CameraPose | undefined, trackedMmsi: string) {
    if (this.sourceId !== (source?.id ?? '')) { this.clear(); this.sourceId = source?.id ?? ''; }
    const visible = new Set<string>();
    if (source && pose) {
      for (const target of targets) {
        const tracked = target.mmsi === trackedMmsi;
        const geometry = tracked ? vesselGeometry(target, source.geometry) : null;
        const position = geometry?.position ?? Cartesian3.fromDegrees(target.longitude, target.latitude);
        const radius = geometry ? Cartesian3.magnitude(geometry.dimensions) / 2 : 0;
        if (!isInCameraView(pose, position, source.maxDistanceMeters, radius)) continue;
        visible.add(target.mmsi);
        const key = JSON.stringify([target.longitude, target.latitude, geometry?.dimensions, geometry?.orientation, tracked]);
        const previous = this.entities.get(target.mmsi);
        if (previous?.key === key) continue;
        if (previous) this.viewer.entities.remove(previous.entity);
        const entity = this.viewer.entities.add({
          id: `ais-${source.id}-${target.mmsi}`, position,
          orientation: geometry?.orientation,
          point: geometry ? undefined : { pixelSize: tracked ? 10 : 7, color: tracked ? Color.ORANGE : Color.CYAN,
            outlineColor: Color.BLACK, outlineWidth: 1, disableDepthTestDistance: Infinity },
          box: geometry ? { dimensions: geometry.dimensions, material: Color.ORANGE.withAlpha(0.4),
            outline: true, outlineColor: Color.WHITE } : undefined,
          label: tracked ? { text: target.mmsi, font: '12px sans-serif', fillColor: Color.WHITE,
            outlineColor: Color.BLACK, outlineWidth: 2, style: LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cartesian2(0, -20), disableDepthTestDistance: Infinity } : undefined,
        });
        const occlusionPoint = Cartesian3.add(position, Cartesian3.multiplyByScalar(
          Ellipsoid.WGS84.geodeticSurfaceNormal(position, new Cartesian3()), radius, new Cartesian3()), new Cartesian3());
        this.entities.set(target.mmsi, { entity, key, occlusionPoint });
      }
    }
    for (const [mmsi, { entity }] of this.entities) {
      if (!visible.has(mmsi)) { this.viewer.entities.remove(entity); this.entities.delete(mmsi); }
    }
    this.viewer.scene.requestRender();
  }

  private clear() {
    for (const { entity } of this.entities.values()) this.viewer.entities.remove(entity);
    this.entities.clear();
  }

  destroy() {
    this.handler.destroy();
    this.stopVisibility();
    this.clear();
  }
}
