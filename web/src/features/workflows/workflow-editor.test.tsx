import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api } from '@/lib/api'
import { makeCamera } from '@/test/fixtures'
import type { Workflow } from '@/types/api'
import { NODE_TYPES } from './fixtures'
import { WorkflowEditor } from './workflow-editor'

vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="python editor" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}))
vi.mock('@/features/cameras/api', () => ({
  useCameras: () => ({ data: [makeCamera({ id: 'cam-1', name: 'Front door' })] }),
}))

beforeEach(() => vi.restoreAllMocks())

function renderEditor(props: { workflow?: Workflow; canEdit?: boolean } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <WorkflowEditor nodeTypes={NODE_TYPES} canEdit={props.canEdit ?? true} workflow={props.workflow} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const wf = (over: Partial<Workflow> = {}): Workflow => ({
  id: 'w1', name: 'Door watch', description: null, enabled: false, active_version_id: 'v1', created_by: null,
  created_at: '', updated_at: '',
  graph: { nodes: [{ id: 'camera-1', type: 'camera', config: { camera_id: 'cam-1', fps: 5 }, position: { x: 0, y: 0 } }], edges: [] },
  ...over,
})

describe('WorkflowEditor', () => {
  it('builds the palette from the registry', () => {
    renderEditor()
    const palette = screen.getByRole('complementary', { name: 'Node palette' })
    for (const t of NODE_TYPES) expect(within(palette).getByRole('button', { name: t.title })).toBeInTheDocument()
  })

  it('adds a node and opens its schema-driven config', async () => {
    renderEditor()
    await userEvent.click(screen.getByRole('button', { name: 'Camera' }))
    expect(await screen.findByTestId('node-camera-1')).toBeInTheDocument()
    expect(screen.getByLabelText(/Camera/, { selector: 'select' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Front door' })).toBeInTheDocument()
    expect(screen.getByLabelText(/Target FPS/)).toHaveValue(10)
  })

  it('prefills new code blocks with a python template', async () => {
    renderEditor()
    await userEvent.click(screen.getByRole('button', { name: 'Code Block (Python)' }))
    const ed = (await screen.findByLabelText('python editor')) as HTMLTextAreaElement
    expect(ed.value).toContain('notify(')
  })

  it('blocks save on client validation errors and lists them', async () => {
    const post = vi.spyOn(api, 'post')
    renderEditor()
    await userEvent.type(screen.getByLabelText('Workflow name'), 'My flow')
    await userEvent.click(screen.getByRole('button', { name: 'Camera' }))
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))
    const list = await screen.findByRole('list', { name: 'Validation issues' })
    expect(within(list).getByText(/missing required config 'camera_id'/)).toBeInTheDocument()
    expect(post).not.toHaveBeenCalled()
  })

  it('creates a workflow with the mapped graph', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ id: 'new' })
    renderEditor()
    await userEvent.type(screen.getByLabelText('Workflow name'), 'My flow')
    await userEvent.click(screen.getByRole('button', { name: 'Camera' }))
    await userEvent.selectOptions(screen.getByLabelText(/Camera/, { selector: 'select' }), 'cam-1')
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(post).toHaveBeenCalled())
    const [path, body] = post.mock.calls[0] as [string, { name: string; graph: { nodes: { config: unknown }[] } }]
    expect(path).toBe('/workflows')
    expect(body.name).toBe('My flow')
    expect(body.graph.nodes[0].config).toEqual({ fps: 10, camera_id: 'cam-1' })
  })

  it('shows server 422 details inline', async () => {
    vi.spyOn(api, 'patch').mockRejectedValue(
      new ApiError(422, 'workflow graph is invalid', {
        details: [{ code: 'bad_config', message: "'fps' above maximum", node_id: 'camera-1' }],
      }),
    )
    renderEditor({ workflow: wf() })
    await userEvent.clear(screen.getByLabelText('Workflow name'))
    await userEvent.type(screen.getByLabelText('Workflow name'), 'Renamed')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    const list = await screen.findByRole('list', { name: 'Validation issues' })
    expect(within(list).getByText(/Camera: 'fps' above maximum/)).toBeInTheDocument()
  })

  it('PATCHes only the changed parts (no graph => no new version)', async () => {
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({})
    renderEditor({ workflow: wf() })
    await userEvent.type(screen.getByLabelText('Description'), 'hi')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(patch).toHaveBeenCalled())
    expect(patch.mock.calls[0]).toEqual(['/workflows/w1', { description: 'hi' }])
  })

  it('is read-only for viewers', () => {
    renderEditor({ workflow: wf(), canEdit: false })
    expect(screen.getByRole('button', { name: 'Camera' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Workflow name')).toHaveAttribute('readonly')
  })
})
