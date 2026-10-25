"""Frame capture behind an interface. OpenCV for RTSP/files, FakeCapture for tests."""

from __future__ import annotations

from collections.abc import Callable, Iterator, Sequence
from typing import Protocol

import numpy as np


class Capture(Protocol):
    is_open: bool

    def open(self) -> None: ...
    def read(self) -> np.ndarray | None: ...
    def release(self) -> None: ...


class _IterMixin:
    def __iter__(self) -> Iterator[np.ndarray]:
        while (f := self.read()) is not None:  # type: ignore[attr-defined]
            yield f


class OpenCVCapture(_IterMixin):
    def __init__(self, url: str):
        self.url = url
        self.is_open = False
        self._cap = None

    def open(self) -> None:
        import cv2

        cap = cv2.VideoCapture(self.url)
        if not cap.isOpened():
            cap.release()
            raise ConnectionError(f"cannot open stream {self.url!r}")
        self._cap, self.is_open = cap, True

    def read(self) -> np.ndarray | None:
        if not self.is_open:
            raise RuntimeError("capture not open")
        ok, frame = self._cap.read()
        return frame if ok else None

    def release(self) -> None:
        if self._cap is not None:
            self._cap.release()
        self._cap, self.is_open = None, False


class FakeCapture(_IterMixin):
    def __init__(self, frames: Sequence[np.ndarray], loop: bool = False):
        self._frames = list(frames)
        self._loop = loop
        self._i = 0
        self.is_open = False

    def open(self) -> None:
        self.is_open, self._i = True, 0

    def read(self) -> np.ndarray | None:
        if not self.is_open:
            raise RuntimeError("capture not open")
        if not self._frames:
            return None
        if self._i >= len(self._frames):
            if not self._loop:
                return None
            self._i = 0
        f = self._frames[self._i]
        self._i += 1
        return f.copy()

    def release(self) -> None:
        self.is_open = False


def open_capture(url: str, factory: Callable[[str], Capture] | None = None) -> Capture:
    return (factory or OpenCVCapture)(url)
