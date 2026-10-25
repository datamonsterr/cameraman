import { render, screen } from '@testing-library/react'
import { ThemeProvider } from 'next-themes'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppShell } from './app-shell'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAuth } from '@/stores/auth'

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})

beforeEach(() => {
  localStorage.clear()
  useAuth.getState().setSession({
    access_token: 'a', refresh_token: 'r',
    user: { id: '1', email: 'a@b.co', display_name: 'Ada Lovelace', role: 'admin', is_active: true, created_at: '', updated_at: '' },
  })
})

describe('AppShell', () => {
  it('renders all nav items, sidebar trigger, theme toggle and user menu', () => {
    const router = createMemoryRouter([{ element: <AppShell />, children: [{ index: true, element: <div>page</div> }] }])
    render(
      <ThemeProvider attribute="class" defaultTheme="dark">
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </ThemeProvider>,
    )
    for (const label of ['Dashboard', 'Cameras', 'Workflows', 'Events', 'Settings']) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument()
    }
    expect(screen.getAllByRole('button', { name: /toggle sidebar/i })[0]).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /switch to light theme/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /user menu/i })).toBeInTheDocument()
    expect(screen.getByText('page')).toBeInTheDocument()
  })
})
