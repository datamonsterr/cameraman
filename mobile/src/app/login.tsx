import { useState } from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput } from 'react-native'
import { login } from '@/lib/api'
import { colors } from '@/theme'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit() {
    setBusy(true)
    setErr(null)
    try {
      await login(email.trim(), password)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Login failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.wrap}>
      <Text style={styles.title}>Cameraman</Text>
      <Text style={styles.sub}>Monitor sign-in</Text>
      <TextInput
        style={styles.input}
        placeholder="Email"
        placeholderTextColor={colors.muted}
        autoCapitalize="none"
        keyboardType="email-address"
        autoComplete="email"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput
        style={styles.input}
        placeholder="Password"
        placeholderTextColor={colors.muted}
        secureTextEntry
        autoComplete="password"
        value={password}
        onChangeText={setPassword}
        onSubmitEditing={submit}
      />
      {err ? <Text style={styles.err}>{err}</Text> : null}
      <Pressable style={[styles.btn, (busy || !email || !password) && { opacity: 0.5 }]} disabled={busy || !email || !password} onPress={submit}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Sign in</Text>}
      </Pressable>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg, justifyContent: 'center', padding: 24, gap: 10 },
  title: { color: colors.text, fontSize: 28, fontWeight: '700' },
  sub: { color: colors.muted, marginBottom: 12 },
  input: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 8, color: colors.text, padding: 12, fontSize: 15 },
  err: { color: colors.danger, fontSize: 13 },
  btn: { backgroundColor: colors.accent, borderRadius: 8, padding: 13, alignItems: 'center', marginTop: 4 },
  btnText: { color: '#fff', fontWeight: '600' },
})
