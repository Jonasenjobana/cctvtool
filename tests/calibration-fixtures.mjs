import assert from 'node:assert/strict';
import { Cartesian3, Ellipsoid, IntersectionTests, Ray } from 'cesium';
import { createCameraPose } from '../src/app/camera-math.ts';

export const fixtureCamera = {
  id: 'camera-1', name: '海天线测试', serial: '0001', code: '0002',
  longitude: 113.91319, latitude: 22.04331, height: 6.6,
  pAxisPitch: 0, pAxisRoll: 0, panOffset: 93.2, tiltOffset: 0, imageRoll: 0,
  createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z',
};
export const fixtureRange = { startTime: '2026-11-09T00:00:00Z', endTime: '2026-11-09T01:00:00Z' };

export function syntheticSnapshots({ camera = fixtureCamera, pitch = 1.25, roll = -2.1, pans = [0, 60, 120, 180, 240, 300], ptzOverrides = {} } = {}) {
  const snapshots = [];
  const observations = [];
  pans.forEach((pan, index) => {
    const raw = { Pan: pan, Tilt: 2 + index * 0.1, Zoom: 3 + index,
      HorizontalFieldAngle: 24 - index, VerticalFieldAngle: 13.5 - index * 0.4, ...ptzOverrides };
    const pose = createCameraPose({ ...camera, pAxisPitch: pitch, pAxisRoll: roll }, raw);
    // 用 Cesium 射线命中/未命中的分界生成海天线，与拟合器的切线角残差独立。
    const hitsSea = (x, y) => {
      const direction = Cartesian3.add(pose.direction, Cartesian3.add(
        Cartesian3.multiplyByScalar(pose.right, (2 * x - 1) * Math.tan(raw.HorizontalFieldAngle * Math.PI / 360), new Cartesian3()),
        Cartesian3.multiplyByScalar(pose.up, (1 - 2 * y) * Math.tan(raw.VerticalFieldAngle * Math.PI / 360), new Cartesian3()), new Cartesian3(),
      ), new Cartesian3());
      const hit = IntersectionTests.rayEllipsoid(new Ray(pose.position, Cartesian3.normalize(direction, direction)), Ellipsoid.WGS84);
      return Boolean(hit && hit.start > 0);
    };
    const points = [0.1, 0.5, 0.9].map((x) => {
      assert.ok(!hitsSea(x, 0) && hitsSea(x, 1), '测试海天线必须落在画面内');
      let top = 0, bottom = 1;
      for (let iteration = 0; iteration < 55; iteration++) {
        const middle = (top + bottom) / 2;
        if (hitsSea(x, middle)) bottom = middle; else top = middle;
      }
      return { x, y: (top + bottom) / 2 };
    });
    const createdAt = new Date(Date.UTC(2026, 10, 9, 0, index)).toISOString();
    const reading = { raw, requestedAt: createdAt, receivedAt: createdAt, durationMs: 200 };
    const snapshot = {
      id: `synthetic-${index}`, cameraId: camera.id, cameraName: camera.name, serial: camera.serial, code: camera.code,
      createdAt, ptz: reading, ptzAfter: reading, poseChanged: false, timeAlignment: 'unverified',
      width: index % 2 ? 1920 : 960, height: index % 2 ? 1080 : 540,
      calibration: { longitude: camera.longitude, latitude: camera.latitude, height: camera.height,
        pAxisPitch: 0, pAxisRoll: 0, panOffset: camera.panOffset, tiltOffset: camera.tiltOffset, imageRoll: camera.imageRoll },
    };
    snapshots.push(snapshot);
    observations.push({ snapshotId: snapshot.id, points });
  });
  return { snapshots, observations };
}
