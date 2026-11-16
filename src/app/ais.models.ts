export interface VesselTarget {
  mmsi: string;
  time: string;
  longitude: number;
  latitude: number;
  heading: number | null;
  length: number | null;
  width: number | null;
  speed: number | null;
}

export interface VesselGeometryOptions {
  antennaFromSternRatio: number;
  antennaFromPortRatio: number;
  heightMeters: number;
}

export interface VesselBodyDimensions {
  a: number;
  b: number;
  c: number;
  d: number;
  height: number;
}

export interface VesselSourceInfo {
  id: string;
  name: string;
  type: 'ais';
  geometry: VesselGeometryOptions;
  maxDistanceMeters: number;
  expireAfterMs: number;
}

export interface VesselSourceCatalog {
  project: { id: string; name: string };
  sources: VesselSourceInfo[];
}

export interface VesselSnapshot {
  sourceId: string;
  status: 'idle' | 'connecting' | 'connected' | 'reconnecting';
  error: string | null;
  receivedAt: string | null;
  targets: VesselTarget[];
}
