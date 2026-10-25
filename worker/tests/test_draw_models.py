import numpy as np
import pytest

from cameraman_worker import models
from cameraman_worker.draw import DrawRecorder, render
from cameraman_worker.models import Detection, FakeModel, get_model, register_model


def blank(h=100, w=200):
    return np.zeros((h, w, 3), dtype=np.uint8)


def test_box_changes_pixels_only_around_region():
    f = blank()
    rec = DrawRecorder()
    rec.box((0.25, 0.25, 0.5, 0.5), color=(0, 255, 0), label="person")
    out = render(f, rec.ops)
    assert out is not f and not f.any()  # original untouched
    # left edge of the box at x=50, y mid
    assert tuple(out[50, 50]) == (0, 255, 0)
    assert not out[50, 100].any()  # interior stays empty
    assert not out[95, 5].any()  # far corner untouched


def test_text_polygon_mask_label():
    f = blank()
    rec = DrawRecorder()
    rec.text("hello", (0.1, 0.5), color=(255, 255, 255))
    rec.polygon([(0.6, 0.1), (0.9, 0.1), (0.9, 0.4)], color=(255, 0, 0))
    rec.polygon((0.0, 0.7, 0.2, 0.2), color=(0, 0, 255))  # box form, as in the example
    m = np.zeros((100, 200), dtype=bool)
    m[10:20, 10:20] = True
    rec.mask(m, color=(0, 255, 255), alpha=1.0)
    rec.label((0.5, 0.5, 0.2, 0.2), "tag")
    out = render(f, rec.ops)
    assert out[40:60, 20:60].any()
    assert out[5:45, 120:185].any()
    assert out[70:90, 0:41].any()
    assert tuple(out[15, 15]) == (0, 255, 255)
    assert out[45:55, 100:140].any()


def test_ops_json_roundtrip():
    import json

    rec = DrawRecorder()
    rec.box((0.1, 0.1, 0.2, 0.2), label="x")
    m = np.zeros((10, 20), dtype=bool)
    m[2:4, 2:4] = True
    rec.mask(m)
    ops = json.loads(json.dumps(rec.ops))
    assert render(blank(), ops).any()


def test_op_cap():
    rec = DrawRecorder(max_ops=3)
    for _ in range(10):
        rec.box((0, 0, 0.1, 0.1))
    assert len(rec.ops) == 3


def test_fake_model_filters_conf_and_classes():
    m = FakeModel(
        [
            {"label": "person", "confidence": 0.9, "box": (0.1, 0.2, 0.3, 0.4), "cls": 0},
            {"label": "person", "confidence": 0.2, "box": (0.5, 0.5, 0.1, 0.1), "cls": 0},
            {"label": "dog", "confidence": 0.9, "box": (0.6, 0.6, 0.1, 0.1), "cls": 16},
        ]
    )
    dets = list(m(blank(100, 200), conf=0.4, classes=[0]))
    assert len(dets) == 1
    d = dets[0]
    assert isinstance(d, Detection)
    assert d.label == "person" and d.box == (0.1, 0.2, 0.3, 0.4)
    assert d.xyxy == (20, 20, 80, 60)


def test_get_model_cached_and_injectable(monkeypatch):
    models.clear_cache()
    calls = []

    def factory(name):
        calls.append(name)
        return FakeModel([])

    register_model(factory)
    a, b = get_model("yolov8n"), get_model("yolov8n")
    assert a is b and calls == ["yolov8n"]
    models.clear_cache()


def test_get_model_env_fake(monkeypatch):
    models.clear_cache()
    register_model(None)
    monkeypatch.setenv("WORKER_FAKE_MODEL", "1")
    assert isinstance(get_model("yolov8n"), FakeModel)
    models.clear_cache()


def test_real_path_lazily_imports_ultralytics(monkeypatch):
    import sys
    import types

    models.clear_cache()
    register_model(None)
    monkeypatch.delenv("WORKER_FAKE_MODEL", raising=False)

    class FakeYOLO:
        def __init__(self, name):
            self.name = name
            self.names = {0: "person"}

        def __call__(self, frame, conf=0.25, classes=None, verbose=False):
            box = types.SimpleNamespace(
                xyxy=[types.SimpleNamespace(tolist=lambda: [20, 20, 80, 60])],
                conf=[0.8],
                cls=[0],
            )
            return [types.SimpleNamespace(boxes=[box])]

    mod = types.ModuleType("ultralytics")
    mod.YOLO = FakeYOLO
    monkeypatch.setitem(sys.modules, "ultralytics", mod)
    m = get_model("yolov8n")
    dets = list(m(blank(100, 200), conf=0.4, classes=[0]))
    assert dets[0].label == "person"
    assert dets[0].box == pytest.approx((0.1, 0.2, 0.3, 0.4))
    models.clear_cache()


def test_get_model_without_ultralytics_gives_clear_error(monkeypatch):
    import sys

    models.clear_cache()
    register_model(None)
    monkeypatch.delenv("WORKER_FAKE_MODEL", raising=False)
    monkeypatch.setitem(sys.modules, "ultralytics", None)
    with pytest.raises(RuntimeError, match="ultralytics"):
        get_model("yolov8n")
    models.clear_cache()
