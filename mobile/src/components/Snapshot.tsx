import { useEffect, useState } from 'react'
import { Image, StyleSheet, View, type ViewStyle } from 'react-native'
import { snapshotSource } from '@/lib/api'
import { colors } from '@/theme'

/** Polls the camera snapshot endpoint every `intervalMs` (v1 monitor path; HLS later). */
export function Snapshot({ cameraId, intervalMs = 4000, style }: { cameraId: string; intervalMs?: number; style?: ViewStyle }) {
  const [tick, setTick] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return (
    <View style={[styles.box, style]}>
      <Image source={snapshotSource(cameraId, tick)} style={StyleSheet.absoluteFill} resizeMode="cover" />
    </View>
  )
}

const styles = StyleSheet.create({ box: { backgroundColor: colors.surface, overflow: 'hidden' } })
