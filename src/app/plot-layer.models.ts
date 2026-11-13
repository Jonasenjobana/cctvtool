export interface PlotLayerAssociation {
  cameraId: string;
  visible: boolean;
}

export interface PlotLayerSummary {
  id: string;
  name: string;
  sourceFileName: string;
  byteLength: number;
  featureCount: number;
  geometryTypes: string[];
  createdAt: string;
  updatedAt: string;
  associations: PlotLayerAssociation[];
}

export interface PlotLayerDetail extends PlotLayerSummary {
  geojsonText: string;
}

export interface PlotLayerImportInput {
  name: string;
  sourceFileName: string;
  geojsonText: string;
  cameraIds: string[];
}

export interface PlotLayerUpdateInput {
  name: string;
  cameraIds: string[];
}

export interface PlotLayerRenderInput {
  id: string;
  name: string;
  geojsonText: string;
  visible: boolean;
}

export interface PlotLayerFocusRequest {
  layerId: string;
  requestId: number;
}

export interface PlotLayerError {
  layerId: string;
  message: string;
}

export interface PlotLayerFocusResult {
  requestId: number;
  success: boolean;
  message: string;
}
