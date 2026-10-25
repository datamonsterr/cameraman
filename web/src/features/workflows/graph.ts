import type {
  ConfigSchema,
  GraphEdge,
  GraphIssue,
  GraphNode,
  NodeType,
  PortSpec,
  WorkflowGraph,
} from '@/types/api'

/** Sensible starter for new Code Block nodes. */
export const CODE_TEMPLATE = `# Runs once per frame. Injected: frame (BGR numpy array), cv2, np, torch, ultralytics,
# draw, notify, landmark, state (dict kept across frames), emit(key, value).
from ultralytics import YOLO

model = state.setdefault("model", YOLO("yolov8n.pt"))
result = model(frame, verbose=False)[0]

people = [b for b in result.boxes if result.names[int(b.cls)] == "person"]
for b in people:
    x1, y1, x2, y2 = map(int, b.xyxy[0])
    draw.box(x1, y1, x2 - x1, y2 - y1, label="person")

emit("people", len(people))
if people and not state.get("alerted"):
    state["alerted"] = True
    notify("Person detected", f"{len(people)} person(s) in view")
elif not people:
    state["alerted"] = False
`

export type Registry = Map<string, NodeType>

export function toRegistry(types: NodeType[]): Registry {
  return new Map(types.map((t) => [t.id, t]))
}

/** Defaults declared in the schema, plus a template for python-format fields. */
export function defaultConfig(nt: NodeType): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, spec] of Object.entries(nt.descriptor.config.properties ?? {})) {
    if (spec.default !== undefined) out[key] = spec.default
    else if (spec.format === 'python') out[key] = CODE_TEMPLATE
    else if (spec.type === 'array') out[key] = []
  }
  return out
}

export function nextNodeId(typeId: string, existing: Iterable<string>): string {
  const used = new Set(existing)
  let n = 1
  while (used.has(`${typeId}-${n}`)) n += 1
  return `${typeId}-${n}`
}

// ---- editor-state <-> API graph ------------------------------------------

/** Minimal shape of the editor's nodes/edges (structurally compatible with React Flow). */
export interface EditorNode {
  id: string
  position: { x: number; y: number }
  data: { typeId: string; config: Record<string, unknown> }
}
export interface EditorEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string | null
  targetHandle?: string | null
}

export function toApiGraph(nodes: EditorNode[], edges: EditorEdge[]): WorkflowGraph {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.data.typeId,
      config: n.data.config,
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? '',
      targetHandle: e.targetHandle ?? '',
    })),
  }
}

/** Column layout by dependency depth, for graphs saved without positions. */
export function autoLayout(nodes: GraphNode[], edges: GraphEdge[]): Map<string, { x: number; y: number }> {
  const depth = new Map<string, number>(nodes.map((n) => [n.id, 0]))
  for (let i = 0; i < nodes.length; i++) {
    let changed = false
    for (const e of edges) {
      const d = (depth.get(e.source) ?? 0) + 1
      if (depth.has(e.target) && d > (depth.get(e.target) ?? 0) && d <= nodes.length) {
        depth.set(e.target, d)
        changed = true
      }
    }
    if (!changed) break
  }
  const rows = new Map<number, number>()
  const out = new Map<string, { x: number; y: number }>()
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0
    const r = rows.get(d) ?? 0
    rows.set(d, r + 1)
    out.set(n.id, { x: 40 + d * 300, y: 40 + r * 200 })
  }
  return out
}

export function fromApiGraph(graph: WorkflowGraph | null | undefined): { nodes: EditorNode[]; edges: EditorEdge[] } {
  const gn = Array.isArray(graph?.nodes) ? graph.nodes : []
  const ge = Array.isArray(graph?.edges) ? graph.edges : []
  const auto = autoLayout(gn, ge)
  return {
    nodes: gn.map((n) => ({
      id: n.id,
      position: n.position ?? auto.get(n.id) ?? { x: 0, y: 0 },
      data: { typeId: n.type, config: { ...(n.config ?? {}) } },
    })),
    edges: ge.map((e) => ({
      id: e.id || `${e.source}:${e.sourceHandle}->${e.target}:${e.targetHandle}`,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle,
      targetHandle: e.targetHandle,
    })),
  }
}

// ---- wiring --------------------------------------------------------------

export interface ConnectionLike {
  source: string | null
  target: string | null
  sourceHandle?: string | null
  targetHandle?: string | null
}

function findPort(ports: PortSpec[], id?: string | null) {
  return ports.find((p) => p.id === id)
}

/** Can this connection be drawn? Same port data type, no self loop, no duplicates, no cycle. */
export function canConnect(
  c: ConnectionLike,
  nodes: Pick<EditorNode, 'id' | 'data'>[],
  edges: EditorEdge[],
  registry: Registry,
): boolean {
  if (!c.source || !c.target || c.source === c.target) return false
  const s = nodes.find((n) => n.id === c.source)
  const t = nodes.find((n) => n.id === c.target)
  if (!s || !t) return false
  const sp = findPort(registry.get(s.data.typeId)?.descriptor.outputs ?? [], c.sourceHandle)
  const tp = findPort(registry.get(t.data.typeId)?.descriptor.inputs ?? [], c.targetHandle)
  if (!sp || !tp || sp.type !== tp.type) return false
  const dup = edges.some(
    (e) =>
      e.source === c.source && e.target === c.target && e.sourceHandle === c.sourceHandle && e.targetHandle === c.targetHandle,
  )
  if (dup) return false
  // adding source->target creates a cycle iff target already reaches source
  return !reaches(c.target, c.source, edges)
}

function reaches(from: string, to: string, edges: EditorEdge[]): boolean {
  const seen = new Set<string>()
  const stack = [from]
  while (stack.length) {
    const cur = stack.pop() as string
    if (cur === to) return true
    if (seen.has(cur)) continue
    seen.add(cur)
    for (const e of edges) if (e.source === cur) stack.push(e.target)
  }
  return false
}

// ---- client validation (mirrors backend/src/registry.rs::validate_graph) --

function typeOk(v: unknown, t: string): boolean {
  switch (t) {
    case 'string':
      return typeof v === 'string'
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v)
    case 'number':
      return typeof v === 'number'
    case 'boolean':
      return typeof v === 'boolean'
    case 'array':
      return Array.isArray(v)
    case 'object':
      return typeof v === 'object' && v !== null && !Array.isArray(v)
    default:
      return true
  }
}

export function checkConfig(nodeId: string, config: Record<string, unknown>, schema: ConfigSchema): GraphIssue[] {
  const out: GraphIssue[] = []
  const push = (code: string, message: string) => out.push({ code, message, node_id: nodeId })
  for (const key of schema.required ?? []) {
    const v = config[key]
    if (v === undefined || v === null || v === '') push('missing_config', `missing required config '${key}'`)
  }
  for (const [key, spec] of Object.entries(schema.properties ?? {})) {
    const v = config[key]
    if (v === undefined) continue
    if (spec.type && !typeOk(v, spec.type)) {
      push('bad_config', `'${key}' must be ${spec.type}`)
      continue
    }
    if (typeof v === 'number') {
      if (spec.minimum !== undefined && v < spec.minimum) push('bad_config', `'${key}' below minimum`)
      if (spec.maximum !== undefined && v > spec.maximum) push('bad_config', `'${key}' above maximum`)
    }
    if (Array.isArray(v) && spec.items?.type && !v.every((x) => typeOk(x, spec.items?.type as string))) {
      push('bad_config', `'${key}' items must be ${spec.items.type}`)
    }
  }
  return out
}

export function validateGraph(graph: WorkflowGraph, registry: Registry): GraphIssue[] {
  const out: GraphIssue[] = []
  const byId = new Map<string, GraphNode>()
  for (const n of graph.nodes) {
    if (byId.has(n.id)) out.push({ code: 'duplicate_id', message: `duplicate node id '${n.id}'`, node_id: n.id })
    byId.set(n.id, n)
    const t = registry.get(n.type)
    if (!t) out.push({ code: 'unknown_type', message: `unknown node type '${n.type}'`, node_id: n.id })
    else out.push(...checkConfig(n.id, n.config ?? {}, t.descriptor.config))
  }

  const wired = new Set<string>()
  for (const e of graph.edges) {
    const src = byId.get(e.source)
    const dst = byId.get(e.target)
    if (!src || !dst) {
      out.push({ code: 'bad_edge', message: `edge '${e.id}' references unknown node`, node_id: null })
      continue
    }
    const st = registry.get(src.type)
    const dt = registry.get(dst.type)
    if (!st || !dt) continue
    const sp = findPort(st.descriptor.outputs, e.sourceHandle)
    const dp = findPort(dt.descriptor.inputs, e.targetHandle)
    if (!sp || !dp) {
      out.push({ code: 'bad_edge', message: `edge '${e.id}' uses unknown port`, node_id: null })
      continue
    }
    wired.add(`${dst.id}\u0000${dp.id}`)
    if (sp.type !== dp.type) {
      out.push({ code: 'type_mismatch', message: `edge '${e.id}': ${sp.type} -> ${dp.type}`, node_id: dst.id })
    }
  }

  for (const n of graph.nodes) {
    const t = registry.get(n.type)
    if (!t) continue
    for (const p of t.descriptor.inputs.filter((p) => p.required !== false)) {
      if (!wired.has(`${n.id}\u0000${p.id}`)) {
        out.push({ code: 'dangling_input', message: `required input '${p.id}' not wired`, node_id: n.id })
      }
    }
  }

  if (hasCycle(graph, byId)) out.push({ code: 'cycle', message: 'graph contains a cycle', node_id: null })
  return out
}

function hasCycle(graph: WorkflowGraph, ids: Map<string, GraphNode>): boolean {
  const indeg = new Map<string, number>([...ids.keys()].map((k) => [k, 0]))
  const out = new Map<string, string[]>()
  for (const e of graph.edges) {
    if (ids.has(e.source) && ids.has(e.target)) {
      out.set(e.source, [...(out.get(e.source) ?? []), e.target])
      indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1)
    }
  }
  const ready = [...indeg].filter(([, d]) => d === 0).map(([k]) => k)
  let seen = 0
  while (ready.length) {
    const cur = ready.pop() as string
    seen += 1
    for (const nxt of out.get(cur) ?? []) {
      const d = (indeg.get(nxt) ?? 0) - 1
      indeg.set(nxt, d)
      if (d === 0) ready.push(nxt)
    }
  }
  return seen !== ids.size
}

// ---- issue presentation --------------------------------------------------

/** Group issues by node id ('' for graph-level ones). */
export function issuesByNode(issues: GraphIssue[]): Map<string, GraphIssue[]> {
  const m = new Map<string, GraphIssue[]>()
  for (const i of issues) {
    const k = i.node_id ?? ''
    m.set(k, [...(m.get(k) ?? []), i])
  }
  return m
}

/** Extract `details` from a 422 body; [] when absent or malformed. */
export function issuesFromBody(body: unknown): GraphIssue[] {
  const d = (body as { details?: unknown } | null | undefined)?.details
  if (!Array.isArray(d)) return []
  return d
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    .map((x) => ({
      code: typeof x.code === 'string' ? x.code : 'invalid',
      message: typeof x.message === 'string' ? x.message : 'invalid',
      node_id: typeof x.node_id === 'string' ? x.node_id : null,
    }))
}

export function formatIssue(i: GraphIssue, titles?: Map<string, string>): string {
  const where = i.node_id ? `${titles?.get(i.node_id) ?? i.node_id}: ` : ''
  return `${where}${i.message}`
}
