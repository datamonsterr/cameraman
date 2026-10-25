#!/usr/bin/env python3
"""Seed the running Cameraman stack with demo data via the REST API.

Operationalizes DoD items 5-7: configure SMTP, register + connect the two LAN
cameras over RTSP, draw a "door" landmark, and create + enable the two YOLO example
workflows (human detection; human near door) that email the operator.

Stdlib only (urllib). All secrets come from the environment — nothing is hardcoded.

Env:
  API_BASE            default http://localhost:8080/api/v1
  ADMIN_EMAIL         admin login (default phamdat17092004@gmail.com)
  ADMIN_PASSWORD      admin password (default admin12345)
  SMTP_HOST/PORT/USERNAME/PASSWORD/FROM   Gmail SMTP for the email node
  CAM1_HOST CAM1_PORT CAM1_PATH CAM1_USER CAM1_PASS   camera 1 (Tenda)
  CAM2_HOST CAM2_PORT CAM2_PATH CAM2_USER CAM2_PASS   camera 2 (YGTek)
  NOTIFY_EMAIL        recipient for alerts (default phamdat17092004@gmail.com)

Usage:
  python3 scripts/seed_demo.py
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

API = os.environ.get("API_BASE", "http://localhost:8080/api/v1")
REPO = Path(__file__).resolve().parent.parent
TOKEN: str | None = None


def call(method: str, path: str, body=None, auth=True, raw=False):
    url = f"{API}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if auth and TOKEN:
        req.add_header("Authorization", f"Bearer {TOKEN}")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            payload = r.read()
            return r.status, (payload if raw else (json.loads(payload) if payload else None))
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="ignore")
        return e.code, detail


def login() -> None:
    global TOKEN
    email = os.environ.get("ADMIN_EMAIL", "phamdat17092004@gmail.com")
    password = os.environ.get("ADMIN_PASSWORD", "admin12345")
    status, resp = call("POST", "/auth/login", {"email": email, "password": password}, auth=False)
    if status != 200:
        sys.exit(f"login failed ({status}): {resp}")
    TOKEN = resp["access_token"]
    print(f"logged in as {email}")


def configure_smtp() -> None:
    host = os.environ.get("SMTP_HOST")
    if not host:
        print("SMTP_HOST not set; skipping SMTP config (email node will not send)")
        return
    body = {
        "host": host,
        "port": int(os.environ.get("SMTP_PORT", "587")),
        "username": os.environ.get("SMTP_USERNAME"),
        "password": os.environ.get("SMTP_PASSWORD"),
        "from_addr": os.environ.get("SMTP_FROM", os.environ.get("SMTP_USERNAME", "")),
        "use_tls": True,
    }
    status, resp = call("PUT", "/settings/smtp", body)
    print(f"smtp config: {status}")


def ensure_camera(idx: int) -> str | None:
    host = os.environ.get(f"CAM{idx}_HOST")
    if not host:
        print(f"CAM{idx}_HOST not set; skipping camera {idx}")
        return None
    body = {
        "name": os.environ.get(f"CAM{idx}_NAME", f"camera-{idx}"),
        "host": host,
        "port": int(os.environ.get(f"CAM{idx}_PORT", "554")),
        "rtsp_path": os.environ.get(f"CAM{idx}_PATH", "/"),
        "rtsp_username": os.environ.get(f"CAM{idx}_USER"),
        "rtsp_password": os.environ.get(f"CAM{idx}_PASS"),
        "transport": "tcp",
    }
    status, resp = call("POST", "/cameras", body)
    if status not in (200, 201):
        print(f"camera {idx} create failed ({status}): {resp}")
        return None
    cam_id = resp["id"]
    # Connect (validates the RTSP stream and flips status to online).
    cstatus, cresp = call(
        "POST",
        f"/cameras/{cam_id}/connect",
        {"username": body["rtsp_username"], "password": body["rtsp_password"]},
    )
    state = cresp.get("status") if isinstance(cresp, dict) else cresp
    print(f"camera {idx} ({host}) -> {state}")
    return cam_id


def ensure_door_landmark(cam_id: str) -> None:
    body = {
        "camera_id": cam_id,
        "name": "door",
        "box": [0.35, 0.25, 0.3, 0.55],  # normalized x,y,w,h; adjust in the UI
        "drift_threshold": 0.02,
        "similarity_threshold": 0.7,
    }
    status, resp = call("POST", "/landmarks", body)
    print(f"door landmark: {status}")


def create_workflow(name: str, cam_id: str) -> None:
    spec = json.loads((REPO / "db" / "seed" / "workflows" / f"{name}.json").read_text())
    graph = json.loads(json.dumps(spec["graph"]).replace("${CAMERA_ID}", cam_id))
    for n in graph["nodes"]:
        if n["type"] == "email":
            n["config"]["to"] = [os.environ.get("NOTIFY_EMAIL", "phamdat17092004@gmail.com")]
    body = {"name": spec["name"], "description": spec.get("description"), "graph": graph}
    status, resp = call("POST", "/workflows", body)
    if status not in (200, 201):
        print(f"workflow {name} create failed ({status}): {resp}")
        return
    wid = resp["id"]
    estatus, _ = call("POST", f"/workflows/{wid}/enable")
    print(f"workflow {name} -> created {wid}, enable {estatus}")


def main() -> None:
    login()
    configure_smtp()
    cam1 = ensure_camera(1)
    ensure_camera(2)
    if cam1:
        ensure_door_landmark(cam1)
        create_workflow("human-detection", cam1)
        create_workflow("human-detection-near-door", cam1)
    else:
        print("no camera 1; skipping landmark + workflows")
    print("done")


if __name__ == "__main__":
    main()
