import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { createZeroPoseQuaternion, updateZeroPoseTiltOffset } from '#zero-pose';
import type { ZeroPose } from '#zero-pose';

type Axis = { key: 'yaw' | 'pitch' | 'roll'; label: string; direction: string; min: number; max: number };

@Component({
  selector: 'app-zero-pose-editor',
  standalone: true,
  imports: [DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="axes">
      @for (axis of axes; track axis.key) {
        <div class="axis">
          <label [for]="'zero-pose-' + axis.key">{{ axis.label }}（°）</label>
          <div class="dial" role="slider" [attr.aria-label]="'零位 ' + axis.label + ' 方位盘'"
            [attr.aria-valuemin]="axis.min" [attr.aria-valuemax]="axis.max"
            [attr.aria-valuenow]="pose()[axis.key]" [attr.aria-disabled]="disabled()"
            [attr.tabindex]="disabled() ? -1 : 0"
            (pointerdown)="start(axis, $event)" (pointermove)="move(axis, $event)" (keydown)="adjust(axis, $event)">
            <span [style.transform]="'rotate(' + pose()[axis.key] + 'deg)'" aria-hidden="true"></span>
          </div>
          <input [id]="'zero-pose-' + axis.key" type="number" [min]="axis.min" [max]="axis.max" step="any"
            [value]="pose()[axis.key]" [disabled]="disabled()" (input)="edit(axis.key, $event)" (blur)="restoreIfInvalid(axis.key, $event)">
          <span class="direction">{{ axis.direction }}</span>
        </div>
      }
    </div>
    <label class="tilt" for="zero-pose-tilt">零位 T 补偿（°）
      <input id="zero-pose-tilt" type="number" min="-180" max="180" step="any"
        [value]="pose().tiltOffset" [disabled]="disabled()" (input)="edit('tiltOffset', $event)" (blur)="restoreIfInvalid('tiltOffset', $event)">
    </label>
    @if (invalidAngle()) { <p class="input-error" role="alert">请输入范围内的角度。</p> }
    <div class="quaternion">
      <span>零位四元数（x, y, z, w）</span>
      <output>{{ quaternion().x | number:'1.6-6' }}, {{ quaternion().y | number:'1.6-6' }},
        {{ quaternion().z | number:'1.6-6' }}, {{ quaternion().w | number:'1.6-6' }}</output>
    </div>
  `,
  styles: `
    :host{display:block}
    .axes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
    .axis{display:grid;justify-items:center;gap:7px;min-width:0}
    .axis label,.direction,.tilt,.quaternion>span{font-size:11px;color:#666f7c}
    .axis input,.tilt input{width:100%;min-width:0;height:32px;padding:0 6px;font-size:12px;font-variant-numeric:tabular-nums}
    .dial{position:relative;width:56px;aspect-ratio:1;border:1px solid #c8d4e3;border-radius:50%;background:#f7f9fc;cursor:grab;touch-action:none}
    .dial[aria-disabled="true"]{cursor:default;opacity:.55}
    .dial:focus-visible{outline:2px solid #346dd0;outline-offset:2px}
    .dial::before{content:'';position:absolute;top:2px;left:calc(50% - 1px);width:2px;height:5px;background:#8a98ae}
    .dial span{position:absolute;inset:0;pointer-events:none}
    .dial span::before{content:'';position:absolute;bottom:50%;left:calc(50% - 1px);width:2px;height:40%;background:#346dd0}
    .dial span::after{content:'';position:absolute;top:calc(50% - 3px);left:calc(50% - 3px);width:6px;height:6px;border-radius:50%;background:#346dd0}
    .tilt{display:grid;gap:6px;margin-top:10px}
    .quaternion{display:grid;gap:5px;margin-top:10px}
    output{font:11px monospace;color:#344055;overflow-wrap:anywhere}
    .input-error{font-size:11px;color:#a63931}
  `,
})
export class ZeroPoseEditorComponent {
  readonly pose = input.required<ZeroPose>();
  readonly disabled = input(false);
  readonly changed = output<ZeroPose>();
  readonly quaternion = computed(() => createZeroPoseQuaternion(this.pose()));
  readonly invalidAngle = signal(false);
  readonly axes: Axis[] = [
    { key: 'yaw', label: 'Yaw', direction: '从真北顺时针', min: 0, max: 360 },
    { key: 'pitch', label: 'Pitch', direction: '上仰为正', min: -90, max: 90 },
    { key: 'roll', label: 'Roll', direction: '绕光轴右手', min: -180, max: 180 },
  ];

  edit(key: keyof ZeroPose, event: Event) {
    const field = event.target as HTMLInputElement;
    if (field.validity.valid && Number.isFinite(field.valueAsNumber)) this.setAngle(key, field.valueAsNumber);
  }

  restoreIfInvalid(key: keyof ZeroPose, event: Event) {
    const field = event.target as HTMLInputElement;
    if (field.validity.valid && Number.isFinite(field.valueAsNumber)) return;
    field.value = String(this.pose()[key]);
    this.invalidAngle.set(true);
  }

  start(axis: Axis, event: PointerEvent) {
    if (this.disabled() || !event.isPrimary || event.button !== 0) return;
    const dial = event.currentTarget as HTMLElement;
    dial.setPointerCapture(event.pointerId);
    this.move(axis, event);
  }

  move(axis: Axis, event: PointerEvent) {
    const dial = event.currentTarget as HTMLElement;
    if (this.disabled() || !dial.hasPointerCapture(event.pointerId)) return;
    const bounds = dial.getBoundingClientRect();
    const x = event.clientX - bounds.left - bounds.width / 2;
    const y = bounds.top + bounds.height / 2 - event.clientY;
    if (Math.hypot(x, y) < 3) return;
    this.setDialAngle(axis, Math.atan2(x, y) * 180 / Math.PI);
  }

  adjust(axis: Axis, event: KeyboardEvent) {
    if (this.disabled()) return;
    let angle = this.pose()[axis.key];
    const step = event.shiftKey ? 1 : 0.1;
    switch (event.key) {
      case 'ArrowRight': case 'ArrowUp': angle += step; break;
      case 'ArrowLeft': case 'ArrowDown': angle -= step; break;
      case 'Home': angle = axis.min; break;
      case 'End': angle = axis.key === 'yaw' ? 359.99 : axis.max; break;
      default: return;
    }
    event.preventDefault();
    this.setDialAngle(axis, angle);
  }

  private setDialAngle(axis: Axis, angle: number) {
    const rounded = Number(angle.toFixed(2));
    this.setAngle(axis.key, axis.key === 'yaw' ? rounded : Math.max(axis.min, Math.min(axis.max, rounded)));
  }

  private setAngle(key: keyof ZeroPose, value: number) {
    this.invalidAngle.set(false);
    const pose = this.pose();
    const angle = key === 'yaw' && (value < 0 || value >= 360) ? ((value % 360) + 360) % 360 : value;
    if (pose[key] === angle) return;
    this.changed.emit(key === 'tiltOffset' ? updateZeroPoseTiltOffset(pose, angle) : { ...pose, [key]: angle });
  }
}
