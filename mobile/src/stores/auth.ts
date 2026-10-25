import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { secureStorage } from '@/lib/storage'
import type { AuthResponse, TokenPair, User } from '@/types/api'

interface AuthState {
  user: User | null
  accessToken: string | null
  refreshToken: string | null
  /** True once persisted state has been loaded from storage. */
  hydrated: boolean
  setSession: (s: AuthResponse) => void
  setTokens: (t: TokenPair, user?: User) => void
  clear: () => void
  isAuthenticated: () => boolean
}

export const useAuth = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      hydrated: false,
      setSession: (s) =>
        set({ user: s.user, accessToken: s.access_token, refreshToken: s.refresh_token }),
      setTokens: (t, user) =>
        set((st) => ({
          accessToken: t.access_token,
          refreshToken: t.refresh_token,
          user: user ?? st.user,
        })),
      clear: () => set({ user: null, accessToken: null, refreshToken: null }),
      isAuthenticated: () => get().accessToken !== null,
    }),
    {
      name: 'cameraman-auth',
      storage: createJSONStorage(() => secureStorage),
      partialize: (s) => ({ user: s.user, accessToken: s.accessToken, refreshToken: s.refreshToken }),
      onRehydrateStorage: () => () => {
        useAuth.setState({ hydrated: true })
      },
    },
  ),
)
