import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Cartesian3, Color, EntityCollection, Event as CesiumEvent, Matrix4, PrimitiveCollection, Ray } from 'cesium';
import { createCameraPose, videoFovPlane } from '../src/app/camera-math.ts';

const cache = resolve('node_modules/.cache');
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
let folder, AisScene;

before(async () => {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {} });
  await mkdir(cache, { recursive: true });
  folder = await mkdtemp(join(cache, 'ais-scene-'));
  const file = join(folder, 'scene.mjs');
  await build({ entryPoints: ['src/app/ais-scene.ts'], outfile: file, bundle: true, platform: 'node',
    format: 'esm', packages: 'external', tsconfig: 'tsconfig.json', logLevel: 'silent' });
  ({ AisScene } = await import(pathToFileURL(file).href));
});

after(async () => {
  if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
  else delete globalThis.document;
  if (folder) {
    if (dirname(resolve(folder)) !== cache || !basename(folder).startsWith('ais-scene-')) throw new Error('场景测试清理路径超出缓存目录');
    await rm(folder, { recursive: true, force: true });
  }
});

const source = { id: 'test-ais', name: '测试 AIS', type: 'ais', expireAfterMs: 600000,
  geometry: { antennaFromSternRatio: 0.1, antennaFromPortRatio: 0.5, heightMeters: 10 } };
const vessel = { mmsi: '123456789', time: '2026-11-17T06:00:00Z', longitude: 117, latitude: 39,
  heading: null, cog: null, length: null, width: null, speed: 0 };

function fixture(t) {
  const canvas = Object.assign(new EventTarget(), { disableRootEvents: true, onwheel: null,
    getBoundingClientRect: () => ({ left: 0, top: 0 }) });
  let picked, videoVisible = false, ray;
  const selected = [];
  const viewer = { entities: new EntityCollection(),
    camera: { positionWC: Cartesian3.fromDegrees(117, 39, 1000), getPickRay: () => ray },
    scene: { canvas, primitives: new PrimitiveCollection(), preRender: new CesiumEvent(), requestRender() {}, pick: () => picked } };
  const scene = new AisScene(viewer, mmsi => selected.push(mmsi), () => videoVisible);
  t.after(() => scene.destroy());
  return { scene, viewer, selected, mapPoints: viewer.scene.primitives.get(0),
    setVideoPickRay(value) { ray = value; },
    setVideoVisible(value) { videoVisible = value; },
    click(entity) {
      picked = { id: entity };
      for (const type of ['mousedown', 'mouseup']) {
        canvas.dispatchEvent(Object.assign(new Event(type), { button: 0, clientX: 10, clientY: 10,
          shiftKey: false, ctrlKey: false, altKey: false }));
      }
    },
  };
}

test('AIS 点不依赖摄像头 PTZ，近处、远处及背向位置均创建且不被自定义遮挡隐藏', t => {
  const f = fixture(t);
  const targets = [[117, 39], [118, 39], [117, 38], [-63, -39]].map(([longitude, latitude], index) =>
    ({ ...vessel, mmsi: String(123456780 + index), longitude, latitude }));
  f.scene.sync(targets, source, '', new Map());
  assert.equal(f.viewer.entities.values.length, targets.length);
  assert.equal(f.mapPoints.length, targets.length);
  f.viewer.scene.preRender.raiseEvent();
  for (const [index, target] of targets.entries()) {
    const entity = f.viewer.entities.getById(`ais-${source.id}-${target.mmsi}`);
    assert.ok(entity?.show, target.mmsi);
    assert.equal(f.mapPoints.get(index).id, entity);
    assert.ok(Color.equals(f.mapPoints.get(index).color, Color.CYAN));
  }
});

test('AIS 点可点选，切源、目标移除与关闭显示会清理旧实体', t => {
  const f = fixture(t);
  f.scene.sync([vessel], source, '', new Map());
  const entity = f.viewer.entities.getById(`ais-${source.id}-${vessel.mmsi}`);
  assert.ok(entity);
  f.click(f.mapPoints.get(0).id);
  assert.deepEqual(f.selected, [vessel.mmsi]);
  const next = { ...source, id: 'next-ais' };
  f.scene.sync([vessel], next, '', new Map());
  assert.equal(f.viewer.entities.getById(entity.id), undefined);
  assert.equal(f.viewer.entities.values.length, 1);
  f.scene.sync([], next, '', new Map());
  assert.equal(f.viewer.entities.values.length, 0);
  assert.equal(f.mapPoints.length, 0);
  f.scene.sync([vessel], next, vessel.mmsi, new Map());
  assert.equal(f.viewer.entities.values.length, 1);
  f.scene.sync([vessel], null, '', new Map());
  assert.equal(f.viewer.entities.values.length, 0);
});

test('默认按 AIS 报告点显示，ABCD 开关切换中心并释放旧船体资源', t => {
  const f = fixture(t);
  const ship = { ...vessel, heading: 90, length: 100, width: 20 };
  const bodies = new Map([[ship.mmsi, { a: 90, b: 10, c: 10, d: 10, height: 10 }]]);
  const id = `ais-${source.id}-${ship.mmsi}`;
  const report = Cartesian3.fromDegrees(ship.longitude, ship.latitude);
  f.scene.sync([ship], source, ship.mmsi, bodies);
  let entity = f.viewer.entities.getById(id);
  assert.equal(f.mapPoints.get(0).id, entity);
  assert.ok(Cartesian3.distance(entity.position.getValue(), report) < 1e-8);
  assert.equal(f.viewer.scene.primitives.length, 1);
  f.scene.sync([ship], source, ship.mmsi, bodies, true);
  entity = f.viewer.entities.getById(id);
  assert.equal(f.mapPoints.length, 0);
  assert.ok(Cartesian3.distance(entity.position.getValue(), report) > 30);
  assert.equal(f.viewer.scene.primitives.length, 2);
  f.scene.sync([ship], source, ship.mmsi, bodies, false);
  entity = f.viewer.entities.getById(id);
  assert.equal(f.mapPoints.get(0).id, entity);
  assert.ok(Cartesian3.distance(entity.position.getValue(), report) < 1e-8);
  assert.equal(entity.label.text.getValue(), ship.mmsi);
  assert.equal(f.viewer.scene.primitives.length, 1);
  assert.equal(ship.longitude, vessel.longitude);
  assert.equal(ship.latitude, vessel.latitude);
});

test('预判目标带独立标记，切回普通跟踪时同坐标也会刷新标签', t => {
  const f = fixture(t), id = `ais-${source.id}-${vessel.mmsi}`;
  f.scene.sync([vessel], source, vessel.mmsi, new Map(), false, vessel.mmsi);
  assert.equal(f.viewer.entities.getById(id).label.text.getValue(), `${vessel.mmsi} 预判`);
  f.scene.sync([vessel], source, vessel.mmsi, new Map());
  assert.equal(f.viewer.entities.getById(id).label.text.getValue(), vessel.mmsi);
  assert.equal(f.viewer.entities.values.length, 1);
});

test('ABCD 使用缺失船艏时的 COG 建立船体，两种方向均缺失时清理并恢复报告点', t => {
  const f = fixture(t);
  const ship = { ...vessel, cog: 90, length: 100, width: 20 };
  const id = `ais-${source.id}-${ship.mmsi}`;
  const report = Cartesian3.fromDegrees(ship.longitude, ship.latitude);
  f.scene.sync([ship], source, ship.mmsi, new Map(), true);
  let entity = f.viewer.entities.getById(id);
  assert.equal(f.mapPoints.length, 0);
  assert.ok(Cartesian3.distance(entity.position.getValue(), report) > 30);
  assert.equal(f.viewer.scene.primitives.length, 2);
  assert.equal(ship.heading, null);
  f.scene.sync([{ ...ship, cog: null }], source, ship.mmsi, new Map(), true);
  entity = f.viewer.entities.getById(id);
  assert.equal(f.mapPoints.get(0).id, entity);
  assert.ok(Cartesian3.distance(entity.position.getValue(), report) < 1e-8);
  assert.equal(f.viewer.scene.primitives.length, 1);
});

test('直播投影返回原图像素，背向和越过地平线的船舶仅保留地图点', t => {
  const f = fixture(t);
  const front = { ...vessel, latitude: 39.01 };
  const behind = { ...vessel, latitude: 38.99, mmsi: '123456780' };
  const beyondHorizon = { ...vessel, latitude: 40, mmsi: '123456781' };
  f.scene.sync([front, behind, beyondHorizon], source, '', new Map());
  const camera = { ...vessel, height: 100, pAxisPitch: 0, pAxisRoll: 0, panOffset: 0, tiltOffset: 0, imageRoll: 0 };
  const raw = { Pan: 0, Tilt: 0, HorizontalFieldAngle: 60, VerticalFieldAngle: 30 };
  const pose = createCameraPose(camera, raw);
  const plane = videoFovPlane(pose, 500).matrix;
  const { pixels } = f.scene.projectVideoPixels(pose, plane, 1920, 1080);
  assert.equal(f.mapPoints.length, 3);
  assert.equal(f.viewer.scene.primitives.length, 1);
  assert.equal(pixels.length, 1);
  assert.ok(Math.abs(pixels[0].x - 960) < 1e-7);
  assert.ok(pixels[0].y > 540 && pixels[0].y < 1080);
  const { pixels: halfResolution } = f.scene.projectVideoPixels(pose, plane, 960, 540);
  assert.equal(halfResolution[0].x, pixels[0].x / 2);
  assert.equal(halfResolution[0].y, pixels[0].y / 2);
  f.scene.sync([behind], source, '', new Map());
  assert.deepEqual(f.scene.projectVideoPixels(pose, plane, 1920, 1080).pixels, []);
});

test('点击视频绿色点按画面原像素选船，空白、隐藏或释放后不选船', t => {
  const f = fixture(t);
  const front = { ...vessel, longitude: 117.001, latitude: 39.01 };
  f.scene.sync([front], source, '', new Map());
  const camera = { ...vessel, height: 100, pAxisPitch: 0, pAxisRoll: 0, panOffset: 0, tiltOffset: 0, imageRoll: 0 };
  const pose = createCameraPose(camera, { Pan: 0, Tilt: 0, HorizontalFieldAngle: 60, VerticalFieldAngle: 30 });
  const width = 1920, height = 1080;
  const plane = videoFovPlane(pose, 500).matrix;
  const { pixels: [pixel], radius } = f.scene.projectVideoPixels(pose, plane, width, height);
  const rayAt = (x, y) => {
    const world = Matrix4.multiplyByPoint(plane, new Cartesian3(x / width - 0.5, 0.5 - y / height, 0), new Cartesian3());
    return new Ray(f.viewer.camera.positionWC, Cartesian3.subtract(world, f.viewer.camera.positionWC, new Cartesian3()));
  };
  f.setVideoPickRay(rayAt(pixel.x, pixel.y));
  f.click();
  assert.deepEqual(f.selected, []);
  f.setVideoVisible(true);
  f.click();
  assert.deepEqual(f.selected, [front.mmsi]);
  f.setVideoPickRay(rayAt(pixel.x, pixel.y + 2 * radius));
  f.click();
  f.scene.clearVideoProjection();
  f.setVideoPickRay(rayAt(pixel.x, pixel.y));
  f.click();
  assert.deepEqual(f.selected, [front.mmsi]);
});
