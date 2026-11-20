import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom, timeout } from 'rxjs';
import { ZERO_POSE_MODEL } from '#zero-pose';
import type { Calibration, Camera, CameraInput, DragZoomBox, DragZoomDirection, PlaybackSource, PreciseTarget, PtzCommand, PtzReading, Snapshot, SnapshotGroup, SnapshotGroupPage, SnapshotPage } from './models';
import type { HorizonPoint, RecognitionTask, RecognitionTaskPage, RecognitionItem, RecognitionItemPage,
  ZeroPoseCandidate, ZeroPoseMeasurement } from './models';
import type { PlotLayerAssociation, PlotLayerDetail, PlotLayerImportInput, PlotLayerSummary, PlotLayerUpdateInput } from './plot-layer.models';
import type { VesselSnapshot, VesselSourceCatalog } from './ais.models';
import type { PanoramaGuide, PanoramaGuideState } from '../../shared/panorama-guide';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  health() {
    return firstValueFrom(this.http.get<{ status: string; livegbsConfigured: boolean }>('/api/health').pipe(timeout(10000)));
  }

  cameras() { return firstValueFrom(this.http.get<Camera[]>('/api/cameras').pipe(timeout(10000))); }

  dataSources() { return firstValueFrom(this.http.get<VesselSourceCatalog>('/api/data-sources').pipe(timeout(10000))); }

  dataSourceSnapshot(id: string) {
    return firstValueFrom(this.http.get<VesselSnapshot>(`/api/data-sources/${encodeURIComponent(id)}/snapshot`).pipe(timeout(10000)));
  }

  plotLayers() { return firstValueFrom(this.http.get<PlotLayerSummary[]>('/api/plot-layers').pipe(timeout(10000))); }

  plotLayer(id: string) {
    return firstValueFrom(this.http.get<PlotLayerDetail>(`/api/plot-layers/${id}`).pipe(timeout(10000)));
  }

  importPlotLayer(input: PlotLayerImportInput) {
    return firstValueFrom(this.http.post<PlotLayerDetail>('/api/plot-layers', input).pipe(timeout(30000)));
  }

  savePlotLayer(id: string, input: PlotLayerUpdateInput) {
    return firstValueFrom(this.http.put<PlotLayerSummary>(`/api/plot-layers/${id}`, input).pipe(timeout(10000)));
  }

  setPlotLayerVisibility(id: string, cameraId: string, visible: boolean) {
    return firstValueFrom(this.http.put<PlotLayerAssociation>(`/api/plot-layers/${id}/cameras/${cameraId}`,
      { visible }).pipe(timeout(10000)));
  }

  deletePlotLayer(id: string) {
    return firstValueFrom(this.http.delete<void>(`/api/plot-layers/${id}`).pipe(timeout(10000)));
  }

  playback(cameraId: string) { return this.http.get<PlaybackSource>('/api/playback', { params: { cameraId } }).pipe(timeout(10000)); }

  saveCamera(id: string, camera: CameraInput, applyZeroPose = false) {
    const input = applyZeroPose ? { ...camera, applyZeroPose } : camera;
    const request = id
      ? this.http.put<Camera>(`/api/cameras/${id}`, input)
      : this.http.post<Camera>('/api/cameras', input);
    return firstValueFrom(request.pipe(timeout(10000)));
  }

  ptz(id: string) {
    return this.http.get<PtzReading>(`/api/cameras/${id}/ptz`).pipe(timeout(35000));
  }

  control(id: string, command: PtzCommand, speed: number, keepalive = false): Promise<unknown> {
    const url = `/api/cameras/${id}/control`;
    const body = { command, speed };
    if (keepalive) {
      return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true })
        .then(async (response) => {
          if (!response.ok) throw new Error('离开页面时停止请求失败');
          return response.json();
        });
    }
    return firstValueFrom(this.http.post(url, body).pipe(timeout(95000)));
  }

  dragZoom(id: string, direction: DragZoomDirection, box: DragZoomBox) {
    return firstValueFrom(this.http.post(
      `/api/cameras/${id}/drag-zoom`, { direction, ...box },
    ).pipe(timeout(95000)));
  }

  precise(id: string, target: PreciseTarget) {
    return firstValueFrom(this.http.post<{ target: PreciseTarget; sentAt: string }>(
      `/api/cameras/${id}/precise`, target,
    ).pipe(timeout(95000)));
  }

  snapshots(id: string) {
    return firstValueFrom(this.http.get<Snapshot[]>(`/api/cameras/${id}/snapshots`).pipe(timeout(10000)));
  }

  capture(id: string, calibration: Calibration) {
    return firstValueFrom(this.http.post<Snapshot>(`/api/cameras/${id}/snapshots`, { calibration }).pipe(timeout(95000)));
  }

  snapshotGroups(id: string, offset = 0) {
    return firstValueFrom(this.http.get<SnapshotGroupPage>(`/api/cameras/${id}/snapshot-groups`, { params: { offset } }).pipe(timeout(10000)));
  }

  snapshotTasks(offset = 0) {
    return firstValueFrom(this.http.get<SnapshotGroupPage>('/api/snapshot-tasks', { params: { offset } }).pipe(timeout(10000)));
  }

  snapshotGroup(id: string) {
    return firstValueFrom(this.http.get<SnapshotGroup>(`/api/snapshot-groups/${id}`).pipe(timeout(10000)));
  }

  groupSnapshots(id: string, offset = 0, limit = 50) {
    return firstValueFrom(this.http.get<SnapshotPage>(`/api/snapshot-groups/${id}/snapshots`, { params: { offset, limit } }).pipe(timeout(10000)));
  }

  startSnapshotScan(id: string, controlPoints: PreciseTarget[], maxPanStep: number, calibration: Calibration) {
    return firstValueFrom(this.http.post<SnapshotGroup>(`/api/cameras/${id}/snapshot-scans`,
      { controlPoints, maxPanStep, calibration }).pipe(timeout(95000)));
  }

  taskAction(id: string, action: 'pause' | 'start' | 'cancel') {
    return firstValueFrom(this.http.post<SnapshotGroup>(`/api/snapshot-tasks/${id}/${action}`, {}).pipe(timeout(95000)));
  }

  deleteSnapshot(id: string) {
    return firstValueFrom(this.http.delete<void>(`/api/snapshots/${id}`).pipe(timeout(10000)));
  }

  createRecognition(sourceTaskId: string) {
    return firstValueFrom(this.http.post<RecognitionTask>('/api/recognition-tasks', { sourceTaskId }).pipe(timeout(10000)));
  }
  recognitionTasks(offset = 0) {
    return firstValueFrom(this.http.get<RecognitionTaskPage>('/api/recognition-tasks', { params: { offset } }).pipe(timeout(10000)));
  }
  recognitionTask(id: string) {
    return firstValueFrom(this.http.get<RecognitionTask>(`/api/recognition-tasks/${id}`).pipe(timeout(10000)));
  }
  recognitionPanoramaGuide(id: string) {
    return firstValueFrom(this.http.get<PanoramaGuideState>(`/api/recognition-tasks/${id}/panorama-guide`).pipe(timeout(10000)));
  }
  savePanoramaGuide(id: string, revision: number, guide: PanoramaGuide | null) {
    return firstValueFrom(this.http.put<PanoramaGuideState>(`/api/recognition-tasks/${id}/panorama-guide`, { revision, guide }).pipe(timeout(10000)));
  }
  recognitionItems(id: string, offset = 0) {
    return firstValueFrom(this.http.get<RecognitionItemPage>(`/api/recognition-tasks/${id}/items`, {
      params: { offset, limit: 100, taskState: 'version' },
    }).pipe(timeout(10000)));
  }
  saveAnnotation(id: string, snapshotId: string, revision: number, ignored: boolean, points?: HorizonPoint[]) {
    return firstValueFrom(this.http.put<{ task: RecognitionTask; item: RecognitionItem }>(`/api/recognition-tasks/${id}/items/${snapshotId}`,
      { revision, ignored, ...(points?.length ? { points } : {}) }).pipe(timeout(10000)));
  }
  generateInstallation(id: string, revision: number, model?: ZeroPoseCandidate['model']) {
    return firstValueFrom(this.http.post<RecognitionTask>(`/api/recognition-tasks/${id}/generate`, { revision, model }).pipe(timeout(95000)));
  }
  measureZeroPose(id: string, revision: number, resultId: string, snapshotId: string) {
    return firstValueFrom(this.http.post<ZeroPoseMeasurement>(`/api/recognition-tasks/${id}/zero-pose-measure`,
      { revision, resultId, snapshotId }).pipe(timeout(10000)));
  }
  applyZeroPose(id: string, revision: number, resultId: string) {
    return firstValueFrom(this.http.post<{ task: RecognitionTask; camera: Camera }>(`/api/recognition-tasks/${id}/apply`,
      { revision, resultId, model: ZERO_POSE_MODEL }).pipe(timeout(10000)));
  }
  cancelRecognition(id: string) {
    return firstValueFrom(this.http.post<RecognitionTask>(`/api/recognition-tasks/${id}/cancel`, {}).pipe(timeout(10000)));
  }
}

export function errorMessage(error: unknown, { showLocalMessage = false } = {}): string {
  if (error instanceof HttpErrorResponse) {
    return typeof error.error?.message === 'string'
      ? error.error.message
      : error.status === 0 ? '无法连接调试服务，请检查后端是否启动' : `请求失败（HTTP ${error.status}）`;
  }
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return '请求超时，请稍后重试';
    if (showLocalMessage && error.message) return error.message;
  }
  return '操作失败，请稍后重试';
}
