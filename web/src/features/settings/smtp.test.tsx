import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import type { SmtpSettings } from '@/types/api'
import { SmtpForm } from './smtp-form'
import { toSmtpUpdate, validateSmtp, type SmtpFormValues } from './smtp'

const base: SmtpFormValues = { host: 'mail.x', port: '587', username: 'u', password: '', from_addr: 'a@b.co', use_tls: true, clearPassword: false }

describe('smtp helpers', () => {
  it('validates like the server', () => {
    expect(validateSmtp(base)).toEqual({})
    expect(Object.keys(validateSmtp({ ...base, host: ' ', port: '0', from_addr: 'nope' }))).toEqual(['host', 'port', 'from_addr'])
    expect(validateSmtp({ ...base, port: '70000' }).port).toBeTruthy()
  })
  it('omits unchanged secret, clears on request, rotates when typed', () => {
    expect('password' in toSmtpUpdate(base)).toBe(false)
    expect(toSmtpUpdate({ ...base, clearPassword: true }).password).toBe('')
    expect(toSmtpUpdate({ ...base, password: 'pw' }).password).toBe('pw')
    expect(toSmtpUpdate({ ...base, port: '25' }).port).toBe(25)
  })
})

const stored: SmtpSettings = { configured: true, host: 'smtp.x', port: 465, username: 'bob', has_secret: true, from_addr: 'cam@x.io', use_tls: true, updated_at: null }

function renderForm() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <SmtpForm settings={stored} />
    </QueryClientProvider>,
  )
}

describe('SmtpForm', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('prefills, masks the secret and keeps it when untouched', async () => {
    const put = vi.spyOn(api, 'put').mockResolvedValue(stored)
    renderForm()
    expect(screen.getByLabelText('Host')).toHaveValue('smtp.x')
    expect(screen.getByLabelText('Password')).toHaveValue('')
    expect(screen.getByLabelText('Password')).toHaveAttribute('placeholder', expect.stringContaining('stored'))
    await userEvent.click(screen.getByRole('button', { name: /save smtp/i }))
    await waitFor(() => expect(put).toHaveBeenCalled())
    expect(put.mock.calls[0]).toEqual([
      '/settings/smtp',
      { host: 'smtp.x', port: 465, username: 'bob', from_addr: 'cam@x.io', use_tls: true },
    ])
  })

  it('shows validation errors and does not submit', async () => {
    const put = vi.spyOn(api, 'put')
    renderForm()
    await userEvent.clear(screen.getByLabelText('Host'))
    await userEvent.click(screen.getByRole('button', { name: /save smtp/i }))
    expect(await screen.findByText('Host is required')).toBeInTheDocument()
    expect(put).not.toHaveBeenCalled()
  })

  it('sends a new password when typed', async () => {
    const put = vi.spyOn(api, 'put').mockResolvedValue(stored)
    renderForm()
    await userEvent.type(screen.getByLabelText('Password'), 'secret')
    await userEvent.click(screen.getByRole('button', { name: /save smtp/i }))
    await waitFor(() => expect(put).toHaveBeenCalled())
    expect((put.mock.calls[0][1] as { password: string }).password).toBe('secret')
  })
})
