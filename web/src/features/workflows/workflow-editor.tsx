import '@xyflow/react/dist/style.css'
import {
  addEdge,
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
} from '@xyflow/react'
import { Save } from 'lucide-react'
import { useCallback, useMemo, useState, type DragEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useCameras } from '@/features/cameras/api'
import { ApiError } from '@/lib/api'
import type { GraphIssue, NodeType, Workflow, WorkflowGraph } from '@/types/api'
import { useCreateWorkflow, useSetEnabled, useUpdateWorkflow } from './api'
import { ConfigPanel } from './config-panel'
import { EditorCtx } from './editor-context'
import {
  canConnect,
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
import { RunHistory } from './run-history'
import { WorkflowNode, type CmNode } from './workflow-node'

const NODE_TYPES = { cm: WorkflowNode }
const DND_MIME = 'application/x-cameraman-node'

export function WorkflowEditor(props: { workflow?: Workflow; nodeTypes: NodeType[]; canEdit: boolean }) {
  return (
    <ReactFlowProvider>
      <EditorInner {...props} />
    </ReactFlowProvider>
  )
}

function EditorInner({ workflow, nodeTypes, canEdit }: { workflow?: Workflow; nodeTypes: NodeType[]; canEdit: boolean }) {
  const navigate = useNavigate()
  const registry = useMemo(() => toRegistry(nodeTypes), [nodeTypes])
  const { data: cameras = [] } = useCameras()
  const create = useCreateWorkflow()
  const update = useUpdateWorkflow()
  const toggle = useSetEnabled()
  const rf = useReactFlow()

  const initial = useMemo(() => fromApiGraph(workflow?.graph), [workflow?.graph])
  const [nodes, setNodes, onNodesChange] = useNodesState<CmNode>(
    initial.nodes.map((n) => ({ id: n.id, type: 'cm' as const, position: n.position, data: n.data })),
  )
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges)
  const [name, setName] = useState(workflow?.name ?? '')
  const [description, setDescription] = useState(workflow?.description ?? '')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showErrors, setShowErrors] = useState(false)
  const [serverIssues, setServerIssues] = useState<GraphIssue[]>([])
  const [tab, setTab] = useState('config')
  const [saved, setSaved] = useState(() => ({
    graph: JSON.stringify(toApiGraph(initial.nodes, initial.edges)),
    meta: JSON.stringify([workflow?.name ?? '', workflow?.description ?? '']),
  }))

  const graph: WorkflowGraph = useMemo(() => toApiGraph(nodes, edges), [nodes, edges])
  const graphSig = useMemo(() => JSON.stringify(graph), [graph])
  const metaSig = JSON.stringify([name, description])
  const graphDirty = graphSig !== saved.graph
  const dirty = graphDirty || metaSig !== saved.meta
  const readOnly = !canEdit

  const clientIssues = useMemo(() => validateGraph(graph, registry), [graph, registry])
  const issues = useMemo(() => {
    const all = showErrors ? [...clientIssues, ...serverIssues] : serverIssues
    const seen = new Set<string>()
    return all.filter((i) => {
      const k = `${i.code}|${i.node_id}|${i.message}`
      return seen.has(k) ? false : (seen.add(k), true)
    })
  }, [clientIssues, serverIssues, showErrors])
  const byNode = useMemo(() => issuesByNode(issues), [issues])
  const ctx = useMemo(() => ({ registry, issues: byNode }), [registry, byNode])
  const titles = useMemo(
    () => new Map(nodes.map((n) => [n.id, registry.get(n.data.typeId)?.title ?? n.data.typeId])),
    [nodes, registry],
  )
  const selected = nodes.find((n) => n.id === selectedId)

  const addNode = useCallback(
    (nt: NodeType, position?: { x: number; y: number }) => {
      if (readOnly) return
      const id = nextNodeId(nt.id, nodes.map((n) => n.id))
      const pos = position ?? { x: 60 + (nodes.length % 5) * 40, y: 60 + nodes.length * 50 }
      setNodes((ns) => [...ns, { id, type: 'cm', position: pos, data: { typeId: nt.id, config: defaultConfig(nt) } }])
      setSelectedId(id)
      setTab('config')
    },
    [readOnly, nodes, setNodes],
  )

  const onConnect = useCallback((c: Connection) => setEdges((es) => addEdge({ ...c, id: `e-${c.source}-${c.sourceHandle}-${c.target}-${c.targetHandle}` }, es)), [setEdges])
  const isValidConnection = useCallback(
    (c: Connection | Edge) =>
      canConnect(
        { source: c.source, target: c.target, sourceHandle: c.sourceHandle, targetHandle: c.targetHandle },
        nodes,
        edges,
        registry,
      ),
    [nodes, edges, registry],
  )

  function onDrop(e: DragEvent) {
    e.preventDefault()
    const id = e.dataTransfer.getData(DND_MIME)
    const nt = registry.get(id)
    if (nt) addNode(nt, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }))
  }

  function setConfig(nodeId: string, config: Record<string, unknown>) {
    setNodes((ns) => ns.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, config } } : n)))
  }

  async function save() {
    setShowErrors(true)
    setServerIssues([])
    if (!name.trim()) {
      toast.error('Give the workflow a name')
      return
    }
    if (clientIssues.length > 0) {
      setTab('issues')
      toast.error(`Fix ${clientIssues.length} issue${clientIssues.length === 1 ? '' : 's'} before saving`)
      return
    }
    try {
      if (workflow) {
        const body: { name?: string; description?: string; graph?: WorkflowGraph } = {}
        if (name !== workflow.name) body.name = name.trim()
        if (description !== (workflow.description ?? '')) body.description = description
        if (graphDirty) body.graph = graph
        await update.mutateAsync({ id: workflow.id, body })
        setSaved({ graph: graphSig, meta: metaSig })
        toast.success(graphDirty ? 'Saved as a new version' : 'Saved')
      } else {
        const w = await create.mutateAsync({ name: name.trim(), description: description || undefined, graph })
        toast.success('Workflow created')
        navigate(`/workflows/${w.id}`, { replace: true })
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) {
        const details = issuesFromBody(e.body)
        setServerIssues(details.length ? details : [{ code: 'invalid', message: e.message, node_id: null }])
        setTab('issues')
        toast.error('The server rejected this graph')
      } else {
        toast.error(e instanceof Error ? e.message : 'Save failed')
      }
    }
  }

  async function onToggle(enabled: boolean) {
    if (!workflow) return
    try {
      await toggle.mutateAsync({ id: workflow.id, enabled })
      toast.success(enabled ? 'Workflow enabled' : 'Workflow disabled')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not change state')
    }
  }

  const grouped = useMemo(() => {
    const m = new Map<string, NodeType[]>()
    for (const t of nodeTypes) m.set(t.category, [...(m.get(t.category) ?? []), t])
    return [...m]
  }, [nodeTypes])
  const enabled = workflow?.enabled ?? false
  const pending = create.isPending || update.isPending

  return (
    <EditorCtx.Provider value={ctx}>
      <div className="flex h-[calc(100vh-7rem)] min-h-[32rem] flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label="Workflow name"
            className="h-8 w-56"
            placeholder="Workflow name"
            value={name}
            readOnly={readOnly}
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            aria-label="Description"
            className="h-8 min-w-40 flex-1"
            placeholder="Description (optional)"
            value={description}
            readOnly={readOnly}
            onChange={(e) => setDescription(e.target.value)}
          />
          {workflow && (
            <label className="flex items-center gap-2 text-xs" title={dirty ? 'Save changes before changing state' : undefined}>
              Enabled
              <Switch aria-label="Enabled" checked={enabled} disabled={readOnly || dirty || toggle.isPending} onCheckedChange={(v) => void onToggle(v)} />
            </label>
          )}
          {canEdit ? (
            <Button size="sm" onClick={() => void save()} disabled={pending || (!!workflow && !dirty)}>
              <Save />
              {pending ? 'Saving…' : workflow ? 'Save' : 'Create'}
            </Button>
          ) : (
            <span className="text-muted-foreground text-xs">Read-only</span>
          )}
        </div>

        <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[11rem_minmax(0,1fr)_20rem]">
          <aside aria-label="Node palette" className="overflow-auto rounded-lg border p-2">
            {grouped.map(([cat, types]) => (
              <div key={cat} className="mb-3">
                <h2 className="text-muted-foreground mb-1 text-[10px] font-medium tracking-wide uppercase">{cat}</h2>
                <div className="grid gap-1">
                  {types.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      draggable={canEdit}
                      disabled={readOnly}
                      onDragStart={(e) => e.dataTransfer.setData(DND_MIME, t.id)}
                      onClick={() => addNode(t)}
                      className="hover:bg-accent rounded-md border px-2 py-1.5 text-left text-xs disabled:opacity-50"
                    >
                      {t.title}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {nodeTypes.length === 0 && <p className="text-muted-foreground text-xs">No node types available.</p>}
          </aside>

          <div className="min-h-64 overflow-hidden rounded-lg border" onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
            <ReactFlow<CmNode, Edge>
              nodes={nodes}
              edges={edges}
              nodeTypes={NODE_TYPES}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              isValidConnection={isValidConnection}
              onNodeClick={(_, n) => {
                setSelectedId(n.id)
                setTab('config')
              }}
              onPaneClick={() => setSelectedId(null)}
              nodesDraggable={canEdit}
              nodesConnectable={canEdit}
              edgesReconnectable={canEdit}
              deleteKeyCode={canEdit ? ['Backspace', 'Delete'] : null}
              colorMode="dark"
              fitView
              proOptions={{ hideAttribution: true }}
            >
              <Background />
              <Controls showInteractive={false} />
              <MiniMap pannable zoomable className="!bg-card" />
            </ReactFlow>
          </div>

          <aside className="min-h-0 overflow-auto rounded-lg border p-2">
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList className="w-full">
                <TabsTrigger value="config" className="text-xs">
                  Config
                </TabsTrigger>
                <TabsTrigger value="issues" className="text-xs">
                  Issues{issues.length > 0 && ` (${issues.length})`}
                </TabsTrigger>
                <TabsTrigger value="runs" className="text-xs">
                  Runs
                </TabsTrigger>
              </TabsList>
              <TabsContent value="config" className="pt-2">
                {selected ? (
                  <ConfigPanel
                    key={selected.id}
                    nodeId={selected.id}
                    typeId={selected.data.typeId}
                    nodeType={registry.get(selected.data.typeId)}
                    config={selected.data.config}
                    cameras={cameras}
                    issues={byNode.get(selected.id) ?? []}
                    readOnly={readOnly}
                    onChange={(c) => setConfig(selected.id, c)}
                  />
                ) : (
                  <p className="text-muted-foreground text-xs">Select a node to edit its configuration.</p>
                )}
              </TabsContent>
              <TabsContent value="issues" className="pt-2">
                {issues.length === 0 ? (
                  <p className="text-muted-foreground text-xs">{showErrors ? 'No issues found.' : 'Validation runs when you save.'}</p>
                ) : (
                  <ul className="grid gap-1.5" aria-label="Validation issues">
                    {issues.map((i, idx) => (
                      <li key={idx}>
                        <button
                          type="button"
                          disabled={!i.node_id}
                          onClick={() => {
                            if (i.node_id) {
                              setSelectedId(i.node_id)
                              setTab('config')
                            }
                          }}
                          className="text-destructive hover:bg-destructive/10 w-full rounded px-1.5 py-1 text-left text-xs"
                        >
                          {formatIssue(i, titles)}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </TabsContent>
              <TabsContent value="runs" className="pt-2">
                <RunHistory workflowId={workflow?.id} />
              </TabsContent>
            </Tabs>
          </aside>
        </div>
      </div>
    </EditorCtx.Provider>
  )
}
