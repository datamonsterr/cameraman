import { Tabs } from 'expo-router'
import { colors } from '@/theme'

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.text,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.muted,
        tabBarIconStyle: { display: 'none' },
        tabBarLabelStyle: { fontSize: 13, marginBottom: 12 },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Cameras' }} />
      <Tabs.Screen name="events" options={{ title: 'Events' }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
    </Tabs>
  )
}
