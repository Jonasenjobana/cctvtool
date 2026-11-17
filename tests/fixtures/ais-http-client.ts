import '@angular/compiler';
import assert from 'node:assert/strict';
import { Injector, runInInjectionContext } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { from } from 'rxjs';
import { AisState } from '../../src/app/ais-state.service';
import { ApiService } from '../../src/app/api.service';
import { predictVesselPosition } from '../../src/app/ais-prediction';

const origin = process.env.AIS_TEST_ORIGIN!;
const NativeEventSource = globalThis.EventSource;
let failNext = process.env.AIS_TEST_INIT_FAILURE === '1';
const streams: EventSource[] = [];
// 复现注入脚本的透明代理：方法绑定原对象，属性写入仍使用 Proxy receiver。
globalThis.EventSource = new Proxy(NativeEventSource, {
  construct(target, args) {
    if (failNext) { failNext = false; throw new TypeError('Illegal invocation'); }
    const source = Reflect.construct(target, [new URL(args[0], origin).href]);
    streams.push(source);
    return new Proxy(source, {
      get(instance, key) { const value = Reflect.get(instance, key, instance); return typeof value === 'function' ? value.bind(instance) : value; },
      set(instance, key, value, receiver) { return Reflect.set(instance, key, value, receiver); },
    });
  },
});
const memory = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true,
  value: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value) } });
const injector = Injector.create({ providers: [
  ApiService,
  { provide: HttpClient, useValue: { get: (path: string) => from(fetch(new URL(path, origin)).then(async response => {
    if (!response.ok) throw new HttpErrorResponse({ status: response.status, error: await response.json() });
    return response.json();
  })) } },
] });
const state = runInInjectionContext(injector, () => new AisState());
try {
  state.setActive(true);
  await state.load();
  if (process.env.AIS_TEST_INIT_FAILURE === '1') {
    assert.equal(state.status(), 'error', state.problem());
    assert.match(state.problem(), /Illegal invocation/);
    assert.equal(state.targets().length, 0);
    state.selectSource(state.selectedId());
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && state.status() !== 'connected' && !state.problem()) await new Promise(accept => setTimeout(accept, 50));
  assert.equal(state.status(), 'connected', state.problem());
  assert.deepEqual(state.targets().map(target => target.mmsi), ['123456789']);
  state.selectTarget('123456789');
  assert.equal(state.useBodyGeometry(), false);
  assert.equal(state.trackingZoom(), null);
  const beforeModeChange = state.bodyRevision();
  state.trackedMmsi.set('123456789');
  state.setUseBodyGeometry(true);
  assert.equal(state.useBodyGeometry(), true);
  assert.notEqual(state.bodyRevision(), beforeModeChange);
  assert.equal(state.trackedMmsi(), '123456789');
  const beforeZoomChange = state.bodyRevision();
  state.setTrackingZoom(12.75, 32);
  assert.equal(state.trackingZoom(), 12.75);
  assert.notEqual(state.bodyRevision(), beforeZoomChange);
  assert.equal(state.trackedMmsi(), '123456789');
  for (const zoom of [null, 0, 0.9, 32.1, NaN, Infinity]) {
    assert.throws(() => state.setTrackingZoom(zoom, 32), /倍率/);
    assert.equal(state.trackingZoom(), 12.75);
  }
  for (const maxZoom of [0, NaN, Infinity]) {
    assert.throws(() => state.setTrackingZoom(12.75, maxZoom), /倍率/);
    assert.equal(state.trackingZoom(), 12.75);
  }
  const unchanged = state.bodyRevision();
  state.setUseBodyGeometry(true);
  state.setTrackingZoom(12.75, 32);
  assert.equal(state.bodyRevision(), unchanged);
  state.clearTracking();
  const body = { a: 30, b: 90, c: 5, d: 25, height: 20 };
  const beforeBodyChange = state.bodyRevision();
  state.setBodyDimensions('123456789', body);
  assert.deepEqual(state.selectedBodyOverride(), body);
  assert.notEqual(state.bodyRevision(), beforeBodyChange);
  assert.equal(state.targets()[0].length, 100);
  assert.throws(() => state.setBodyDimensions('123456789', { ...body, height: 0 }), /大于 0/);
  assert.deepEqual(state.selectedBodyOverride(), body);
  state.trackedMmsi.set('123456789');
  const trackingRevision = state.selectionRevision();
  state.clearTracking();
  state.trackedMmsi.set('123456789');
  assert.notEqual(state.selectionRevision(), trackingRevision);
  state.selectTarget('');
  assert.equal(state.trackedMmsi(), '');
  state.selectSource('');
  assert.equal(state.targets().length, 0);
  state.selectSource('test-ais');
  const reconnectDeadline = Date.now() + 5000;
  while (Date.now() < reconnectDeadline && state.status() !== 'connected' && !state.problem()) await new Promise(accept => setTimeout(accept, 50));
  assert.equal(state.status(), 'connected', state.problem());
  assert.equal(state.targets().length, 1);
  state.selectTarget('123456789');
  assert.deepEqual(state.selectedBodyOverride(), body);
  assert.equal(state.useBodyGeometry(), true);
  assert.equal(state.trackingZoom(), 12.75);
  state.setUseBodyGeometry(false);
  assert.equal(state.trackingZoom(), 12.75);
  assert.deepEqual(state.selectedBodyOverride(), body);
  state.selectSource('other-ais');
  const otherDeadline = Date.now() + 5000;
  while (Date.now() < otherDeadline && state.status() !== 'connected' && !state.problem()) await new Promise(accept => setTimeout(accept, 50));
  assert.equal(state.status(), 'connected', state.problem());
  state.selectTarget('123456789');
  assert.equal(state.selectedBodyOverride(), null);
  state.setBodyDimensions('123456789', { ...body, height: 30 });
  assert.equal(state.selectedBodyOverride()!.height, 30);
  state.selectSource('test-ais');
  const restoredDeadline = Date.now() + 5000;
  while (Date.now() < restoredDeadline && state.status() !== 'connected' && !state.problem()) await new Promise(accept => setTimeout(accept, 50));
  assert.equal(state.status(), 'connected', state.problem());
  state.selectTarget('123456789');
  assert.deepEqual(state.selectedBodyOverride(), body);
  const beforeReset = state.bodyRevision();
  state.resetBodyDimensions('123456789');
  assert.equal(state.selectedBodyOverride(), null);
  assert.notEqual(state.bodyRevision(), beforeReset);
  assert.equal(state.targets()[0].length, 100);
  const stream = streams.at(-1)!;
  const report = { ...state.selectedTarget()!, speed: 10 };
  const publish = (targets: Array<typeof report>) => stream.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
    sourceId: state.selectedId(), status: 'connected', error: null, receivedAt: report.time, targets,
  }) }));
  publish([report]);
  assert.equal(state.predictionSeconds(), null);
  state.startPrediction(2.5);
  assert.equal(state.predictionSeconds(), 2.5);
  assert.equal(state.trackedMmsi(), report.mmsi);
  assert.notEqual(state.predictionTarget(), report);
  for (const seconds of [null, -1, NaN, Infinity]) {
    assert.throws(() => state.startPrediction(seconds), /预判秒数/);
    assert.equal(state.predictionSeconds(), 2.5);
  }
  const position = predictVesselPosition(report, 2.5, Date.parse(report.time) + 1000);
  state.predictedPosition.set(position);
  assert.equal(state.predictedTarget()!.longitude, position.longitude);
  assert.equal(state.targets()[0].longitude, report.longitude);
  const newer = { ...report, time: new Date(Date.parse(report.time) + 1000).toISOString(), longitude: report.longitude + 0.001 };
  publish([newer]);
  assert.equal(state.predictionTarget()!.time, newer.time);
  assert.equal(state.predictionTarget()!.longitude, newer.longitude);
  publish([report]);
  assert.equal(state.predictionTarget()!.longitude, newer.longitude);
  publish([]);
  assert.equal(state.targets().length, 0);
  assert.equal(state.selectedTarget()!.mmsi, report.mmsi);
  assert.equal(state.trackedMmsi(), report.mmsi);
  stream.dispatchEvent(new Event('error'));
  assert.equal(state.status(), 'reconnecting');
  assert.equal(state.predictionSeconds(), 2.5);
  assert.equal(state.predictionTarget()!.longitude, newer.longitude);
  state.setBodyDimensions(report.mmsi, body);
  assert.deepEqual(state.selectedBodyOverride(), body);
  assert.equal(state.predictionSeconds(), 2.5);
  const latest = { ...newer, time: new Date(Date.parse(newer.time) + 1000).toISOString(), speed: 5 };
  publish([latest]);
  assert.equal(state.status(), 'connected');
  assert.equal(state.predictionTarget()!.speed, 5);
  const beforePredictionChange = state.selectionRevision();
  state.startPrediction(0);
  assert.equal(state.predictionSeconds(), 0);
  assert.notEqual(state.selectionRevision(), beforePredictionChange);
  state.clearTracking();
  assert.equal(state.predictionSeconds(), null);
  assert.equal(state.predictionTarget(), null);
  assert.equal(state.predictedPosition(), null);
  assert.equal(state.predictedTarget(), null);
  state.startPrediction(0);
  state.selectTarget('');
  assert.equal(state.predictionSeconds(), null);
  assert.equal(state.trackedMmsi(), '');
  state.selectTarget(report.mmsi);
  state.trackedMmsi.set(report.mmsi);
  stream.dispatchEvent(new Event('error'));
  assert.equal(state.trackedMmsi(), '');
  assert.equal(state.selectedTarget(), null);
  console.log('AIS HTTP consumer PASS');
} finally { state.ngOnDestroy(); injector.destroy(); }
