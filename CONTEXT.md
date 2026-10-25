# CONTEXT.md — Project terms, decisions & environment

Living record of settled vocabulary, decisions, and known environment facts. Update when a
term or decision is agreed. Architectural decisions get a full ADR under `docs/adr/`.

## Glossary

- **Camera** — a discovered or manually added IP camera with an RTSP source and credentials.
- **Discovery** — LAN scan (ONVIF WS-Discovery + port sweep + RTSP fingerprint) producing
  camera candidates.
- **Workflow** — a directed graph of **nodes** and **edges** that runs against live frames.
- **Node** — a typed unit in a workflow: `camera`, `codeblock`, `email`, (extensible).
- **Code Block** — a `codeblock` node running user Python with an injected API against frames.
- **Landmark** — a named region on a camera marking where a still object sits.
- **Auto-calibration** — the worker moving a landmark box to follow its drifting still object.
- **Run** — an active execution of a workflow by the worker; produces events/detections.
- **Event** — a recorded occurrence: detection, notification, health change, calibration.

## Roles

`admin` > `operator` > `viewer`. Mobile defaults to `viewer`. See SPEC §2.

## Key decisions (see ADRs for rationale)

- Monorepo, polyglot: Rust backend, Python worker, React web, Expo mobile. (ADR-0001)
- Backend owns persistence & orchestration; worker owns live video. (ADR-0002)
- Postgres as system of record; workflow graph stored as JSONB per version. (ADR-0003)
- Redis for job queue + live-frame pub/sub between backend and worker. (ADR-0004)
- Auth: Argon2id + JWT access/refresh with rotation; RBAC server-side. (ADR-0005)
- Node registry drives both editor UI and worker execution (one schema). (ADR-0006)
- Code Block runs in a resource-limited sandboxed subprocess. (ADR-0007)
- Landmark auto-calibration via tracker + IoU/appearance match. (ADR-0008)

## Chosen "other" features (SPEC §5)

Live grid · event timeline w/ snapshots · clip recording + retention · RBAC + audit log ·
camera health monitoring + uptime alerts.

## Environment facts (operator's machine, 2026-10-25)

- Host: Arch Linux, `enp8s0` on `192.168.1.238/24`, gateway `192.168.1.1`. GPU: GTX 1060 6GB
  (CUDA available; detection target host). Docker + compose present. ffmpeg present.
- Tooling authenticated: GitHub (`datamonsterr`), Railway (Pham Dat), Vercel, EAS
  (`datamonster`). `psql`, `nmap`, `arp-scan`, `expo` CLI not installed (use containerized
  psql / Node-based discovery / `npx expo`).
- **Cameras on LAN:**
  - `192.168.1.38:554` — Tenda, RTSP path `/tenda`, HEVC 2304×1296 + PCM_ALAW audio.
    Connects with the operator's RTSP credentials. **This is camera #1.**
  - `192.168.1.164:8554` — YGTek RTSP Server 2.0, realm `ygtechnologyshanghai`, Digest auth.
    Rejected `admin` + operator password; needs the correct username/credentials, to be
    entered at connect time in the UI. **This is camera #2.**
- Email target for example workflows: `phamdat17092004@gmail.com`.

## Secrets handling

Camera and SMTP credentials are provided at runtime via the UI/env and stored encrypted;
they are **never** committed. The operator's RTSP password is runtime config, not source.
