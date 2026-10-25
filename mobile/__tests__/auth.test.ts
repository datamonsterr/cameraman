import AsyncStorage from '@react-native-async-storage/async-storage'
import { useAuth } from '@/stores/auth'
import type { User } from '@/types/api'

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
)
jest.mock('expo-secure-store', () => {
  const m = new Map<string, string>()
  return {
    isAvailableAsync: async () => true,
    getItemAsync: async (k: string) => m.get(k) ?? null,
    setItemAsync: async (k: string, v: string) => void m.set(k, v),
    deleteItemAsync: async (k: string) => void m.delete(k),
  }
})

const user: User = {
  id: 'u1',
  email: 'v@x.io',
  display_name: 'V',
  role: 'viewer',
  is_active: true,
  created_at: '',
  updated_at: '',
}

beforeEach(() => useAuth.getState().clear())

describe('auth store', () => {
  it('starts unauthenticated', () => {
    expect(useAuth.getState().isAuthenticated()).toBe(false)
  })

  it('setSession stores user + tokens', () => {
    useAuth.getState().setSession({ access_token: 'a', refresh_token: 'r', user })
    const s = useAuth.getState()
    expect(s.accessToken).toBe('a')
    expect(s.refreshToken).toBe('r')
    expect(s.user).toEqual(user)
    expect(s.isAuthenticated()).toBe(true)
  })

  it('setTokens rotates tokens and keeps user when none given', () => {
    useAuth.getState().setSession({ access_token: 'a', refresh_token: 'r', user })
    useAuth.getState().setTokens({ access_token: 'a2', refresh_token: 'r2' })
    const s = useAuth.getState()
    expect(s.accessToken).toBe('a2')
    expect(s.refreshToken).toBe('r2')
    expect(s.user).toEqual(user)
  })

  it('clear wipes the session', () => {
    useAuth.getState().setSession({ access_token: 'a', refresh_token: 'r', user })
    useAuth.getState().clear()
    expect(useAuth.getState().user).toBeNull()
    expect(useAuth.getState().isAuthenticated()).toBe(false)
  })

  it('persists tokens to secure storage and not the hydrated flag', async () => {
    useAuth.getState().setSession({ access_token: 'a', refresh_token: 'r', user })
    await new Promise((r) => setTimeout(r, 0))
    const SecureStore = jest.requireMock('expo-secure-store')
    const raw = await SecureStore.getItemAsync('cameraman-auth')
    const parsed = JSON.parse(raw)
    expect(parsed.state.accessToken).toBe('a')
    expect(parsed.state.hydrated).toBeUndefined()
    expect(await AsyncStorage.getItem('cameraman-auth')).toBeNull()
  })
})
