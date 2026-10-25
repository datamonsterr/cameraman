import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { listCameras } from '@/lib/api'
import { Snapshot } from '@/components/Snapshot'
import { colors, statusColor } from '@/theme'

export default function Cameras() {
  const router = useRouter()
  const q = useQuery({ queryKey: ['cameras'], queryFn: listCameras, refetchInterval: 15000 })
  // Grid shows connected cameras only (snapshot is only available while online).
  const cams = (q.data ?? []).filter((c) => c.status === 'online')

  return (
    <FlatList
      style={{ backgroundColor: colors.bg }}
      contentContainerStyle={styles.list}
      columnWrapperStyle={{ gap: 8 }}
      numColumns={2}
      data={cams}
      keyExtractor={(c) => c.id}
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={async () => { await q.refetch() }} tintColor={colors.accent} />}
      ListEmptyComponent={
        <Text style={styles.empty}>{q.isLoading ? 'Loading…' : q.isError ? 'Could not load cameras' : 'No connected cameras'}</Text>
      }
      renderItem={({ item }) => (
        <Pressable style={styles.tile} onPress={() => router.push({ pathname: '/camera/[id]', params: { id: item.id } })}>
          <Snapshot cameraId={item.id} style={styles.thumb} />
          <View style={styles.meta}>
            <View style={[styles.dot, { backgroundColor: statusColor(item.status) }]} />
            <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
            <Text style={styles.status}>{item.status}</Text>
          </View>
        </Pressable>
      )}
    />
  )
}

const styles = StyleSheet.create({
  list: { padding: 8, gap: 8 },
  tile: { flex: 1, backgroundColor: colors.surface, borderRadius: 8, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  thumb: { aspectRatio: 16 / 9, width: '100%' },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6, padding: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  name: { color: colors.text, fontSize: 13, fontWeight: '600', flex: 1 },
  status: { color: colors.muted, fontSize: 11 },
  empty: { color: colors.muted, textAlign: 'center', marginTop: 40 },
})
