import {
  Cartesian2, Cartesian3, Cartographic, Credit, Math as CesiumMath, Rectangle,
  UrlTemplateImageryProvider, WebMercatorProjection, WebMercatorTilingScheme, type TilingScheme,
} from 'cesium';

/** 本地近似转换的适用范围；范围外坐标不施加偏移。 */
function outsideChina(longitude: number, latitude: number): boolean {
  return longitude < 72.004 || longitude > 137.8347 || latitude < 0.8293 || latitude > 55.8271;
}

/** WGS84 度坐标转 GCJ-02，返回新坐标，不修改接口或场景原始数据。 */
export function wgs84ToGcj02(longitude: number, latitude: number): [number, number] {
  if (outsideChina(longitude, latitude)) return [longitude, latitude];
  const x = longitude - 105;
  const y = latitude - 35;
  const pi = Math.PI;
  const common = (20 * Math.sin(6 * x * pi) + 20 * Math.sin(2 * x * pi)) * 2 / 3;
  let dLat = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x)) + common;
  dLat += (20 * Math.sin(y * pi) + 40 * Math.sin(y * pi / 3)) * 2 / 3;
  dLat += (160 * Math.sin(y * pi / 12) + 320 * Math.sin(y * pi / 30)) * 2 / 3;
  let dLon = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x)) + common;
  dLon += (20 * Math.sin(x * pi) + 40 * Math.sin(x * pi / 3)) * 2 / 3;
  dLon += (150 * Math.sin(x * pi / 12) + 300 * Math.sin(x * pi / 30)) * 2 / 3;
  const radLat = latitude * pi / 180;
  const magic = 1 - 0.006693421622965943 * Math.sin(radLat) ** 2;
  const sqrtMagic = Math.sqrt(magic);
  dLat = dLat * 180 / ((6378245 * (1 - 0.006693421622965943) / (magic * sqrtMagic)) * pi);
  dLon = dLon * 180 / ((6378245 / sqrtMagic) * Math.cos(radLat) * pi);
  return [longitude + dLon, latitude + dLat];
}

/** 瓦片地理边界反算回 WGS84，迭代求本地近似算法的逆变换。 */
export function gcj02ToWgs84(longitude: number, latitude: number): [number, number] {
  if (outsideChina(longitude, latitude)) return [longitude, latitude];
  let wgsLon = longitude;
  let wgsLat = latitude;
  for (let iteration = 0; iteration < 10; iteration++) {
    const [gcjLon, gcjLat] = wgs84ToGcj02(wgsLon, wgsLat);
    const dLon = gcjLon - longitude;
    const dLat = gcjLat - latitude;
    wgsLon -= dLon;
    wgsLat -= dLat;
    if (Math.max(Math.abs(dLon), Math.abs(dLat)) < 1e-9) break;
  }
  return [wgsLon, wgsLat];
}

/** 只在高德影像层投影时转 GCJ-02，世界坐标和 CCTV 几何仍为 WGS84。 */
export class AmapProjection extends WebMercatorProjection {
  override project(position: Cartographic, result?: Cartesian3): Cartesian3 {
    const [longitude, latitude] = wgs84ToGcj02(
      CesiumMath.toDegrees(position.longitude), CesiumMath.toDegrees(position.latitude),
    );
    return super.project(Cartographic.fromDegrees(longitude, latitude, position.height), result);
  }

  override unproject(position: Cartesian3, result?: Cartographic): Cartographic {
    const gcj = super.unproject(position);
    const [longitude, latitude] = gcj02ToWgs84(CesiumMath.toDegrees(gcj.longitude), CesiumMath.toDegrees(gcj.latitude));
    return Cartographic.fromDegrees(longitude, latitude, gcj.height, result);
  }
}

/** 使用公开方法适配瓦片地理边界与选片，不改 Cesium 的私有 _projection。 */
export class AmapTilingScheme implements TilingScheme {
  private readonly grid = new WebMercatorTilingScheme();
  readonly ellipsoid = this.grid.ellipsoid;
  readonly rectangle = this.grid.rectangle;
  readonly projection = new AmapProjection(this.ellipsoid);

  getNumberOfXTilesAtLevel(level: number): number { return this.grid.getNumberOfXTilesAtLevel(level); }
  getNumberOfYTilesAtLevel(level: number): number { return this.grid.getNumberOfYTilesAtLevel(level); }

  tileXYToNativeRectangle(x: number, y: number, level: number, result?: Rectangle): Rectangle {
    return this.grid.tileXYToNativeRectangle(x, y, level, result);
  }

  rectangleToNativeRectangle(rectangle: Rectangle, result = new Rectangle()): Rectangle {
    const southwest = this.projection.project(Rectangle.southwest(rectangle));
    const northeast = this.projection.project(Rectangle.northeast(rectangle));
    result.west = southwest.x;
    result.south = southwest.y;
    result.east = northeast.x;
    result.north = northeast.y;
    return result;
  }

  tileXYToRectangle(x: number, y: number, level: number, result = new Rectangle()): Rectangle {
    const native = this.grid.tileXYToNativeRectangle(x, y, level);
    const southwest = this.projection.unproject(new Cartesian3(native.west, native.south));
    const northeast = this.projection.unproject(new Cartesian3(native.east, native.north));
    result.west = southwest.longitude;
    result.south = southwest.latitude;
    result.east = northeast.longitude;
    result.north = northeast.latitude;
    return result;
  }

  positionToTileXY(position: Cartographic, level: number, result?: Cartesian2): Cartesian2 {
    const [longitude, latitude] = wgs84ToGcj02(CesiumMath.toDegrees(position.longitude), CesiumMath.toDegrees(position.latitude));
    return this.grid.positionToTileXY(Cartographic.fromDegrees(longitude, latitude, position.height), level, result);
  }
}

export function createAmapImagery(): UrlTemplateImageryProvider {
  return new UrlTemplateImageryProvider({
    // 偏移仅作用于影像瓦片，摄像头与投影几何保持 WGS84。
    url: 'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
    subdomains: ['1', '2', '3', '4'],
    minimumLevel: 0, maximumLevel: 18,
    tilingScheme: new AmapTilingScheme(),
    credit: new Credit('高德地图 AutoNavi', true),
  });
}
