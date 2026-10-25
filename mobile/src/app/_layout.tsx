import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as Notifications from 'expo-notifications'
import { Stack, useRouter, useSegments } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useEffect, useState } from 'react'
import { ActivityIndicator, View } from 'react-native'
import { registerForPush, targetFromData } from '@/lib/push'
import { useAuth } from '@/stores/auth'
import { colors } from '@/theme'

function useAuthGate() {
  const hydrated = useAuth((s) => s.hydrated)
  const authed = useAuth((s) => s.accessToken !== null)
  const segments = useSegments()
  const router = useRouter()
  useEffect(() => {
    if (!hydrated) return
    const onLogin = segments[0] === 'login'
    if (!authed && !onLogin) router.replace('/login')
    else if (authed && onLogin) router.replace('/')
  }, [hydrated, authed, segments, router])
  return hydrated
}

function usePush() {
  const authed = useAuth((s) => s.accessToken !== null)
  const router = useRouter()
  useEffect(() => {
    if (authed) void registerForPush()
  }, [authed])
  useEffect(() => {
    if (!authed) return
    const go = (n: Notifications.Notification) => {
      const t = targetFromData(n.request.content.data)
      if (t) router.push(t)
    }
    const last = Notifications.getLastNotificationResponse()
    if (last?.notification) go(last.notification)
    const sub = Notifications.addNotificationResponseReceivedListener((r) => go(r.notification))
    return () => sub.remove()
  }, [authed, router])
}

export default function RootLayout() {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 5000 } } }))
  const ready = useAuthGate()
  usePush()
  return (
    <QueryClientProvider client={qc}>
      <StatusBar style="light" />
      {ready ? (
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.surface },
            headerTintColor: colors.text,
            contentStyle: { backgroundColor: colors.bg },
          }}
        >
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="login" options={{ headerShown: false }} />
          <Stack.Screen name="camera/[id]" options={{ title: 'Camera' }} />
        </Stack>
      ) : (
        <View style={{ flex: 1, backgroundColor: colors.bg, justifyContent: 'center' }}>
          <ActivityIndicator color={colors.accent} />
        </View>
      )}
    </QueryClientProvider>
  )
}
