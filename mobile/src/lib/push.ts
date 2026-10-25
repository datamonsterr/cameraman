import Constants from 'expo-constants'
import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'
import { registerDevice } from './api'

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: false,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
})

export type PushTarget = { pathname: '/camera/[id]'; params: { id: string } } | { pathname: '/events' }

/**
 * Map a notification payload to an in-app route. Expected server payload:
 * `{ camera_id?: string, event_id?: number }`. Camera alerts open that camera, else the feed.
 */
export function targetFromData(data: unknown): PushTarget | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (typeof d.camera_id === 'string' && d.camera_id) {
    return { pathname: '/camera/[id]', params: { id: d.camera_id } }
  }
  if (d.event_id !== undefined) return { pathname: '/events' }
  return null
}

/** Ask permission, get an Expo push token, and hand it to the backend. Returns the token or null. */
export async function registerForPush(): Promise<string | null> {
  try {
    if (Platform.OS === 'web') return null
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('alerts', {
        name: 'Alerts',
        importance: 6, // AndroidImportance.HIGH
      })
    }
    let { status } = await Notifications.getPermissionsAsync()
    if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status
    if (status !== 'granted') return null
    const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId
    if (!projectId) return null // needs an EAS project; skipped in plain dev builds
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId })
    await registerDevice({ token, platform: Platform.OS === 'ios' ? 'ios' : 'android' })
    return token
  } catch {
    return null
  }
}
