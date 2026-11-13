import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

const paths: Record<string, string> = {
  camera: 'M4 7h4l2-3h4l2 3h4v13H4z M16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  video: 'M3 5h12v14H3z M15 9l6-4v14l-6-4',
  devices: 'M3 5h18v12H3z M8 21h8 M12 17v4 M7 9h4 M7 13h8',
  image: 'M3 3h18v18H3z M3 16l6-6 5 5 3-3 4 4 M17 7h.01',
  tasks: 'M9 5h11 M9 12h11 M9 19h11 M3 5h.01 M3 12h.01 M3 19h.01',
  horizon: 'M3 15h18 M3 18h18 M5 12l4-5 4 5 4-3 4 3 M3 3h18v18H3z',
  map: 'M3 5l6-2 6 2 6-2v16l-6 2-6-2-6 2z M9 3v16 M15 5v16',
  layers: 'M12 3L2 8l10 5 10-5-10-5 M2 12l10 5 10-5 M2 16l10 5 10-5',
  up: 'M6 15l6-6 6 6',
  down: 'M6 9l6 6 6-6',
  left: 'M15 6l-6 6 6 6',
  right: 'M9 6l6 6-6 6',
  plus: 'M12 4v16 M4 12h16',
  minus: 'M4 12h16',
  close: 'M6 6l12 12 M18 6L6 18',
  target: 'M12 2v4 M12 18v4 M2 12h4 M18 12h4 M19 12a7 7 0 1 1-14 0 7 7 0 0 1 14 0 M12 12h.01',
  save: 'M5 3h12l4 4v14H3V3z M7 3v6h10V3 M7 21v-8h10v8',
  check: 'M4 12l5 5L20 6',
  refresh: 'M20 7v5h-5 M20 12a8 8 0 1 0-2 5',
  download: 'M12 3v12 M7 10l5 5 5-5 M4 17v4h16v-4',
  back: 'M10 5l-7 7 7 7 M3 12h18',
};

@Component({
  selector: 'app-icon',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path [attr.d]="path" /></svg>',
  styles: ':host{display:inline-flex;width:20px;height:20px;flex-shrink:0}svg{width:100%;height:100%}',
})
export class IconComponent {
  @Input() name = '';
  get path() { return paths[this.name] || paths['camera']; }
}
