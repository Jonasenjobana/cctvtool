import '@angular/compiler';
import assert from 'node:assert/strict';
import { Injector, runInInjectionContext } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { from } from 'rxjs';
import { AisState } from '../../src/app/ais-state.service';
import { ApiService } from '../../src/app/api.service';

const origin = process.env.AIS_TEST_ORIGIN!;
const NativeEventSource = globalThis.EventSource;
let failNext = process.env.AIS_TEST_INIT_FAILURE === '1';
// 复现注入脚本的透明代理：方法绑定原对象，属性写入仍使用 Proxy receiver。
globalThis.EventSource = new Proxy(NativeEventSource, {
  construct(target, args) {
    if (failNext) { failNext = false; throw new TypeError('Illegal invocation'); }
    const source = Reflect.construct(target, [new URL(args[0], origin).href]);
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
  console.log('AIS HTTP consumer PASS');
} finally { state.ngOnDestroy(); injector.destroy(); }
