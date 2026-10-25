from pathlib import Path

import pytest

from cameraman_worker.registry import NodeRegistry

DATA = Path(__file__).parent / "data"
EXAMPLES = Path(__file__).parent.parent / "examples"
CAM_ID = "11111111-1111-1111-1111-111111111111"


@pytest.fixture
def registry():
    return NodeRegistry.load(DATA / "node_types.json")


def make_graph(code: str, email_cfg: dict | None = None, model: str = "yolov8n") -> dict:
    return {
        "nodes": [
            {"id": "cam", "type": "camera", "config": {"camera_id": CAM_ID, "fps": 10}},
            {"id": "code", "type": "codeblock", "config": {"code": code, "model": model}},
            {
                "id": "mail",
                "type": "email",
                "config": email_cfg
                or {"to": ["a@b.co"], "subject": "S {{camera}}", "body": "{{body}}"},
            },
        ],
        "edges": [
            {
                "id": "e1",
                "source": "cam",
                "sourceHandle": "frames",
                "target": "code",
                "targetHandle": "frames",
            },
            {
                "id": "e2",
                "source": "code",
                "sourceHandle": "actions",
                "target": "mail",
                "targetHandle": "trigger",
            },
        ],
    }
