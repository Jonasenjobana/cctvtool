"""只读本地截图，用 ESSLD 原版流程生成离线复核图片。"""

import argparse
from datetime import datetime
import hashlib
import html
import importlib.metadata
import json
import math
from pathlib import Path
import sqlite3
import subprocess
import sys
import time

import cv2
import numpy as np
from essld_model import EssldDetector


ROOT = Path(__file__).resolve().parents[1]


def save_image(path, image):
    success, encoded = cv2.imencode(path.suffix, image)
    if not success:
        raise OSError(f"无法编码图片：{path}")
    encoded.tofile(path)


def draw_line(image, line, color, dashed=False):
    if line is None:
        return
    width = image.shape[1]
    step = 16 if dashed else width
    for start in range(0, width, step):
        end = min(start + (8 if dashed else width), width - 1)
        y1 = round(line["slope"] * start + line["intercept"])
        y2 = round(line["slope"] * end + line["intercept"])
        cv2.line(image, (start, y1), (end, y2), color, 2, cv2.LINE_AA)


def write_gallery(output, report, thumbnails):
    cards = []
    for index, record in enumerate(report["results"], 1):
        ptz = record.get("ptz", {}).get("raw", {})
        label = f'{index:02d} / P={ptz.get("Pan")} T={ptz.get("Tilt")} Z={ptz.get("Zoom")}'
        line = record.get("finalLine")
        detail = (
            f'中心高度 {line["centerY"]:.2f}px，图像倾角 {line["angleDeg"]:.4f}°'
            if line else "未得到候选线"
        )
        pictures = "".join(
            f'<figure><a href="{record[key]}"><img loading="lazy" src="{record[key]}" alt="{title}"></a>'
            f'<figcaption>{title}（点击查看原尺寸）</figcaption></figure>'
            for key, title in (("original", "原图"), ("overlay", "原图叠线"), ("mask", "分割掩膜"))
            if key in record
        )
        warnings = "；".join(record.get("warnings", []))
        cards.append(
            f'<article id="sample-{index}"><h2>{html.escape(label)}</h2>'
            f'<p>{html.escape(record["snapshotId"])} / {html.escape(record["createdAt"])} / '
            f'{record["width"]}×{record["height"]}</p>'
            f'<p>{html.escape(record["status"])} / {html.escape(detail)} / '
            f'{record.get("elapsedMs", 0):.0f}ms</p><p>{html.escape(warnings)}</p>'
            f'<div class="images">{pictures}</div></article>'
        )
    page = """<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ESSLD 本地截图复核</title><style>
body{font:16px/1.6 system-ui,sans-serif;max-width:1800px;margin:24px auto;padding:0 20px;color:#222}
article{border-top:1px solid #bbb;margin-top:30px;padding-top:12px}h2{font-size:19px}p{overflow-wrap:anywhere}
.images{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}figure{margin:0}
img{display:block;width:100%;height:auto}figcaption{font-size:14px;color:#555}
@media(max-width:800px){.images{grid-template-columns:1fr}}
</style><h1>ESSLD 本地截图复核</h1>
<p>红色实线：最终候选线；黄色虚线：分割得到的粗线。掩膜白色表示模型的前景输出。</p>
<p>detected 只表示原版算法返回了候选线，不代表识别正确或可用于标定。
未添加岸线、船体、文字或低能见度拒识规则。无海天线图片上的任何候选线均属于误报。</p>
<p>倾角是图像坐标中的直线倾角，y 向下为正，不是 P 轴倾斜。
本次只读截图和数据库，不调用 MCP、PTZ 拟合或摄像头接口。</p>
<p>当前没有人工真值标注，未计算海天线像素误差、斜率误差或准确率。</p>
<p><a href="results.json">完整参数与来源 JSON</a> · <a href="contact-sheet.jpg">全部叠线缩略图</a></p>
""" + "\n".join(cards) + "</html>"
    (output / "review.html").write_text(page, encoding="utf-8")
    if thumbnails:
        columns = 3
        tile_h, tile_w = thumbnails[0].shape[:2]
        sheet = np.full((math.ceil(len(thumbnails) / columns) * tile_h, columns * tile_w, 3), 245, np.uint8)
        for index, thumbnail in enumerate(thumbnails):
            x, y = index % columns * tile_w, index // columns * tile_h
            sheet[y:y + tile_h, x:x + tile_w] = thumbnail
        save_image(output / "contact-sheet.jpg", sheet)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    parser.add_argument("--upstream", type=Path, default=ROOT / "data/essld/upstream")
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--camera-id")
    parser.add_argument("--zoom", type=float)
    args = parser.parse_args()
    output = args.output_dir or ROOT / "data/essld/runs" / datetime.now().strftime("%Y%m%d-%H%M%S")
    output = output.resolve()
    # 每轮独立保存，避免复核页混入上轮结果或覆盖已有文件。
    output.mkdir(parents=True, exist_ok=False)
    images = output / "images"
    images.mkdir()

    detector = EssldDetector(args.upstream)
    config = detector.config
    weights = args.upstream / config.MODEL_PATH

    database = args.data_dir.resolve() / "cctv.sqlite"
    with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as connection:
        rows = connection.execute("SELECT id, fileName, metadata FROM snapshots ORDER BY createdAt, id").fetchall()
    report = {
        "model": "ESSLD / DCEUNet",
        "upstream": "https://github.com/kaibaJC/ESSLD",
        "commit": subprocess.check_output(["git", "-C", str(args.upstream), "rev-parse", "HEAD"], text=True).strip(),
        "weightsSha256": hashlib.sha256(weights.read_bytes()).hexdigest(),
        "python": sys.version,
        "packages": {name: importlib.metadata.version(name) for name in (
            "torch", "numpy", "opencv-python", "numba", "mmcv-lite"
        )},
        "device": "cpu",
        "threads": 4,
        "inputSize": {"width": config.IMAGE_WIDTH, "height": config.IMAGE_HEIGHT},
        "refinementConfig": {key: getattr(config, key) for key in dir(config) if key.isupper() and key not in (
            "DEVICE", "MODEL_PATH", "IMAGE_WIDTH", "IMAGE_HEIGHT"
        )},
        "sourceDatabase": str(database),
        "filters": {"cameraId": args.camera_id, "zoom": args.zoom},
        "note": "原版默认参数；detected 为未复核候选。归一化坐标除以原图宽高；未进行 PTZ 拟合。",
        "results": [],
    }
    thumbnails = []
    errors = []
    for snapshot_id, filename, metadata in rows:
        snapshot = json.loads(metadata)
        ptz = snapshot.get("ptz", {}).get("raw", {})
        if args.camera_id and snapshot.get("cameraId") != args.camera_id:
            continue
        if args.zoom is not None and ptz.get("Zoom") != args.zoom:
            continue
        record = {key: snapshot.get(key) for key in (
            "cameraId", "cameraName", "groupId", "createdAt", "width", "height", "ptz", "poseChanged"
        )}
        record.update(snapshotId=snapshot_id, sourceFile=filename, warnings=[], status="error")
        started = time.perf_counter()
        try:
            source = (args.data_dir / "snapshots" / filename).resolve()
            result, image, mask = detector.detect(source, record["width"], record["height"])
            height, width = image.shape[:2]
            record.update({key: value for key, value in result.items() if key not in ("points", "elapsedMs")})
            record["foregroundFraction"] = float(np.count_nonzero(mask) / mask.size)
            record["status"] = "no_detection" if result["finalLine"] is None else "detected"
            record["normalizedPoints"] = []
            if result["finalLine"] is not None:
                points = record["finalLine"]["points"]
                if all(0 <= point["y"] <= 1 for point in points):
                    record["normalizedPoints"] = points
                else:
                    record["status"] = "out_of_frame"
                    record["warnings"].append("候选线在 x=0.1/0.9 处超出画面，未导出归一化点位")
            overlay = image.copy()
            draw_line(overlay, record["coarseLine"], (0, 220, 255), dashed=True)
            draw_line(overlay, record["finalLine"], (0, 0, 255))
            prefix = f"{len(report['results']) + 1:02d}_{snapshot_id}"
            original_path = images / f"{prefix}_original{source.suffix}"
            original_path.write_bytes(source.read_bytes())
            record["original"] = original_path.relative_to(output).as_posix()
            for key, picture in (("overlay", overlay), ("mask", mask)):
                image_path = images / f"{prefix}_{key}.png"
                save_image(image_path, picture)
                record[key] = image_path.relative_to(output).as_posix()
            thumbnail = cv2.resize(overlay, (480, 270))
            label = np.full((46, 480, 3), 245, dtype=np.uint8)
            cv2.putText(label, f"{len(report['results']) + 1:02d} P={ptz.get('Pan')} Z={ptz.get('Zoom')}",
                        (8, 19), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (20, 20, 20), 1, cv2.LINE_AA)
            cv2.putText(label, record["status"], (8, 39), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (20, 20, 20), 1, cv2.LINE_AA)
            thumbnails.append(np.vstack((label, thumbnail)))
        except Exception as error:
            message = f"{snapshot_id}: {type(error).__name__}: {error}"
            record["warnings"].append(message)
            errors.append(message)
            print(message, file=sys.stderr, flush=True)
        record["elapsedMs"] = (time.perf_counter() - started) * 1000
        report["results"].append(record)
        print(f"{len(report['results']):02d} {snapshot_id} Z={ptz.get('Zoom')} {record['status']} {record['elapsedMs']:.0f}ms", flush=True)

    if not report["results"]:
        raise ValueError("没有符合筛选条件的截图")
    report["counts"] = {status: sum(record["status"] == status for record in report["results"])
                        for status in ("detected", "no_detection", "out_of_frame", "error")}
    (output / "results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    write_gallery(output, report, thumbnails)
    print(f"复核页面：{output / 'review.html'}", flush=True)
    print(json.dumps(report["counts"], ensure_ascii=False), flush=True)
    if errors:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
