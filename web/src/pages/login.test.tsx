import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LoginPage } from './login'
import { useAuth } from '@/stores/auth'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function setup() {
  const router = createMemoryRouter(
    [
      { path: '/login', element: <LoginPage /> },
      { path: '/', element: <div>dashboard</div> },
    ],
    { initialEntries: ['/login'] },
  )
  render(<RouterProvider router={router} />)
}

beforeEach(() => {
  localStorage.clear()
  useAuth.getState().clear()
  vi.stubGlobal('fetch', vi.fn())
})

describe('LoginPage', () => {
  it('validates required fields', async () => {
    setup()
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect(await screen.findByText('Email is required')).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('shows server error on bad credentials', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json(401, { error: 'invalid credentials' }))
    setup()
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.co')
    await userEvent.type(screen.getByLabelText('Password'), 'wrong')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('invalid credentials')
  })

  it('signs in and navigates home', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      json(200, {
        access_token: 'a', refresh_token: 'r',
        user: { id: '1', email: 'a@b.co', display_name: 'A', role: 'viewer', is_active: true, created_at: '', updated_at: '' },
      }),
    )
    setup()
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.co')
    await userEvent.type(screen.getByLabelText('Password'), 'secret123')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    await waitFor(() => expect(screen.getByText('dashboard')).toBeInTheDocument())
  })
})
