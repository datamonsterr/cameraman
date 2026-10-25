import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { AuthResponse, Role, TokenPair, User } from '@/types/api'

interface AuthState {
  user: User | null
  accessToken: string | null
  refreshToken: string | null
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
      partialize: (s) => ({ user: s.user, accessToken: s.accessToken, refreshToken: s.refreshToken }),
    },
  ),
)

const RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 }

/** Hierarchy: admin > operator > viewer. True if `role` meets the minimum of any allowed role. */
export function hasRole(role: Role | undefined, allowed: Role[]): boolean {
  if (!role || allowed.length === 0) return false
  const min = Math.min(...allowed.map((r) => RANK[r]))
  return RANK[role] >= min
}
