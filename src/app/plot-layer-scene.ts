import {
  BoundingSphere, Cartesian3, Color, ColorMaterialProperty, ConstantProperty, GeoJsonDataSource,
  HeadingPitchRange, JulianDate, Matrix4, PolylineDashMaterialProperty,
} from 'cesium';
import type { PerspectiveFrustum, Viewer } from 'cesium';
import type {
  PlotLayerError, PlotLayerFocusRequest, PlotLayerFocusResult, PlotLayerRenderInput,
} from './plot-layer.models';

type Position = number[];
type Coordinates = number[] | Coordinates[];
type Geometry =
  | { type: 'Point'; coordinates: Position }
  | { type: 'MultiPoint' | 'LineString'; coordinates: Position[] }
  | { type: 'MultiLineString' | 'Polygon'; coordinates: Position[][] }
  | { type: 'MultiPolygon'; coordinates: Position[][][] }
  | { type: 'GeometryCollection'; geometries: Geometry[] };
interface Feature {
  type: 'Feature';
  id?: string | number;
  properties: Record<string, unknown> | null;
  geometry: Geometry | null;
}
interface FeatureCollection { type: 'FeatureCollection'; features: Feature[]; }

const plotColor = Color.fromCssColorString('#3687ff');
const defaultFillOpacity = 0.25;
const minimumLineWidth = 4;
const renderStyleProperties = [
  'marker-size', 'marker-symbol', 'marker-color',
  'stroke', 'stroke-opacity', 'stroke-width', 'stroke-dasharray', 'fill', 'fill-opacity',
];

function applyDisplayStyle(source: GeoJsonDataSource, onSurface: boolean) {
  const time = JulianDate.now();
  for (const entity of source.entities.values) {
    const polygon = entity.polygon;
    if (polygon) {
      polygon.fill = new ConstantProperty(true);
      polygon.outline = new ConstantProperty(false);
    }
    const polyline = entity.polyline;
    if (!polyline) continue;
    const color: Color = polyline.material?.getValue(time)?.color ?? plotColor;
    const inputWidth: unknown = polyline.width?.getValue(time);
    const width = typeof inputWidth === 'number' && Number.isFinite(inputWidth)
      ? Math.max(minimumLineWidth, inputWidth) : minimumLineWidth;
    let material: ColorMaterialProperty | PolylineDashMaterialProperty = new ColorMaterialProperty(color);
    const dashValue: unknown = entity.properties?.['stroke-dasharray']?.getValue(time);
    const dash = typeof dashValue === 'string' ? dashValue.trim().split(/[\s,]+/).map(Number) : dashValue;
    if (Array.isArray(dash) && dash.length === 2
      && dash.every((value) => typeof value === 'number' && Number.isFinite(value) && value > 0)
      && Number.isFinite(dash[0] + dash[1])) {
      const dashLength = dash[0] + dash[1];
      const dashBits = Math.max(1, Math.min(15, Math.round(16 * dash[0] / dashLength)));
      material = new PolylineDashMaterialProperty({ color, dashLength, dashPattern: (1 << dashBits) - 1 });
      polyline.material = material;
    }
    polyline.width = new ConstantProperty(width);
    // 标准折线在屏幕上扩宽，避免低机位下贴地横线被压扁；深度重合时沿用同一材质，坐标保持不变。
    polyline.clampToGround = new ConstantProperty(false);
    if (onSurface) polyline.depthFailMaterial = material;
  }
}

function* positions(coordinates: Coordinates): Generator<Position> {
  if (!coordinates.length) return;
  if (typeof coordinates[0] === 'number') {
    yield coordinates as Position;
  } else {
    for (const child of coordinates as Coordinates[]) yield* positions(child);
  }
}

/** 跳过合法的空几何；只构造展示副本，不修改入库原文或要素属性。 */
function nonEmptyGeometry(geometry: Exclude<Geometry, { type: 'GeometryCollection' }>) {
  const coordinates = geometry.coordinates;
  switch (geometry.type) {
    case 'Point':
    case 'LineString':
      return coordinates.length ? geometry : null;
    case 'MultiPoint':
    case 'MultiLineString': {
      const parts = geometry.coordinates.filter((part) => part.length);
      return parts.length ? { ...geometry, coordinates: parts } as typeof geometry : null;
    }
    case 'Polygon':
      return geometry.coordinates[0]?.length
        ? { ...geometry, coordinates: geometry.coordinates.filter((ring) => ring.length) } : null;
    case 'MultiPolygon': {
      const polygons = geometry.coordinates.filter((polygon) => polygon[0]?.length)
        .map((polygon) => polygon.filter((ring) => ring.length));
      return polygons.length ? { ...geometry, coordinates: polygons } : null;
    }
    default:
      throw new Error('无法展示该 GeoJSON 几何类型');
  }
}

function displayData(text: string) {
  const document: Feature | FeatureCollection | Geometry = JSON.parse(text.replace(/^\uFEFF/, ''));
  const ground: FeatureCollection = { type: 'FeatureCollection', features: [] };
  const elevated: FeatureCollection = { type: 'FeatureCollection', features: [] };
  const points: Cartesian3[] = [];
  const visit = (geometry: Geometry | null, feature?: Feature) => {
    if (!geometry) return;
    if (geometry.type === 'GeometryCollection') {
      for (const child of geometry.geometries) visit(child, feature);
      return;
    }
    const displayGeometry = nonEmptyGeometry(geometry);
    if (!displayGeometry) return;
    let dimension = 0;
    for (const position of positions(displayGeometry.coordinates)) {
      dimension = position.length;
      points.push(Cartesian3.fromDegrees(position[0], position[1], position[2] ?? 0));
    }
    if (!dimension) return;
    const target = dimension === 2 ? ground : elevated;
    // 业务字段可能与 Cesium 的属性方法同名；展示副本只传绘制样式，完整属性仍留在原文和缓存。
    const properties = feature?.properties;
    let displayProperties = properties ? Object.fromEntries(
      renderStyleProperties.filter((key) => Object.hasOwn(properties, key))
        .map((key) => [key, properties[key]]),
    ) : null;
    if (displayGeometry.type === 'Polygon' || displayGeometry.type === 'MultiPolygon') {
      displayProperties ??= {};
      displayProperties['fill'] = '#ffff00';
      // 纯轮廓文件也以区域颜色显示，只调整展示副本，不改写原文中的透明度。
      if (displayProperties['fill-opacity'] === 0) displayProperties['fill-opacity'] = defaultFillOpacity;
    }
    target.features.push({
      type: 'Feature', id: feature?.id, properties: displayProperties, geometry: displayGeometry,
    });
  };
  if (document.type === 'FeatureCollection') {
    for (const feature of document.features) visit(feature.geometry, feature);
  } else if (document.type === 'Feature') {
    visit(document.geometry, document);
  } else {
    visit(document);
  }
  return {
    // 后端已校验 WGS84；展示副本使用 Cesium 的默认 WGS84，不传播 CRS 外来成员。
    groups: [{ data: ground, clampToGround: true }, { data: elevated, clampToGround: false }]
      .filter((group) => group.data.features.length),
    bounds: points.length ? BoundingSphere.fromPoints(points) : undefined,
  };
}

interface LayerState {
  input: PlotLayerRenderInput;
  generation: number;
  sources: GeoJsonDataSource[];
  loading?: Promise<void>;
  failed: boolean;
  bounds?: BoundingSphere;
}
interface FocusState {
  request: PlotLayerFocusRequest;
  layer?: LayerState;
  flying: boolean;
}

/** 仅拥有标绘数据源；摄像头、底图和视频资源仍由原场景管理。 */
export class PlotLayerScene {
  private readonly layers = new Map<string, LayerState>();
  private generation = 0;
  private destroyed = false;
  private activeFocus?: FocusState;
  private lastFocus: PlotLayerFocusRequest | null = null;

  constructor(
    private readonly viewer: Viewer,
    private readonly layerError: (error: PlotLayerError) => void,
    private readonly focusResult: (result: PlotLayerFocusResult) => void,
  ) {}

  sync(inputs: readonly PlotLayerRenderInput[]) {
    if (!this.alive()) return;
    this.generation++;
    const desired = new Map(inputs.map((input) => [input.id, input]));
    for (const [id, state] of this.layers) {
      const input = desired.get(id);
      if (!input || input.geojsonText !== state.input.geojsonText || state.failed) {
        this.layers.delete(id);
        this.releaseSources(state.sources);
        state.sources = [];
      }
    }
    for (const input of desired.values()) {
      let state = this.layers.get(input.id);
      if (state) {
        state.input = { ...input };
        state.generation = this.generation;
        for (const source of state.sources) {
          source.name = input.name;
          source.show = input.visible;
        }
      } else {
        state = { input: { ...input }, generation: this.generation, sources: [], failed: false };
        this.layers.set(input.id, state);
        state.loading = this.load(state);
      }
    }
    const focusing = this.activeFocus?.layer;
    if (focusing && (!this.current(focusing) || !focusing.input.visible)) {
      this.cancelFocus('图层状态已变化，请重新定位');
    }
    this.render();
  }

  focus(request: PlotLayerFocusRequest | null) {
    if (request?.requestId === this.lastFocus?.requestId && request?.layerId === this.lastFocus?.layerId) return;
    this.lastFocus = request ? { ...request } : null;
    this.cancelFocus('定位已取消');
    if (!request || !this.alive()) return;
    const focus: FocusState = { request: { ...request }, layer: this.layers.get(request.layerId), flying: false };
    this.activeFocus = focus;
    void this.runFocus(focus);
  }

  private alive() {
    return !this.destroyed && !this.viewer.isDestroyed();
  }

  private current(state: LayerState) {
    return this.alive() && state.generation === this.generation && this.layers.get(state.input.id) === state;
  }

  private async load(state: LayerState) {
    const sources = state.sources;
    try {
      const display = displayData(state.input.geojsonText);
      state.bounds = display.bounds;
      for (const group of display.groups) {
        const source = new GeoJsonDataSource(state.input.name);
        sources.push(source);
        await source.load(group.data, {
          markerColor: plotColor, stroke: plotColor, strokeWidth: 2, fill: plotColor.withAlpha(defaultFillOpacity),
          clampToGround: group.clampToGround,
        });
        // 同原文允许沿用最新名称/显隐；已移除或被替换的加载结果不能重新进入场景。
        if (!this.current(state)) {
          this.releaseSources(sources);
          return;
        }
        applyDisplayStyle(source, group.clampToGround);
      }
      for (const source of sources) {
        if (!this.current(state)) {
          this.releaseSources(sources);
          return;
        }
        source.name = state.input.name;
        source.show = state.input.visible;
        await this.viewer.dataSources.add(source);
        if (!this.current(state)) {
          this.releaseSources(sources);
          return;
        }
      }
      this.render();
    } catch (error) {
      this.releaseSources(sources);
      state.sources = [];
      if (!this.current(state)) return;
      state.failed = true;
      this.layerError({ layerId: state.input.id, message: '标绘图层加载失败，请刷新后重试' });
      console.error('Cesium 标绘图层加载失败', error);
    }
  }

  private async runFocus(focus: FocusState) {
    const state = focus.layer;
    if (!state) {
      this.finishFocus(focus, false, '当前摄像头未加载该标绘图层');
      return;
    }
    await state.loading;
    if (this.activeFocus !== focus) return;
    if (!this.current(state) || !state.input.visible) {
      this.finishFocus(focus, false, '图层状态已变化，请重新定位');
      return;
    }
    if (state.failed) {
      this.finishFocus(focus, false, '标绘图层加载失败，请刷新后重试');
      return;
    }
    if (!state.bounds) {
      this.finishFocus(focus, false, '该图层没有可定位的有效几何');
      return;
    }
    try {
      const camera = this.viewer.camera;
      (camera.frustum as PerspectiveFrustum).fov = Math.PI / 3;
      camera.lookAtTransform(Matrix4.IDENTITY);
      focus.flying = true;
      // 直接使用已解析坐标的包围球，避免 Viewer.flyTo 的待处理目标在图层失效后才开始移动。
      camera.flyToBoundingSphere(state.bounds, {
        duration: 0.8, offset: new HeadingPitchRange(0, -Math.PI / 3, 0),
        complete: () => {
          const success = this.current(state) && state.input.visible;
          this.finishFocus(focus, success, success ? '' : '图层状态已变化，请重新定位');
        },
        cancel: () => this.finishFocus(focus, false, '定位已取消'),
      });
      this.render();
    } catch (error) {
      this.finishFocus(focus, false, '图层定位失败，请重试');
      console.error('Cesium 标绘图层定位失败', error);
    }
  }

  private finishFocus(focus: FocusState, success: boolean, message: string) {
    if (this.activeFocus !== focus) return;
    this.activeFocus = undefined;
    if (!this.alive()) return;
    this.focusResult({ requestId: focus.request.requestId, success, message });
    this.render();
  }

  private cancelFocus(message?: string) {
    const focus = this.activeFocus;
    if (!focus) return;
    this.activeFocus = undefined;
    if (focus.flying && this.alive()) this.viewer.camera.cancelFlight();
    if (message && this.alive()) this.focusResult({ requestId: focus.request.requestId, success: false, message });
  }

  private releaseSources(sources: GeoJsonDataSource[]) {
    for (const source of sources) {
      if (!this.viewer.isDestroyed()) this.viewer.dataSources.remove(source);
      // GeoJsonDataSource 没有 destroy()，移除实体并释放本模块引用即可。
      source.entities.removeAll();
    }
  }

  private render() {
    if (this.alive()) this.viewer.scene.requestRender();
  }

  destroy() {
    this.cancelFocus();
    this.destroyed = true;
    this.generation++;
    for (const state of this.layers.values()) {
      this.releaseSources(state.sources);
      state.sources = [];
    }
    this.layers.clear();
    this.lastFocus = null;
  }
}
