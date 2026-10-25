import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it } from 'vitest'
import { RequireAuth, RequireRole } from './guards'
import { useAuth } from '@/stores/auth'
import type { Role } from '@/types/api'

function signIn(role: Role) {
  useAuth.getState().setSession({
    access_token: 'a', refresh_token: 'r',
    user: { id: '1', email: 'e@e.e', display_name: 'E', role, is_active: true, created_at: '', updated_at: '' },
  })
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<div>login page</div>} />
        <Route element={<RequireAuth />}>
          <Route path="/home" element={<div>home</div>} />
          <Route element={<RequireRole roles={['admin']} />}>
            <Route path="/admin" element={<div>admin area</div>} />
          </Route>
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  localStorage.clear()
  useAuth.getState().clear()
})

describe('RequireAuth', () => {
  it('redirects anonymous users to /login', () => {
    renderAt('/home')
    expect(screen.getByText('login page')).toBeInTheDocument()
  })
  it('renders children when signed in', () => {
    signIn('viewer')
    renderAt('/home')
    expect(screen.getByText('home')).toBeInTheDocument()
  })
})

describe('RequireRole', () => {
  it('blocks insufficient roles', () => {
    signIn('operator')
    renderAt('/admin')
    expect(screen.queryByText('admin area')).not.toBeInTheDocument()
    expect(screen.getByText(/not authorized/i)).toBeInTheDocument()
  })
  it('allows admin', () => {
    signIn('admin')
    renderAt('/admin')
    expect(screen.getByText('admin area')).toBeInTheDocument()
  })
})
