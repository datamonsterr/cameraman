"""Example Code Block: human detection near the door.

Same injected API as human_detection.py. A landmark named "door" marks the door
region (a still object/area). This block fires only when a detected person overlaps
the (possibly auto-calibrated) door region, emailing an alert. The door landmark
auto-calibrates in the worker as the region drifts (SPEC FR-14), so this logic keeps
working without manual re-drawing.
"""

model = get_model(config.get("model", "yolov8n"))
dets = model(frame, conf=0.4, classes=[0])  # person

door = landmark.get("door")  # current (auto-calibrated) door box, or None
near = 0
for d in dets:
    at_door = door is not None and landmark.contains("door", d.box)
    color = (0, 0, 255) if at_door else (0, 255, 0)
    draw.box(d.box, color=color, label="person@door" if at_door else "person")
    if at_door:
        near += 1

if door is not None:
    draw.polygon(door, color=(255, 200, 0), label="door")

emit("persons_at_door", near)

if near > 0 and now() >= state.get("cooldown_until", 0):
    notify(
        subject=f"Human near the door on {camera.name}",
        body=f"{near} person(s) detected near the door on {camera.name} at {ts()}.",
    )
    state["cooldown_until"] = now() + 60
