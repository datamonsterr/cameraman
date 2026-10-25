import numpy as np

from cameraman_worker.appearance import hsv_histogram, similarity


def patch(color, noise=0):
    img = np.full((100, 100, 3), 40, np.uint8)
    img[20:60, 20:60] = color
    if noise:
        rng = np.random.default_rng(0)
        img = np.clip(img.astype(int) + rng.integers(-noise, noise, img.shape), 0, 255).astype(
            np.uint8
        )
    return img


BOX = (0.2, 0.2, 0.4, 0.4)


def test_same_patch_high():
    a = hsv_histogram(patch((0, 0, 255)), BOX)
    b = hsv_histogram(patch((0, 0, 255), noise=5), BOX)
    assert similarity(a, b) > 0.9
    assert similarity(a, a) > 0.99


def test_different_patch_low():
    a = hsv_histogram(patch((0, 0, 255)), BOX)
    b = hsv_histogram(patch((255, 0, 0)), BOX)
    assert similarity(a, b) < 0.3


def test_empty_box_and_missing():
    img = patch((0, 0, 255))
    assert hsv_histogram(img, (2.0, 2.0, 0.1, 0.1)) is None
    assert similarity(None, hsv_histogram(img, BOX)) == 0.0
