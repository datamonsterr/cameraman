import { useQuery } from '@tanstack/react-query'
import { FlatList, RefreshControl, StyleSheet, Text } from 'react-native'
import { EventRow } from '@/components/EventRow'
import { listCameras, listEvents } from '@/lib/api'
import { colors } from '@/theme'

export default function Events() {
  const events = useQuery({ queryKey: ['events'], queryFn: () => listEvents({ limit: 100 }), refetchInterval: 15000 })
  const cams = useQuery({ queryKey: ['cameras'], queryFn: listCameras })
  const names = new Map((cams.data ?? []).map((c) => [c.id, c.name]))
  const sorted = [...(events.data ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at))

  return (
    <FlatList
      style={{ backgroundColor: colors.bg }}
      data={sorted}
      keyExtractor={(e) => String(e.id)}
      refreshControl={<RefreshControl refreshing={events.isRefetching} onRefresh={async () => { await events.refetch() }} tintColor={colors.accent} />}
      ListEmptyComponent={<Text style={styles.empty}>{events.isLoading ? 'Loading…' : events.isError ? 'Could not load events' : 'No events yet'}</Text>}
      renderItem={({ item }) => <EventRow event={item} cameraName={item.camera_id ? names.get(item.camera_id) : undefined} />}
    />
  )
}

const styles = StyleSheet.create({ empty: { color: colors.muted, textAlign: 'center', marginTop: 40 } })
