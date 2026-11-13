import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CameraStore } from './store.mjs';
import { readImageInfo } from './image.mjs';
import { calibrationRange, estimatePAxisTilt, panCoverage } from './tilt-calibration.mjs';
import { httpError } from './errors.mjs';

const instructions = `这是截图标定 MCP，所有工具只读，不移动摄像头，不修改数据库。
先用 list_cameras 确定摄像头，再确认用户要分析的时间段；不明确时向用户确认。
时间段使用带时区的 ISO 时间，按记录 createdAt 筛选，包含开始时刻、不包含结束时刻。
用 query_snapshots 查看原始 PTZ、视场角和采样状态，再用 get_snapshot 读取原图。
图片通过 get_snapshot 的 MCP image 内容块返回，直接查看图片内容，不要求调用方访问服务端文件或 imageUrl。
只标注真实可见的远处海天线；不要将岸线、船体、养殖网、近处波浪或文字当作海天线。
海天线不可见、遮挡或无法确认时跳过该图，不编造标注。
每张图给出至少两个海天线点，覆盖尽可能宽的画面；x/y 为原图宽高归一化到 0～1 的坐标，原点在左上角。
选择停稳且海天线可确认的截图，poseChanged 的截图不用于拟合；按实际收敛、可辨识性及残差判断结果是否可靠。
estimate_p_axis_tilt 从数据库读取原始 PTZ 和 FOV，调用者只提供截图 ID 和海天线点。
返回 estimated 才有可复核的安装参数；unreliable 或 insufficient_data 不得宣称标定完成。
返回的前后倾和左右倾与现有页面字段一致。经纬度、高度、P/T 偏移和画面 Roll 修正使用当前保存值；本工具只拟合 P 轴两个倾角，不估计 T 偏移或画面 Roll，不能由海天线推断绝对朝向或高度。
向用户展示样本、误差、假设及同步限制，再由用户在页面复核和保存；不得声称已自动应用结果。`;

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const rangeShape = {
  cameraId: z.string().min(1).describe('list_cameras 返回的本地摄像头 ID'),
  startTime: z.string().datetime({ offset: true }).describe('开始时刻，包含；例如 2026-11-09T11:00:00+08:00'),
  endTime: z.string().datetime({ offset: true }).describe('结束时刻，不包含；必须明确时区'),
};

function dataResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

function safely(action) {
  return async (args) => {
    try { return await action(args); } catch (error) {
      const message = error.statusCode ? error.message
        : error.code === 'ENOENT' ? '截图文件不存在'
          : '读取截图或计算失败，请检查 MCP 进程日志';
      if (!error.statusCode && error.code !== 'ENOENT') console.error('截图标定 MCP 操作失败', error);
      return { isError: true, content: [{ type: 'text', text: message }] };
    }
  };
}

export function createCalibrationMcp(dataDir) {
  const store = new CameraStore(dataDir, { readOnly: true });
  const server = new McpServer({ name: 'cctv-tilt-calibration', version: '0.1.0' }, { instructions });
  let closed = false;
  server.server.onclose = () => {
    if (!closed) { closed = true; store.close(); }
  };

  server.registerTool('list_cameras', {
    description: '列出摄像头、当前安装参数、截图数量及可用截图时间范围。用于先确定分析哪个摄像头和时间段。',
    inputSchema: z.object({}).strict(), annotations,
  }, safely(async () => dataResult({ cameras: store.listCameraSummaries() })));

  server.registerTool('query_snapshots', {
    description: '按摄像头和带时区的时间段查询截图记录。包含起始、不包含结束，按时间正序分页，不返回图片；用 get_snapshot 读取原图。',
    inputSchema: z.object({ ...rangeShape,
      groupId: z.string().min(1).optional().describe('可选：自动截图任务的分组 ID，只查询本次调用生成的截图'),
      limit: z.number().int().min(1).max(100).default(50),
      offset: z.number().int().min(0).default(0),
    }).strict(), annotations,
  }, safely(async ({ cameraId, startTime, endTime, groupId, limit, offset }) => {
    const range = calibrationRange(startTime, endTime);
    const page = store.querySnapshots(cameraId, { ...range, groupId, limit, offset });
    const stable = page.snapshots.filter((snapshot) => !snapshot.poseChanged && Number.isFinite(snapshot.ptz?.raw?.Pan));
    return dataResult({
      cameraId, ...range, timeField: 'createdAt', endExclusive: true, total: page.total,
      offset, nextOffset: offset + page.snapshots.length < page.total ? offset + page.snapshots.length : null,
      pageSampling: { stableSnapshotCount: stable.length, ...panCoverage(stable.map((snapshot) => snapshot.ptz.raw.Pan)) },
      snapshots: page.snapshots.map((snapshot) => ({
        id: snapshot.id, cameraId: snapshot.cameraId, cameraName: snapshot.cameraName,
        groupId: snapshot.groupId ?? snapshot.id, scanIndex: snapshot.scanIndex,
        serial: snapshot.serial, code: snapshot.code, createdAt: snapshot.createdAt,
        width: snapshot.width, height: snapshot.height, ptz: snapshot.ptz, ptzAfter: snapshot.ptzAfter,
        poseChanged: snapshot.poseChanged, usesDraft: snapshot.usesDraft, timeAlignment: snapshot.timeAlignment,
      })),
    });
  }));

  server.registerTool('get_snapshot', {
    description: '返回一张原始截图的 MCP 图片内容及其 PTZ/FOV/时间和安装参数。识别远处海天线，坐标按原图宽高归一化为 0～1。',
    inputSchema: z.object({ snapshotId: z.string().min(1) }).strict(), annotations,
  }, safely(async ({ snapshotId }) => {
    const snapshot = store.getSnapshot(snapshotId);
    const bytes = await readFile(join(dataDir, 'snapshots', snapshot.fileName));
    const info = readImageInfo(bytes);
    if (info.width !== snapshot.width || info.height !== snapshot.height) {
      throw httpError(409, '截图文件尺寸与采样记录不一致，不能用于海天线标注');
    }
    const result = dataResult({ ...snapshot,
      annotationCoordinates: { origin: 'top-left', x: 'pixelX / width', y: 'pixelY / height', range: [0, 1] },
    });
    result.content.push({ type: 'image', data: bytes.toString('base64'), mimeType: info.contentType });
    return result;
  }));

  server.registerTool('estimate_p_axis_tilt', {
    description: '用指定停稳截图的海天线归一化标注和数据库中的采样 PTZ/FOV 拟合 P 轴前后倾、左右倾。固定采用当前保存的经纬度、高度、P/T 偏移及画面 Roll 修正，不拟合这些固定项。按实际收敛、可辨识性及残差判断质量。只生成结果，不修改配置；返回 estimated/unreliable/insufficient_data。',
    inputSchema: z.object({ ...rangeShape,
      observations: z.array(z.object({
        snapshotId: z.string().min(1),
        points: z.array(z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict()).min(2).max(20),
      }).strict()).min(1).max(100),
    }).strict(), annotations,
  }, safely(async ({ cameraId, startTime, endTime, observations }) => {
    const range = calibrationRange(startTime, endTime);
    const camera = store.getCamera(cameraId);
    const snapshots = observations.map((observation) => store.getSnapshot(observation.snapshotId));
    return dataResult(estimatePAxisTilt(camera, snapshots, observations, range));
  }));
  return server;
}
