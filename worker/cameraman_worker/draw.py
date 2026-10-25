"""Draw API: record JSON-serializable ops, render them onto a copy of a frame."""

from __future__ import annotations

import base64
from collections.abc import Sequence

import cv2
import numpy as np

DEFAULT_MAX_OPS = 500


class DrawRecorder:
    """Injected as `draw` in Code Blocks. Coordinates are normalized (0..1); colors BGR."""

    def __init__(self, max_ops: int = DEFAULT_MAX_OPS):
        self.ops: list[dict] = []
        self.max_ops = max_ops

    def _add(self, op: dict) -> None:
        if len(self.ops) < self.max_ops:
            self.ops.append(op)

    def box(self, box, color=(0, 255, 0), label: str | None = None, thickness: int = 2) -> None:
        self._add(
            {
                "op": "box",
                "box": [float(v) for v in box],
                "color": list(color),
                "label": label,
                "thickness": int(thickness),
            }
        )

    def label(self, box, text: str, color=(0, 255, 0)) -> None:
        self._add(
            {"op": "label", "box": [float(v) for v in box], "text": str(text), "color": list(color)}
        )

    def text(self, text: str, pos=(0.02, 0.05), color=(255, 255, 255), scale: float = 0.6) -> None:
        self._add(
            {
                "op": "text",
                "text": str(text),
                "pos": [float(v) for v in pos],
                "color": list(color),
                "scale": float(scale),
            }
        )

    def polygon(
        self, points, color=(255, 200, 0), label: str | None = None, thickness: int = 2
    ) -> None:
        pts = (
            [float(v) for v in points]
            if _is_flat_box(points)
            else [[float(a), float(b)] for a, b in points]
        )
        self._add(
            {
                "op": "polygon",
                "points": pts,
                "color": list(color),
                "label": label,
                "thickness": int(thickness),
            }
        )

    def mask(self, mask, color=(0, 0, 255), alpha: float = 0.4) -> None:
        m = np.asarray(mask).astype(bool)
        self._add(
            {
                "op": "mask",
                "shape": list(m.shape),
                "data": base64.b64encode(np.packbits(m).tobytes()).decode(),
                "color": list(color),
                "alpha": float(alpha),
            }
        )


def _is_flat_box(points) -> bool:
    return len(points) == 4 and all(np.isscalar(v) for v in points)


def _px(p: Sequence[float], w: int, h: int) -> tuple[int, int]:
    return (int(round(p[0] * w)), int(round(p[1] * h)))


def _color(c) -> tuple[int, int, int]:
    return tuple(int(v) for v in c[:3])  # type: ignore[return-value]


def _put_text(img, text, org, color, scale=0.5):
    cv2.putText(img, text, org, cv2.FONT_HERSHEY_SIMPLEX, scale, color, 1, cv2.LINE_AA)


def render(frame: np.ndarray, ops: list[dict]) -> np.ndarray:
    """Return an annotated copy of `frame`."""
    out = frame.copy()
    h, w = out.shape[:2]
    for op in ops:
        kind = op["op"]
        if kind in ("box", "label"):
            x, y, bw, bh = op["box"]
            p1, p2 = _px((x, y), w, h), _px((x + bw, y + bh), w, h)
            c = _color(op["color"])
            if kind == "box":
                cv2.rectangle(out, p1, p2, c, op.get("thickness", 2))
            text = op.get("label") if kind == "box" else op["text"]
            if text:
                _put_text(out, text, (p1[0], max(p1[1] - 4, 10)), c)
        elif kind == "text":
            _put_text(out, op["text"], _px(op["pos"], w, h), _color(op["color"]), op["scale"])
        elif kind == "polygon":
            pts = op["points"]
            if pts and not isinstance(pts[0], list):
                x, y, bw, bh = pts
                pts = [[x, y], [x + bw, y], [x + bw, y + bh], [x, y + bh]]
            arr = np.array([_px(p, w, h) for p in pts], dtype=np.int32)
            c = _color(op["color"])
            cv2.polylines(out, [arr], True, c, op.get("thickness", 2))
            if op.get("label") and len(arr):
                _put_text(out, op["label"], (int(arr[0][0]), max(int(arr[0][1]) - 4, 10)), c)
        elif kind == "mask":
            mh, mw = op["shape"]
            bits = np.unpackbits(np.frombuffer(base64.b64decode(op["data"]), dtype=np.uint8))
            m = bits[: mh * mw].reshape(mh, mw).astype(np.uint8)
            if (mh, mw) != (h, w):
                m = cv2.resize(m, (w, h), interpolation=cv2.INTER_NEAREST)
            sel = m.astype(bool)
            a = op["alpha"]
            col = np.array(_color(op["color"]), dtype=np.float32)
            out[sel] = (out[sel] * (1 - a) + col * a).astype(np.uint8)
    return out
