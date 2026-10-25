import { StyleSheet, Text, View } from 'react-native'
import type { CameraEvent } from '@/types/api'
import { colors, severityColor, timeAgo } from '@/theme'

export function EventRow({ event, cameraName }: { event: CameraEvent; cameraName?: string }) {
  return (
    <View style={styles.row}>
      <View style={[styles.bar, { backgroundColor: severityColor(event.severity) }]} />
      <View style={{ flex: 1 }}>
        <View style={styles.head}>
          <Text style={styles.kind}>{event.kind}</Text>
          <Text style={[styles.sev, { color: severityColor(event.severity) }]}>{event.severity}</Text>
          <Text style={styles.time}>{timeAgo(event.created_at)}</Text>
        </View>
        {cameraName ? <Text style={styles.cam}>{cameraName}</Text> : null}
        {event.message ? <Text style={styles.msg}>{event.message}</Text> : null}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 10, padding: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  bar: { width: 3, borderRadius: 2 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  kind: { color: colors.text, fontWeight: '600', fontSize: 14, textTransform: 'capitalize' },
  sev: { fontSize: 11, textTransform: 'uppercase', fontWeight: '600' },
  time: { color: colors.muted, fontSize: 12, marginLeft: 'auto' },
  cam: { color: colors.accent, fontSize: 12, marginTop: 2 },
  msg: { color: colors.muted, fontSize: 13, marginTop: 2 },
})
