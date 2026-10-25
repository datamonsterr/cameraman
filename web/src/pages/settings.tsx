import { Settings } from 'lucide-react'
import { EmptyState, PageHeader } from '@/components/layout/page-header'

export function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" description="SMTP, users, models and audit log." />
      <EmptyState icon={<Settings className="size-6" />} title="Nothing here yet" description="This section is coming soon." />
    </>
  )
}
