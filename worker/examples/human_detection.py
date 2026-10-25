"""Example Code Block: human detection.

Injected API (see SPEC FR-10 / worker codeblock runtime):
  frame                      current frame, numpy BGR array
  np, cv2, torch             libraries
  get_model(name)            cached model loader -> Model
  Model(frame, conf, classes)-> iterable of Detection(label, confidence, box, xyxy)
  draw.box/text/mask/polygon annotate the outgoing stream
  notify(subject, body, to)  emit an email action into the workflow
  landmark.get/calibrate/contains
  emit(key, value)           structured output to downstream nodes
  state                      dict persisted across frames (per node)
  camera                     .id, .name
  now()/ts()/log()           helpers

This block detects people with YOLO, draws a green box on each, and emails on the
first appearance (debounced by a 60s cooldown held in `state`).
"""

model = get_model(config.get("model", "yolov8n"))
dets = model(frame, conf=0.4, classes=[0])  # COCO class 0 = person

count = 0
for d in dets:
    draw.box(d.box, color=(0, 255, 0), label=f"person {d.confidence:.2f}")
    count += 1

emit("person_count", count)

if count > 0 and now() >= state.get("cooldown_until", 0):
    notify(
        subject=f"Human detected on {camera.name}",
        body=f"{count} person(s) detected on {camera.name} at {ts()}.",
    )
    state["cooldown_until"] = now() + 60
