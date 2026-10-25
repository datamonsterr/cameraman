"""HTTP client for the backend ingest API (docs/runtime-protocol.md)."""

from __future__ import annotations

import os
from typing import Any, Protocol


class Ingest(Protocol):
    def post_event(self, kind: str, **kw: Any) -> None: ...
    def post_notification(
        self, recipients: list[str], subject: str = "", body: str = "", **kw: Any
    ) -> None: ...
    def post_calibration(
        self, camera_id: str, landmark: str, old_box, new_box, similarity: float, **kw: Any
    ) -> None: ...
    def post_health(self, camera_id: str, state: str, **kw: Any) -> None: ...


def _event_body(
    kind: str,
    camera_id=None,
    workflow_id=None,
    run_id=None,
    severity: str = "info",
    message: str | None = None,
    payload: dict | None = None,
) -> dict:
    body: dict[str, Any] = {"kind": kind, "severity": severity}
    for k, v in (
        ("camera_id", camera_id),
        ("workflow_id", workflow_id),
        ("run_id", run_id),
        ("message", message),
        ("payload", payload),
    ):
        if v is not None:
            body[k] = v
    return body


class _Common:
    def post_calibration(
        self, camera_id, landmark, old_box, new_box, similarity, **kw
    ) -> None:
        payload = {
            "landmark": landmark,
            "old_box": [float(v) for v in old_box],
            "new_box": [float(v) for v in new_box],
            "similarity": float(similarity),
        }
        self.post_event(  # type: ignore[attr-defined]
            "calibration",
            camera_id=camera_id,
            message=f"landmark {landmark} recalibrated",
            payload=payload,
            **kw,
        )

    def post_health(self, camera_id, state, **kw) -> None:
        sev = "info" if state == "online" else "warn"
        extra = kw.pop("payload", None) or {}
        self.post_event(  # type: ignore[attr-defined]
            "health",
            camera_id=camera_id,
            severity=sev,
            message=f"camera {state}",
            payload={"state": state, **extra},
            **kw,
        )


class HttpIngest(_Common):
    def __init__(
        self,
        base_url: str | None = None,
        token: str | None = None,
        client=None,
        timeout: float = 5.0,
    ):
        import httpx

        self.base = (base_url or os.environ.get("BACKEND_URL", "http://localhost:8080")).rstrip("/")
        self.token = token if token is not None else os.environ.get("WORKER_TOKEN", "")
        self.client = client or httpx.Client(timeout=timeout)

    def _post(self, path: str, body: dict) -> None:
        r = self.client.post(
            f"{self.base}/api/v1/ingest{path}", json=body, headers={"X-Worker-Token": self.token}
        )
        r.raise_for_status()

    def post_event(self, kind: str, **kw) -> None:
        self._post("/events", _event_body(kind, **kw))

    def post_notification(
        self, recipients, subject="", body="", event_id=None, dedup_key=None
    ) -> None:
        data: dict[str, Any] = {
            "recipients": list(recipients),
            "subject": subject,
            "body": body,
        }
        if event_id is not None:
            data["event_id"] = event_id
        if dedup_key is not None:
            data["dedup_key"] = dedup_key
        self._post("/notifications", data)


class FakeIngest(_Common):
    """Records calls: `events`, `notifications` (dicts)."""

    def __init__(self) -> None:
        self.events: list[dict] = []
        self.notifications: list[dict] = []

    def post_event(self, kind: str, **kw) -> None:
        self.events.append(_event_body(kind, **kw))

    def post_notification(
        self, recipients, subject="", body="", event_id=None, dedup_key=None
    ) -> None:
        self.notifications.append(
            {
                "recipients": list(recipients),
                "subject": subject,
                "body": body,
                "event_id": event_id,
                "dedup_key": dedup_key,
            }
        )

    def of_kind(self, kind: str) -> list[dict]:
        return [e for e in self.events if e["kind"] == kind]
