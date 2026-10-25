import { useQuery } from '@tanstack/react-query'
import { Stack, useLocalSearchParams } from 'expo-router'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { EventRow } from '@/components/EventRow'
import { Snapshot } from '@/components/Snapshot'
import { getCamera, listEvents } from '@/lib/api'
import { colors, statusColor } from '@/theme'

export default function CameraView() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const cam = useQuery({ queryKey: ['camera', id], queryFn: () => getCamera(id), refetchInterval: 15000 })
  const ev = useQuery({ queryKey: ['events', id], queryFn: () => listEvents({ camera_id: id, limit: 20 }), refetchInterval: 10000 })
  const events = [...(ev.data ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at))

  return (
    <ScrollView style={{ backgroundColor: colors.bg }}>
      <Stack.Screen options={{ title: cam.data?.name ?? 'Camera' }} />
      <Snapshot cameraId={id} intervalMs={2000} style={styles.hero} />
      <View style={styles.meta}>
        <View style={[styles.dot, { backgroundColor: statusColor(cam.data?.status ?? 'offline') }]} />
        <Text style={styles.status}>{cam.data?.status ?? '…'}</Text>
        {cam.data?.width ? <Text style={styles.sub}>{cam.data.width}×{cam.data.height} {cam.data.codec ?? ''}</Text> : null}
      </View>
      <Text style={styles.h}>Recent events</Text>
      {events.length === 0 ? <Text style={styles.sub2}>No recent events</Text> : events.map((e) => <EventRow key={e.id} event={e} />)}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  hero: { width: '100%', aspectRatio: 16 / 9 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  status: { color: colors.text, fontWeight: '600' },
  sub: { color: colors.muted, marginLeft: 'auto', fontSize: 12 },
  h: { color: colors.muted, fontSize: 12, textTransform: 'uppercase', paddingHorizontal: 12, paddingTop: 8 },
  sub2: { color: colors.muted, padding: 12 },
})
