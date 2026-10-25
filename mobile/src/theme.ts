export const colors = {
  bg: '#0b0d10',
  surface: '#14181d',
  border: '#232a32',
  text: '#e6e9ed',
  muted: '#8b95a1',
  accent: '#3b82f6',
  ok: '#22c55e',
  warn: '#f59e0b',
  danger: '#ef4444',
}

export const statusColor = (s: string) =>
  s === 'online' ? colors.ok : s === 'connecting' || s === 'discovered' ? colors.warn : colors.danger

export const severityColor = (s: string) =>
  s === 'alert' ? colors.danger : s === 'warn' ? colors.warn : colors.muted

export function timeAgo(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return new Date(iso).toLocaleDateString()
}
