import { describe, expect, it } from 'vitest'
import type { WorkflowGraph } from '@/types/api'
import { NODE_TYPES } from './fixtures'
import {
  autoLayout,
  canConnect,
  CODE_TEMPLATE,
  defaultConfig,
  formatIssue,
  fromApiGraph,
  issuesByNode,
  issuesFromBody,
  nextNodeId,
  toApiGraph,
  toRegistry,
  validateGraph,
} from './graph'

const reg = toRegistry(NODE_TYPES)
const CAM = '11111111-1111-1111-1111-111111111111'

const good = (): WorkflowGraph => ({
  nodes: [
    { id: 'cam', type: 'camera', config: { camera_id: CAM, fps: 5 }, position: { x: 0, y: 0 } },
    { id: 'code', type: 'codeblock', config: { code: 'def process(f): pass' }, position: { x: 300, y: 0 } },
    { id: 'mail', type: 'email', config: { to: ['a@b.co'], subject: 'hi' }, position: { x: 600, y: 0 } },
  ],
  edges: [
    { id: 'e1', source: 'cam', target: 'code', sourceHandle: 'frames', targetHandle: 'frames' },
    { id: 'e2', source: 'code', target: 'mail', sourceHandle: 'actions', targetHandle: 'trigger' },
  ],
})
const codes = (g: WorkflowGraph) => validateGraph(g, reg).map((i) => i.code)

describe('graph <-> api mapping', () => {
  it('round-trips nodes, edges, config and positions', () => {
    const g = good()
    const { nodes, edges } = fromApiGraph(g)
    expect(toApiGraph(nodes, edges)).toEqual(g)
  })
  it('lays out nodes lacking positions by depth', () => {
    const g = good()
    g.nodes.forEach((n) => delete n.position)
    const { nodes } = fromApiGraph(g)
    const xs = nodes.map((n) => n.position.x)
    expect(xs[0]).toBeLessThan(xs[1])
    expect(xs[1]).toBeLessThan(xs[2])
    expect(autoLayout([], []).size).toBe(0)
  })
  it('tolerates empty/missing graphs', () => {
    expect(fromApiGraph(null)).toEqual({ nodes: [], edges: [] })
  })
})

describe('defaults and ids', () => {
  it('fills schema defaults and a python template', () => {
    expect(defaultConfig(reg.get('camera')!)).toEqual({ fps: 10 })
    expect(defaultConfig(reg.get('codeblock')!)).toEqual({ code: CODE_TEMPLATE, model: 'yolov8n' })
    expect(defaultConfig(reg.get('email')!)).toEqual({ to: [], cooldown_secs: 60 })
  })
  it('generates unique ids', () => {
    expect(nextNodeId('camera', [])).toBe('camera-1')
    expect(nextNodeId('camera', ['camera-1', 'camera-2'])).toBe('camera-3')
  })
})

describe('validateGraph (mirrors server)', () => {
  it('accepts a good graph', () => expect(codes(good())).toEqual([]))
  it('missing / empty required config', () => {
    const g = good()
    delete g.nodes[0].config.camera_id
    g.nodes[1].config.code = ''
    expect(codes(g)).toEqual(['missing_config', 'missing_config'])
  })
  it('bad config types and bounds', () => {
    const g = good()
    g.nodes[0].config.fps = 'x'
    expect(codes(g)).toEqual(['bad_config'])
    g.nodes[0].config.fps = 0
    expect(codes(g)).toEqual(['bad_config'])
    g.nodes[0].config.fps = 31
    expect(codes(g)).toEqual(['bad_config'])
    g.nodes[0].config.fps = 1.5
    expect(codes(g)).toEqual(['bad_config'])
    g.nodes[0].config.fps = 5
    g.nodes[2].config.to = [1]
    expect(codes(g)).toEqual(['bad_config'])
  })
  it('unknown type, duplicate id', () => {
    const g = good()
    g.nodes.push({ id: 'x', type: 'nope', config: {} }, { id: 'cam', type: 'camera', config: { camera_id: CAM } })
    expect(codes(g)).toEqual(expect.arrayContaining(['unknown_type', 'duplicate_id']))
  })
  it('bad edges and port type mismatch', () => {
    const g = good()
    g.edges.push({ id: 'e3', source: 'cam', target: 'ghost', sourceHandle: 'frames', targetHandle: 'frames' })
    expect(codes(g)).toContain('bad_edge')
    const h = good()
    h.edges[1].sourceHandle = 'result'
    expect(codes(h)).toContain('type_mismatch')
    const p = good()
    p.edges[0].targetHandle = 'nope'
    expect(codes(p)).toContain('bad_edge')
  })
  it('dangling required inputs', () => {
    const g = good()
    g.edges = []
    expect(codes(g)).toEqual(['dangling_input', 'dangling_input'])
  })
  it('cycles', () => {
    const r = toRegistry([
      { id: 'pass', category: 'process', title: 'Pass', descriptor: { inputs: [{ id: 'in', type: 'frame' }], outputs: [{ id: 'out', type: 'frame' }], config: {} } },
    ])
    const g: WorkflowGraph = {
      nodes: [
        { id: 'a', type: 'pass', config: {} },
        { id: 'b', type: 'pass', config: {} },
      ],
      edges: [
        { id: '1', source: 'a', target: 'b', sourceHandle: 'out', targetHandle: 'in' },
        { id: '2', source: 'b', target: 'a', sourceHandle: 'out', targetHandle: 'in' },
      ],
    }
    expect(validateGraph(g, r).map((i) => i.code)).toContain('cycle')
    const { nodes, edges } = fromApiGraph({ ...g, edges: [g.edges[0]] })
    expect(canConnect({ source: 'b', sourceHandle: 'out', target: 'a', targetHandle: 'in' }, nodes, edges, r)).toBe(false)
  })
})

describe('canConnect', () => {
  const { nodes, edges } = fromApiGraph(good())
  const c = (s: string, sh: string, t: string, th: string) => ({ source: s, sourceHandle: sh, target: t, targetHandle: th })
  it('allows matching port types', () => {
    expect(canConnect(c('cam', 'frames', 'code', 'frames'), nodes, [], reg)).toBe(true)
  })
  it('rejects mismatched types, self loops, unknown ports and duplicates', () => {
    expect(canConnect(c('code', 'result', 'mail', 'trigger'), nodes, edges, reg)).toBe(false)
    expect(canConnect(c('code', 'actions', 'code', 'frames'), nodes, edges, reg)).toBe(false)
    expect(canConnect(c('cam', 'zzz', 'code', 'frames'), nodes, edges, reg)).toBe(false)
    expect(canConnect(c('cam', 'frames', 'code', 'frames'), nodes, edges, reg)).toBe(false)
    expect(canConnect({ source: null, target: 'x' }, nodes, edges, reg)).toBe(false)
  })
})

describe('server 422 details', () => {
  const body = {
    error: 'unprocessable',
    message: 'workflow graph is invalid',
    details: [
      { code: 'missing_config', message: "missing required config 'code'", node_id: 'code' },
      { code: 'cycle', message: 'graph contains a cycle', node_id: null },
    ],
  }
  it('parses, groups and formats', () => {
    const issues = issuesFromBody(body)
    expect(issues).toHaveLength(2)
    const by = issuesByNode(issues)
    expect(by.get('code')).toHaveLength(1)
    expect(by.get('')).toHaveLength(1)
    expect(formatIssue(issues[0], new Map([['code', 'Code Block']]))).toBe("Code Block: missing required config 'code'")
    expect(formatIssue(issues[1])).toBe('graph contains a cycle')
  })
  it('is safe on garbage', () => {
    expect(issuesFromBody(undefined)).toEqual([])
    expect(issuesFromBody({ details: 'x' })).toEqual([])
    expect(issuesFromBody({ details: [null, 3, {}] })).toEqual([{ code: 'invalid', message: 'invalid', node_id: null }])
  })
})
