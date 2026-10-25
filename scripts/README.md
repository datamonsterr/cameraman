# scripts

Operational helpers. Run from the repo root against a running stack.

## seed_demo.py

Seeds the running stack (DoD 5-7) via the REST API: SMTP settings, the two LAN
cameras (registered + connected over RTSP), a `door` landmark, and the two YOLO
example workflows (human detection; human near door), both enabled and emailing the
operator.

Secrets come from the environment — nothing is hardcoded. Example (fill in real values):

```bash
export API_BASE=http://localhost:8080/api/v1
export ADMIN_EMAIL=phamdat17092004@gmail.com ADMIN_PASSWORD=admin12345

# Gmail SMTP (use an App Password, not your login password)
export SMTP_HOST=smtp.gmail.com SMTP_PORT=587
export SMTP_USERNAME=phamdat17092004@gmail.com SMTP_PASSWORD='<gmail-app-password>'
export SMTP_FROM=phamdat17092004@gmail.com NOTIFY_EMAIL=phamdat17092004@gmail.com

# Camera 1 — Tenda (verified reachable)
export CAM1_NAME=front CAM1_HOST=192.168.1.38 CAM1_PORT=554 CAM1_PATH=/tenda
export CAM1_USER=<user> CAM1_PASS='<rtsp-password>'

# Camera 2 — YGTek (supply the correct username/path)
export CAM2_NAME=door CAM2_HOST=192.168.1.164 CAM2_PORT=8554 CAM2_PATH=/
export CAM2_USER=<user> CAM2_PASS='<rtsp-password>'

python3 scripts/seed_demo.py
```

Idempotency: re-running may create duplicate workflows; delete prior ones in the UI or
reset the DB first. Cameras are unique on (host, port, rtsp_path) and will 409 on repeat.
