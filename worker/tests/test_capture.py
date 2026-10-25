import numpy as np
import pytest

from cameraman_worker.capture import FakeCapture, OpenCVCapture, open_capture


def test_fake_capture_yields_frames_then_ends():
    frames = [np.full((4, 4, 3), i, dtype=np.uint8) for i in range(3)]
    cap = FakeCapture(frames)
    cap.open()
    got = []
    while (f := cap.read()) is not None:
        got.append(int(f[0, 0, 0]))
    assert got == [0, 1, 2]
    cap.release()
    assert not cap.is_open


def test_fake_capture_loop_and_iter():
    cap = FakeCapture([np.zeros((2, 2, 3), np.uint8)], loop=True)
    cap.open()
    it = iter(cap)
    assert next(it) is not None and next(it) is not None


def test_read_before_open_raises():
    with pytest.raises(RuntimeError):
        FakeCapture([]).read()


def test_open_capture_factory_and_opencv_failure():
    assert isinstance(open_capture("rtsp://x/y", factory=lambda url: FakeCapture([])), FakeCapture)
    cap = OpenCVCapture("/nonexistent/video.mp4")
    with pytest.raises(ConnectionError):
        cap.open()


def test_opencv_capture_reads_file(tmp_path):
    import cv2

    p = str(tmp_path / "v.avi")
    w = cv2.VideoWriter(p, cv2.VideoWriter_fourcc(*"MJPG"), 5, (32, 32))
    for _ in range(3):
        w.write(np.zeros((32, 32, 3), np.uint8))
    w.release()
    cap = OpenCVCapture(p)
    cap.open()
    assert cap.read().shape == (32, 32, 3)
    cap.release()
