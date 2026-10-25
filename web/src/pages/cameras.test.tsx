import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { useAuth } from '@/stores/auth'
import { makeCamera } from '@/test/fixtures'
import type { Role } from '@/types/api'
import { CamerasPage } from './cameras'

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), blob: vi.fn() },
}))

function login(role: Role) {
  useAuth.getState().setSession({
    access_token: 'a', refresh_token: 'r',
    user: { id: '1', email: 'a@b.co', display_name: 'A', role, is_active: true, created_at: '', updated_at: '' },
  })
}

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <CamerasPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  URL.createObjectURL = vi.fn(() => 'blob:x')
  URL.revokeObjectURL = vi.fn()
  vi.mocked(api.blob).mockResolvedValue(new Blob(['x']))
})

describe('CamerasPage', () => {
  it('shows the empty state', async () => {
    login('operator')
    vi.mocked(api.get).mockResolvedValue([])
    setup()
    expect(await screen.findByText('No cameras yet')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /scan lan/i })).toBeInTheDocument()
  })

  it('renders saved cameras with edit/delete for operators', async () => {
    login('operator')
    vi.mocked(api.get).mockResolvedValue([makeCamera(), makeCamera({ id: 'c2', name: 'Garage', status: 'error', status_reason: 'timeout' })])
    setup()
    expect(await screen.findByText('Front door')).toBeInTheDocument()
    expect(screen.getByText('Garage')).toBeInTheDocument()
    expect(screen.getByText('timeout')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit Front door' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete Garage' })).toBeInTheDocument()
  })

  it('hides all mutation controls for viewers', async () => {
    login('viewer')
    vi.mocked(api.get).mockResolvedValue([makeCamera()])
    setup()
    expect(await screen.findByText('Front door')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /scan lan/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /add camera/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /edit front door/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /delete front door/i })).not.toBeInTheDocument()
  })
})
