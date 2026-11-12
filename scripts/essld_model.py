"""离线评测与后端任务共用的 ESSLD 原版推理流程。"""

import math
from pathlib import Path
import sys
import time

import cv2
import numpy as np
import torch


def line_parameters(result, width, height):
    if result is None:
        return None
    center_y, angle = map(float, result)
    slope = math.tan(math.radians(angle))
    intercept = center_y - slope * width / 2
    if not all(math.isfinite(value) for value in (center_y, angle, slope, intercept)):
        raise ValueError("模型返回了非有限直线参数")
    return {
        "centerY": center_y, "angleDeg": angle, "slope": slope, "intercept": intercept,
        "points": [{"x": x, "y": (slope * x * width + intercept) / height} for x in (0.1, 0.9)],
    }


class EssldDetector:
    def __init__(self, upstream):
        sys.path.insert(0, str(Path(upstream).resolve()))
        import config
        from models.dceunet import DCEUNet
        from utils.processing import get_coarse_line_from_mask, refine_horizon_stage3

        torch.set_num_threads(4)
        cv2.setNumThreads(1)
        torch.manual_seed(0)
        self.config = config
        self.coarse = get_coarse_line_from_mask
        self.refine = refine_horizon_stage3
        self.model = DCEUNet(input_channels=3, num_classes=1)
        self.model.load_state_dict(torch.load(Path(upstream) / config.MODEL_PATH, map_location="cpu", weights_only=True), strict=True)
        self.model.eval()

    def detect(self, source, width, height):
        started = time.perf_counter()
        image = cv2.imdecode(np.fromfile(source, dtype=np.uint8), cv2.IMREAD_COLOR)
        if image is None or image.shape[:2] != (height, width):
            raise ValueError("截图无法解码或尺寸与记录不一致")
        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        resized = cv2.resize(rgb, (self.config.IMAGE_WIDTH, self.config.IMAGE_HEIGHT))
        tensor = torch.from_numpy(resized.transpose(2, 0, 1)).float().unsqueeze(0) / 255.0
        with torch.inference_mode():
            probability = torch.sigmoid(self.model(tensor)).squeeze().numpy()
        mask = (cv2.resize(probability, (width, height)) > 0.5).astype(np.uint8) * 255
        coarse = self.coarse(mask, image)
        final = coarse
        status = "no_candidate" if coarse is None else "coarse_fallback"
        warnings = []
        if coarse is not None:
            try:
                refined = self.refine(image, *coarse)
                if refined is not None:
                    final, status = refined, "refined"
            except Exception as error:
                warnings.append(f"精修失败，回退粗线：{type(error).__name__}: {error}")
        line = line_parameters(final, width, height)
        points = line["points"] if line and all(0 <= point["y"] <= 1 for point in line["points"]) else []
        result = {
            "coarseLine": line_parameters(coarse, width, height), "finalLine": line,
            "points": points, "refinementStatus": status, "warnings": warnings,
            "elapsedMs": (time.perf_counter() - started) * 1000,
        }
        return result, image, mask
