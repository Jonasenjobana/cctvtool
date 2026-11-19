import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, model, output, signal } from '@angular/core';
import { createZeroPoseQuaternion } from '#zero-pose';
import type { ZeroPose } from '#zero-pose';

type AngleKey = 'yaw' | 'pitch' | 'roll';
type AngleControl = { key: AngleKey; min: number; max: number };
type Axis = AngleControl & { label: string; direction: string };

@Component({
  selector: 'app-zero-pose-editor',
  standalone: true,
  imports: [DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <label class="angle-step" for="zero-pose-angle-step">
      调节步长（°）
      <select id="zero-pose-angle-step" #stepSelect [disabled]="disabled()" (change)="angleStep.set(+stepSelect.value)">
        @for (step of angleSteps; track step) {
          <option [value]="step" [selected]="step === angleStep()">{{ step }}</option>
        }
      </select>
    </label>
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
          <input [id]="'zero-pose-' + axis.key" type="number" [min]="axis.min" [max]="axis.max" [step]="angleStep()"
            [value]="pose()[axis.key]" [disabled]="disabled()" (input)="edit(axis.key, $event)"
            (blur)="restoreIfInvalid(axis.key, $event)" (keydown)="adjustNumber(axis, $event)">
          <span class="direction">{{ axis.direction }}</span>
        </div>
      }
    </div>
    @if (invalidAngle()) { <p class="input-error" role="alert">请输入范围内的角度。</p> }
    <div class="quaternion">
      <span>零位四元数（x, y, z, w）</span>
      <output>{{ quaternion().x | number:'1.6-6' }}, {{ quaternion().y | number:'1.6-6' }},
        {{ quaternion().z | number:'1.6-6' }}, {{ quaternion().w | number:'1.6-6' }}</output>
    </div>
  `,
  styles: `
    :host{display:block}
    .angle-step{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;font-size:11px;color:#666f7c}
    .angle-step select{min-width:96px;height:28px;padding:0 6px;font-size:12px;font-variant-numeric:tabular-nums}
    .axes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
    .axis{display:grid;justify-items:center;gap:7px;min-width:0}
    .axis label,.direction,.quaternion>span{font-size:11px;color:#666f7c}
    .axis input{width:100%;min-width:0;height:32px;padding:0 6px;font-size:12px;font-variant-numeric:tabular-nums}
    .dial{position:relative;width:56px;aspect-ratio:1;border:1px solid #c8d4e3;border-radius:50%;background:#f7f9fc;cursor:grab;touch-action:none}
    .dial[aria-disabled="true"]{cursor:default;opacity:.55}
    .dial:focus-visible{outline:2px solid #346dd0;outline-offset:2px}
    .dial::before{content:'';position:absolute;top:2px;left:calc(50% - 1px);width:2px;height:5px;background:#8a98ae}
    .dial span{position:absolute;inset:0;pointer-events:none}
    .dial span::before{content:'';position:absolute;bottom:50%;left:calc(50% - 1px);width:2px;height:40%;background:#346dd0}
    .dial span::after{content:'';position:absolute;top:calc(50% - 3px);left:calc(50% - 3px);width:6px;height:6px;border-radius:50%;background:#346dd0}
    .quaternion{display:grid;gap:5px;margin-top:10px}
    output{font:11px monospace;color:#344055;overflow-wrap:anywhere}
    .input-error{font-size:11px;color:#a63931}
  `,
})
export class ZeroPoseEditorComponent {
  readonly pose = input.required<ZeroPose>();
  readonly angleStep = model.required<number>();
  readonly angleSteps = [1, 0.1, 0.01, 0.001, 0.0001, 0.00001, 0.000001];
  readonly disabled = input(false);
  readonly changed = output<ZeroPose>();
  readonly quaternion = computed(() => createZeroPoseQuaternion(this.pose()));
  readonly invalidAngle = signal(false);
  readonly axes: Axis[] = [
    { key: 'yaw', label: 'Yaw', direction: '从真北顺时针', min: 0, max: 360 },
    { key: 'pitch', label: 'Pitch', direction: '上仰为正', min: -90, max: 90 },
    { key: 'roll', label: 'Roll', direction: '绕光轴右手', min: -180, max: 180 },
  ];

  edit(key: AngleKey, event: Event) {
    const field = event.target as HTMLInputElement;
    if (this.validAngleInput(field)) this.setAngle(key, field.valueAsNumber);
  }

  restoreIfInvalid(key: AngleKey, event: Event) {
    const field = event.target as HTMLInputElement;
    if (this.validAngleInput(field)) return;
    field.value = String(this.pose()[key]);
    this.invalidAngle.set(true);
  }

  private validAngleInput(field: HTMLInputElement) {
    // 步长控制增减操作，手输的角度按实际范围校验。
    return Number.isFinite(field.valueAsNumber) && !field.validity.rangeUnderflow && !field.validity.rangeOverflow;
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
    const step = this.angleStep();
    const angle = Math.atan2(x, y) * 180 / Math.PI;
    this.setSteppedAngle(axis, Math.round(angle / step) * step);
  }

  adjustNumber(control: AngleControl, event: KeyboardEvent) {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') this.adjust(control, event);
  }

  adjust(control: AngleControl, event: KeyboardEvent) {
    if (this.disabled()) return;
    let angle = this.pose()[control.key];
    const step = this.angleStep() * (event.shiftKey ? 10 : 1);
    switch (event.key) {
      case 'ArrowRight': case 'ArrowUp': angle += step; break;
      case 'ArrowLeft': case 'ArrowDown': angle -= step; break;
      case 'Home': angle = control.min; break;
      case 'End': angle = control.key === 'yaw' ? control.max - this.angleStep() : control.max; break;
      default: return;
    }
    event.preventDefault();
    this.setSteppedAngle(control, angle);
  }

  private setSteppedAngle(control: AngleControl, value: number) {
    const bounded = control.key === 'yaw' ? this.wrapYaw(value) : Math.max(control.min, Math.min(control.max, value));
    // 去掉逐步加减或跨零取模产生的浮点尾数，保留手输角度的有效小数。
    this.setAngle(control.key, Number(bounded.toFixed(12)));
  }

  private wrapYaw(value: number) {
    return value < 0 || value >= 360 ? ((value % 360) + 360) % 360 : value;
  }

  private setAngle(key: AngleKey, value: number) {
    this.invalidAngle.set(false);
    const pose = this.pose();
    const angle = key === 'yaw' ? this.wrapYaw(value) : value;
    if (pose[key] === angle) return;
    this.changed.emit({ ...pose, [key]: angle });
  }
}
