import type { MotionCommand, PtzCommand } from './models';

export interface HoldControlState {
  busy: boolean;
  command: MotionCommand | null;
  stopping: boolean;
  error: string;
  message: string;
}

type Send = (id: string, command: PtzCommand, speed: number, keepalive?: boolean) => Promise<unknown>;
interface Gesture {
  id: string;
  speed: number;
  command: MotionCommand;
  held: boolean;
  settled: boolean;
  startError: string;
  start: Promise<void>;
  stop?: Promise<void>;
}

/** 一次按住绑定一次设备；松手后，迟到的启动响应不能重新进入运动状态。 */
export class HoldPtzControl {
  private readonly send: Send;
  private readonly changed: (state: HoldControlState) => void;
  private readonly describe: (error: unknown) => string;
  private gesture?: Gesture;

  constructor(send: Send, changed: (state: HoldControlState) => void, describe: (error: unknown) => string) {
    this.send = send;
    this.changed = changed;
    this.describe = describe;
  }

  get busy() { return !!this.gesture; }

  start(id: string, command: MotionCommand, speed: number) {
    if (this.gesture) return;
    const gesture: Gesture = { id, command, speed, held: true, settled: false, startError: '', start: Promise.resolve() };
    this.gesture = gesture;
    this.publish(gesture, false, '', '正在发送控制指令');
    let request: Promise<unknown>;
    try { request = this.send(id, command, speed); } catch (error) { request = Promise.reject(error); }
    gesture.start = request.then(() => {
      gesture.settled = true;
      if (gesture.held) this.publish(gesture, false, '', '按住控制，松手停止');
    }, (error: unknown) => {
      gesture.settled = true;
      gesture.startError = `控制请求失败：${this.describe(error)}`;
      // 请求失败不能证明设备没有运动，仍需发送停止。
      void this.release();
    });
  }

  release(keepalive = false): Promise<void> {
    const gesture = this.gesture;
    if (!gesture) return Promise.resolve();
    if (gesture.stop) {
      if (keepalive) void this.stopRequest(gesture, true);
      return gesture.stop;
    }
    gesture.held = false;
    const pendingStart = !gesture.settled;
    this.publish(gesture, true, gesture.startError, '正在停止');
    // 松手立即请求 stop，启动仍未回包时，在其结束后再补一次 stop。
    const firstStop = this.stopRequest(gesture, keepalive);
    const task = (async () => {
      let error = await firstStop;
      await gesture.start;
      if (pendingStart) error = await this.stopRequest(gesture, keepalive);
      if (error) {
        this.publish(gesture, false, `停止请求失败：${this.describe(error)}，请点击“停止”重试`, '');
      } else {
        this.gesture = undefined;
        this.changed({ busy: false, command: null, stopping: false, error: gesture.startError,
          message: '停止指令已发送，状态以回读为准' });
      }
    })();
    gesture.stop = task;
    return task.finally(() => { if (gesture.stop === task) gesture.stop = undefined; });
  }

  private async stopRequest(gesture: Gesture, keepalive: boolean): Promise<unknown> {
    try { await this.send(gesture.id, 'stop', gesture.speed, keepalive); return null; } catch (error) { return error; }
  }

  private publish(gesture: Gesture, stopping: boolean, error: string, message: string) {
    this.changed({ busy: true, command: gesture.held ? gesture.command : null, stopping, error, message });
  }
}
