# ADR-0007: Code Block sandbox & threat model

**Status:** Accepted · **Date:** 2026-10-25

## Context
Users run arbitrary Python (PyTorch/OpenCV/any lib) against live frames. This is powerful and
dangerous: it could exfiltrate data, exhaust resources, or crash the worker.

## Threat model
Trust boundary: authenticated `operator`/`admin` authoring code on a **self-hosted** worker
they control. Primary risks are accidental resource exhaustion and worker crashes, plus
defense-in-depth against a compromised account. Not in scope for v1: defeating a determined
malicious operator with host access.

## Decision
- User code runs in a **separate subprocess** (not the worker's interpreter), spawned per run,
  communicating frames/results over a pipe/shared memory.
- Limits applied: CPU seconds (`CODEBLOCK_CPU_SECONDS`), memory (`CODEBLOCK_MEM_MB`) via
  `resource` rlimits / cgroups in-container; wall-clock watchdog; output size caps.
- No direct outbound network from user code; side effects only through the injected API
  (`draw`, `notify`, `landmark`, `emit`). Filesystem access restricted to a scratch dir.
- Crashes/timeouts are caught, recorded as run errors, and never crash the worker.
- The worker container itself runs unprivileged with a read-only root FS where feasible.

## Consequences
- Robust against accidents and contained against account compromise.
- Slight per-run overhead (process spawn); mitigated by a warm worker pool and model cache.
- Full hostile-operator isolation (gVisor/microVM) is a documented future hardening step.
