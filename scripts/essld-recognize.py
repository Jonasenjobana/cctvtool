"""读取后端传入的本地截图清单，逐图输出 JSONL；不访问摄像头或修改数据库。"""

import argparse
import json
import sys

from essld_model import EssldDetector


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream", required=True)
    args = parser.parse_args()
    snapshots = json.load(sys.stdin)
    detector = EssldDetector(args.upstream)
    for snapshot in snapshots:
        try:
            result, _, _ = detector.detect(snapshot["path"], snapshot["width"], snapshot["height"])
        except Exception as error:
            result = {"points": [], "error": f"{type(error).__name__}: {error}"}
        print(json.dumps({"snapshotId": snapshot["snapshotId"], **result}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
