# Cameraman worker (detection core)

Python 3.12, managed with `uv`. Boundaries (RTSP, YOLO) are mockable; tests need no camera, GPU or weights.

```
uv sync                 # core deps
uv sync --extra ml      # + torch, ultralytics (real inference only)
uv run pytest -q
uv run ruff check .
```

Env: `NODE_TYPES_PATH` (registry json, e.g. `../db/seed/node_types.json`), `WORKER_FAKE_MODEL=1`
(empty FakeModel), `CODEBLOCK_CPU_SECONDS` (10), `CODEBLOCK_MEM_MB` (2048), `CODEBLOCK_WALL_SECONDS` (15).

## Modules
- `registry.py` load node types; `graph.py` `validate_graph(graph, registry)` (FR-8: unknown type,
  missing/bad config, dangling inputs, bad edges, port type mismatch, cycles, duplicate ids).
- `engine.py` `GraphEngine(graph, registry, sandbox=, fake_detections=, camera_name=).run_frame(frame, now=)`
  returns `FrameResult(frame, actions, emits, errors, logs, draw_ops)`. It never sends email: `notify`
  becomes `{"type":"email","node_id","to","subject","body",...}` (templated `{{var}}`, per-node
  `cooldown_secs`), or `{"type":"notify","to":None,...}` if no Email node is wired.
- `sandbox.py` + `_child.py` subprocess per run; rlimits (CPU, address space, file size), wall timeout,
  output cap, network blocked, scratch cwd. Failures are `SandboxResult.error` with `kind` in
  `exception | memory | timeout | cpu_limit | output_too_large | crash`; state is unchanged on failure.
- `draw.py` `DrawRecorder` + `render(frame, ops)` (draws on a copy). `models.py` `get_model`, `FakeModel`,
  `register_model(factory)`. `landmarks.py` `decide`, `LandmarkTracker`. `capture.py` `OpenCVCapture`, `FakeCapture`.

## Code Block API (all injected globals)
Boxes are normalized `(x, y, w, h)`; colors BGR; values passed out must be JSON-serializable
(numpy scalars/arrays are converted); `state` must be JSON-serializable.

| name | notes |
|---|---|
| `frame` | numpy BGR array (a copy) |
| `np`, `cv2`, `torch`, `ultralytics` | torch/ultralytics lazy-imported on first use |
| `get_model(name)` | cached; `model(frame, conf=, classes=)` -> iterable of `Detection(.box, .confidence, .label, .xyxy, .cls)` |
| `draw.box(box, color=, label=None, thickness=2)` | |
| `draw.label(box, text, color=)` / `draw.text(text, pos=(x,y), color=, scale=)` | |
| `draw.polygon(points_or_box, color=, label=None, thickness=2)` | list of (x,y) or an (x,y,w,h) box |
| `draw.mask(mask, color=, alpha=0.4)` | bool HxW array |
| `notify(subject, body, to=None)` | `to` str or list; None = Email node recipients |
| `emit(key, value)` | structured output, also template vars for Email nodes |
| `landmark.get(name)` | box list or None; `.calibrate(name, box)`; `.contains(name, box, min_overlap=0.3)` |
| `state` | dict persisted per node across frames |
| `camera` | `.id`, `.name` |
| `config` | node config dict |
| `now()`, `ts()`, `log(*args)` | `now()` fixed per run (epoch s); `ts()` ISO-8601 UTC; `print` also goes to logs |

## Landmark auto-calibration
`decide(landmark_box, candidate_box, similarity, drift_threshold=0.02, similarity_threshold=0.7, alpha=0.5)`
-> `none | recalibrate | object_moved`. Drift = max(center distance, |dw|, |dh|). Recalibrate only when
drift > threshold AND similarity >= threshold (EMA-smoothed). Low similarity with drift flags `object_moved`
and leaves the box. `landmark.contains` = intersection / smaller-box area >= `min_overlap`.
Producing candidate boxes and similarity scores (appearance embedding) is the caller's job; feed them to
`engine.landmarks[name].update(box, similarity, ts)`.

## Runtime (`python -m cameraman_worker`)
Implements `docs/runtime-protocol.md`. Env: `REDIS_URL`, `BACKEND_URL`, `WORKER_TOKEN`, `NODE_TYPES_PATH`,
`MODEL_CACHE_DIR` (yolov8n.pt auto-downloads here), `LANDMARK_MODEL` (default `yolov8n`).
- `bus.py` `RedisBus`/`FakeBus` (BRPOP `cameraman:runs:control`, HGETALL `cameraman:runs:desired`, PUBLISH
  `cameraman:camera:<id>:frames`, SET `...:latest` TTL 30s, worker heartbeat). `ingest.py` `HttpIngest`/`FakeIngest`
  (`X-Worker-Token`; `post_event`, `post_notification`, `post_calibration`, `post_health`).
- `runtime.py` `Supervisor`: boot resync, `start`/`update` rebuild a run (keyed by `run_id`), `stop` tears down
  (unknown id = no-op). Per camera at the camera node's fps: read, auto-calibrate, `GraphEngine.run_frame`, publish
  JPEG (<=5 fps, <=100 kB), post actions (`email`/`notify` with recipients -> notification; any action -> `detection`
  event). Capture failure -> health `offline` + exponential backoff (1..30s); code-block errors -> `system` warn
  event (rate-limited), never fatal. Ingest/Redis errors are logged, never crash the loop.
- Deterministic tests: no threads/sleeps in `Supervisor.tick(now)`; `run_frames(n, start, dt)` drives a fake clock.
  `serve_forever` is only a thin real-time wrapper.

## Landmark auto-calibration (FR-14, wired)
Per camera with landmarks, each frame a detector (`get_model(LANDMARK_MODEL)`, conf 0.25, all classes) yields
candidates. For each landmark the nearest-ish candidate (within 1.5x landmark size) with the best
`max(IoU, appearance similarity)` is chosen; `appearance.py` (`hsv_histogram`, `similarity` = HSV histogram
correlation in [0,1]) compares it to the landmark's reference crop (taken from the first frame, refreshed after each
recalibration). `LandmarkTracker.update(box, sim, ts)` decides; on `recalibrate` the engine's box (what
`landmark.get(name)` returns) moves and a `kind="calibration"` event is posted. Low similarity never moves the box.
