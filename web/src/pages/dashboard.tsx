import { LayoutDashboard } from 'lucide-react'
import { EmptyState, PageHeader } from '@/components/layout/page-header'

export function DashboardPage() {
  return (
    <>
      <PageHeader title="Dashboard" description="Live cameras, system health and recent events." />
      <EmptyState icon={<LayoutDashboard className="size-6" />} title="Nothing here yet" description="This section is coming soon." />
    </>
  )
}
