import { Camera, GitBranch, LayoutDashboard, ListChecks, Settings, type LucideIcon } from 'lucide-react'

export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  end?: boolean
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/cameras', label: 'Cameras', icon: Camera },
  { to: '/workflows', label: 'Workflows', icon: GitBranch },
  { to: '/events', label: 'Events', icon: ListChecks },
  { to: '/settings', label: 'Settings', icon: Settings },
]
