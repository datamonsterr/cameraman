import { Pressable, StyleSheet, Text, View } from 'react-native'
import { logout } from '@/lib/api'
import { useAuth } from '@/stores/auth'
import { colors } from '@/theme'

export default function Settings() {
  const user = useAuth((s) => s.user)
  return (
    <View style={styles.wrap}>
      <View style={styles.card}>
        <Text style={styles.label}>Signed in as</Text>
        <Text style={styles.value}>{user?.display_name ?? '—'}</Text>
        <Text style={styles.sub}>{user?.email}</Text>
        <Text style={styles.sub}>Role: {user?.role}</Text>
      </View>
      <Pressable style={styles.btn} onPress={() => void logout()}>
        <Text style={styles.btnText}>Log out</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg, padding: 12, gap: 12 },
  card: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 8, padding: 14, gap: 2 },
  label: { color: colors.muted, fontSize: 12 },
  value: { color: colors.text, fontSize: 17, fontWeight: '600' },
  sub: { color: colors.muted, fontSize: 13 },
  btn: { borderColor: colors.danger, borderWidth: 1, borderRadius: 8, padding: 12, alignItems: 'center' },
  btnText: { color: colors.danger, fontWeight: '600' },
})
