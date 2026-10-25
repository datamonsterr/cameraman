import { beforeEach, describe, expect, it, vi } from 'vitest'
import { register } from './actions'
import { api } from '@/lib/api'
import { useAuth } from '@/stores/auth'

const user = { id: '1', email: 'a@b.co', display_name: 'A', role: 'viewer', is_active: true, created_at: '', updated_at: '' }

beforeEach(() => {
  localStorage.clear()
  useAuth.getState().clear()
  vi.restoreAllMocks()
})

describe('register', () => {
  it('registers, then logs in and stores the session', async () => {
    const post = vi
      .spyOn(api, 'post')
      .mockResolvedValueOnce(user)
      .mockResolvedValueOnce({ access_token: 'acc', refresh_token: 'ref', user })
    await register({ display_name: 'A', email: 'a@b.co', password: 'password1' })
    expect(post.mock.calls[0][0]).toBe('/auth/register')
    expect(post.mock.calls[1]).toEqual(['/auth/login', { email: 'a@b.co', password: 'password1' }, { auth: false }])
    expect(useAuth.getState().accessToken).toBe('acc')
    expect(useAuth.getState().user?.email).toBe('a@b.co')
  })

  it('does not log in when register fails', async () => {
    const post = vi.spyOn(api, 'post').mockRejectedValueOnce(new Error('email taken'))
    await expect(register({ display_name: 'A', email: 'a@b.co', password: 'password1' })).rejects.toThrow('email taken')
    expect(post).toHaveBeenCalledTimes(1)
    expect(useAuth.getState().accessToken).toBeNull()
  })
})
