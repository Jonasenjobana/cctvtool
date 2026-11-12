import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Cartesian3, Ellipsoid, IntersectionTests, Ray } from 'cesium';
import { createCameraPose, observationFov, videoFovPlane } from '../src/app/camera-math.ts';
import type { CameraPose } from '../src/app/camera-math.ts';
import type { CameraDraft, RawPtz } from '../src/app/models.ts';

interface ReferenceCase {
  name: string;
  camera: CameraDraft;
  ptz: RawPtz;
  expected: Record<'position' | 'direction' | 'right' | 'up' | 'panAxis' | 'videoPlane' | 'uvScale', number[]> & {
    horizon: { x: number; y: number }[];
    observationFov: { aspect: number; value: number }[];
  };
}

// 数值由参考项目的原函数在相同输入下生成，测试运行不依赖本机参考工程。
const { cases } = JSON.parse(readFileSync(new URL('./fixtures/reference-camera-poses.json', import.meta.url), 'utf8')) as { cases: ReferenceCase[] };
const near = (a: number, b: number, tolerance: number, label: string) => assert.ok(Math.abs(a - b) <= tolerance, `${label}: ${a} ≠ ${b}`);

function horizonY(pose: CameraPose, x: number) {
  const hitsSea = (y: number) => {
    const direction = Cartesian3.clone(pose.direction);
    Cartesian3.add(direction, Cartesian3.multiplyByScalar(pose.right,
      (2 * x - 1) * Math.tan(pose.horizontalFov * Math.PI / 360), new Cartesian3()), direction);
    Cartesian3.add(direction, Cartesian3.multiplyByScalar(pose.up,
      (1 - 2 * y) * Math.tan(pose.verticalFov * Math.PI / 360), new Cartesian3()), direction);
    const hit = IntersectionTests.rayEllipsoid(new Ray(pose.position, Cartesian3.normalize(direction, direction)), Ellipsoid.WGS84);
    return !!hit && hit.start > 0;
  };
  let lo = -4, hi = 4;
  assert.ok(!hitsSea(lo) && hitsSea(hi));
  for (let index = 0; index < 55; index++) {
    const middle = (lo + hi) / 2;
    if (hitsSea(middle)) hi = middle; else lo = middle;
  }
  return (lo + hi) / 2;
}

test('非零安装朝向与 P 轴倾斜组合时，世界朝向和 P 轴方向与参考算法一致', () => {
  for (const fixture of cases) {
    const pose = createCameraPose(fixture.camera, fixture.ptz);
    for (const key of ['position', 'direction', 'right', 'up', 'panAxis'] as const) {
      const expected = Cartesian3.fromArray(fixture.expected[key]);
      near(Cartesian3.distance(pose[key], expected), 0, key === 'position' ? 1e-8 : 1e-12, `${fixture.name}/${key}`);
    }
  }
});

test('同一 PTZ 与安装参数的海天线、视频截面和最佳观察与参考结果一致', () => {
  for (const fixture of cases) {
    const pose = createCameraPose(fixture.camera, fixture.ptz);
    for (const point of fixture.expected.horizon) near(horizonY(pose, point.x), point.y, 1e-7, `${fixture.name}/horizon-${point.x}`);
    const plane = videoFovPlane(pose, 500, 16 / 9);
    fixture.expected.videoPlane.forEach((value, index) => near(plane.matrix[index], value, 1e-8, `${fixture.name}/plane-${index}`));
    near(plane.uvScale.x, fixture.expected.uvScale[0], 1e-12, `${fixture.name}/uv-x`);
    near(plane.uvScale.y, fixture.expected.uvScale[1], 1e-12, `${fixture.name}/uv-y`);
    for (const observation of fixture.expected.observationFov) near(observationFov(pose, observation.aspect), observation.value, 1e-12, `${fixture.name}/fov`);
  }
});
