import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api } from '@/lib/api'
import type { Landmark, NormBox } from '@/types/api'
import { fetchLandmarks } from './api'
import { LandmarkOverlay } from './landmark-overlay'
import { LandmarkPanel } from './landmark-panel'

const lm = (over: Partial<Landmark> = {}): Landmark => ({
  id: 'l1', camera_id: 'c1', name: 'door', box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, drift_threshold: 0.02, similarity_threshold: 0.7, ...over,
})

beforeEach(() => vi.restoreAllMocks())

describe('fetchLandmarks', () => {
  it('normalizes tuple boxes to objects', async () => {
    vi.spyOn(api, 'get').mockResolvedValue([{ id: 'l1', camera_id: 'c1', name: 'door', box: [0.1, 0.2, 0.3, 0.4] }])
    const out = await fetchLandmarks('c1')
    expect(api.get).toHaveBeenCalledWith('/landmarks?camera=c1')
    expect(out[0].box).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 })
  })
  it('degrades to empty on 404', async () => {
    vi.spyOn(api, 'get').mockRejectedValue(new ApiError(404, 'nope'))
    expect(await fetchLandmarks('c1')).toEqual([])
  })
  it('rethrows other errors', async () => {
    vi.spyOn(api, 'get').mockRejectedValue(new ApiError(500, 'boom'))
    await expect(fetchLandmarks('c1')).rejects.toThrow('boom')
  })
})

describe('LandmarkOverlay', () => {
  it('positions existing landmarks by percent', () => {
    render(<LandmarkOverlay landmarks={[lm()]} drawing={false} onDraw={() => {}} />)
    expect(screen.getByTestId('landmark-box-l1')).toHaveStyle({ left: '10%', top: '20%', width: '30%', height: '40%' })
  })

  it('emits a normalized box when dragging in drawing mode', () => {
    const onDraw = vi.fn()
    render(<LandmarkOverlay landmarks={[]} drawing onDraw={onDraw} />)
    const el = screen.getByTestId('landmark-overlay')
    el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) })
    fireEvent.pointerDown(el, { clientX: 50, clientY: 25, pointerId: 1 })
    fireEvent.pointerMove(el, { clientX: 150, clientY: 75, pointerId: 1 })
    fireEvent.pointerUp(el, { clientX: 150, clientY: 75, pointerId: 1 })
    expect(onDraw).toHaveBeenCalledWith({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 })
  })

  it('ignores clicks that are too small', () => {
    const onDraw = vi.fn()
    render(<LandmarkOverlay landmarks={[]} drawing onDraw={onDraw} />)
    const el = screen.getByTestId('landmark-overlay')
    el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) })
    fireEvent.pointerDown(el, { clientX: 50, clientY: 25, pointerId: 1 })
    fireEvent.pointerUp(el, { clientX: 50, clientY: 25, pointerId: 1 })
    expect(onDraw).not.toHaveBeenCalled()
  })
})

function Harness({ canOperate = true, landmarks = [] as Landmark[] }) {
  const [draft, setDraft] = useState<NormBox | null>({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 })
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  return (
    <QueryClientProvider client={qc}>
      <LandmarkPanel
        cameraId="c1"
        landmarks={landmarks}
        canOperate={canOperate}
        drawing
        onDrawingChange={() => {}}
        draft={draft}
        onDraftDone={() => setDraft(null)}
        highlight={new Set()}
      />
    </QueryClientProvider>
  )
}

describe('LandmarkPanel', () => {
  it('saves a drawn box as a named landmark in API tuple form', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({})
    render(<Harness />)
    await userEvent.type(screen.getByLabelText('Landmark name'), 'door')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(post).toHaveBeenCalled())
    expect(post.mock.calls[0]).toEqual(['/landmarks', { camera_id: 'c1', name: 'door', box: [0.1, 0.2, 0.3, 0.4] }])
  })

  it('renames and deletes existing landmarks', async () => {
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({})
    const del = vi.spyOn(api, 'delete').mockResolvedValue(undefined)
    render(<Harness landmarks={[lm()]} />)
    await userEvent.click(screen.getByRole('button', { name: 'Edit door' }))
    const name = screen.getByLabelText('Name')
    await userEvent.clear(name)
    await userEvent.type(name, 'front door')
    await userEvent.click(within(screen.getByRole('form', { name: 'Edit door' })).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/landmarks/l1', { name: 'front door' }))
    await userEvent.click(screen.getByRole('button', { name: /Delete/ }))
    await waitFor(() => expect(del).toHaveBeenCalledWith('/landmarks/l1'))
  })

  it('hides mutating controls from viewers', () => {
    render(<Harness canOperate={false} landmarks={[lm()]} />)
    expect(screen.queryByRole('button', { name: /Draw|Cancel/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit door' })).not.toBeInTheDocument()
    expect(screen.getByText('door')).toBeInTheDocument()
  })
})
