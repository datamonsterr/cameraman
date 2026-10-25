"""Graph engine: run one frame through a validated graph in topological order."""

from __future__ import annotations

import re
from dataclasses import dataclass, field

import numpy as np

from .draw import render
from .graph import Graph, ValidationError, validate_graph
from .landmarks import LandmarkTracker
from .registry import NodeRegistry
from .sandbox import Sandbox

_TEMPLATE = re.compile(r"\{\{\s*([\w.]+)\s*\}\}")


class GraphInvalidError(ValueError):
    def __init__(self, errors: list[ValidationError]):
        super().__init__("; ".join(f"{e.code}: {e.message}" for e in errors))
        self.errors = errors


@dataclass
class FrameResult:
    frame: np.ndarray
    actions: list[dict] = field(default_factory=list)
    emits: dict[str, dict] = field(default_factory=dict)
    errors: list[dict] = field(default_factory=list)
    logs: dict[str, list[str]] = field(default_factory=dict)
    draw_ops: list[dict] = field(default_factory=list)


def render_template(text: str, variables: dict) -> str:
    def sub(m: re.Match) -> str:
        v = variables.get(m.group(1))
        return "" if v is None else str(v)

    return _TEMPLATE.sub(sub, text or "")


class GraphEngine:
    def __init__(
        self,
        graph: dict | Graph,
        registry: NodeRegistry,
        *,
        sandbox: Sandbox | None = None,
        fake_detections: list[dict] | None = None,
        camera_name: str | None = None,
    ):
        res = validate_graph(graph, registry)
        if not res.ok or res.graph is None:
            raise GraphInvalidError(res.errors)
        self.graph, self.order = res.graph, res.order
        self.sandbox = sandbox or Sandbox()
        self.fake_detections = fake_detections
        self.camera_name = camera_name
        self.landmarks: dict[str, LandmarkTracker] = {}
        self._email_last_sent: dict[str, float] = {}
        self.node_state: dict[str, dict] = {}  # persisted per codeblock node

    def set_landmark(self, name: str, box, **kw) -> LandmarkTracker:
        self.landmarks[name] = LandmarkTracker(name, tuple(box), **kw)
        return self.landmarks[name]

    def _downstream_emails(self, node_id: str) -> list[str]:
        return [
            e.target
            for e in self.graph.edges
            if e.source == node_id
            and e.source_handle == "actions"
            and self.graph.node(e.target).type == "email"
        ]

    def _camera_info(self) -> dict:
        cams = [n for n in self.graph.nodes if n.type == "camera"]
        cid = cams[0].config.get("camera_id", "") if cams else ""
        return {"id": cid, "name": self.camera_name or cid}

    def run_frame(self, frame: np.ndarray, now: float | None = None) -> FrameResult:
        import time

        now = time.time() if now is None else now
        out = FrameResult(frame=frame)
        camera = self._camera_info()
        for node_id in self.order:
            node = self.graph.node(node_id)
            if node.type != "codeblock":
                continue  # camera yields the frame; email is handled via actions
            r = self.sandbox.run(
                node.config["code"],
                frame,
                camera=camera,
                config=node.config,
                landmarks={k: t.box for k, t in self.landmarks.items()},
                now=now,
                fake_detections=self.fake_detections,
                state=self.node_state.get(node_id, {}),
                node_id=node_id,
            )
            out.logs[node_id] = r.logs
            if not r.ok:
                out.errors.append({"node_id": node_id, "error": r.error})
                continue
            for name, box in r.landmark_updates.items():
                self.landmarks.setdefault(name, LandmarkTracker(name, tuple(box)))
                self.landmarks[name].calibrate(box, ts=now)
            self.node_state[node_id] = r.state
            out.emits[node_id] = r.emits
            out.draw_ops.extend(r.draw_ops)
            self._route(node_id, r.actions, r.emits, camera, now, out)
        out.frame = render(frame, out.draw_ops)
        return out

    def _route(self, node_id, actions, emits, camera, now, out: FrameResult) -> None:
        mails = self._downstream_emails(node_id)
        for a in actions:
            if not mails:
                out.actions.append(dict(a, source_node=node_id))
                continue
            variables = {
                **emits,
                "camera": camera["name"],
                "camera_id": camera["id"],
                "subject": a["subject"],
                "body": a["body"],
            }
            for mid in mails:
                cfg = self.graph.node(mid).config
                last = self._email_last_sent.get(mid)
                if last is not None and now - last < cfg.get("cooldown_secs", 60):
                    continue
                self._email_last_sent[mid] = now
                out.actions.append(
                    {
                        "type": "email",
                        "node_id": mid,
                        "source_node": node_id,
                        "to": a["to"] or cfg.get("to", []),
                        "subject": render_template(cfg.get("subject", ""), variables),
                        "body": render_template(cfg.get("body", ""), variables),
                        "ts": now,
                    }
                )
