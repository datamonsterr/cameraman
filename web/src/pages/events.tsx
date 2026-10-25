import { ListChecks } from 'lucide-react'
import { EmptyState, PageHeader } from '@/components/layout/page-header'

export function EventsPage() {
  return (
    <>
      <PageHeader title="Events" description="Timeline of detections, notifications and health." />
      <EmptyState icon={<ListChecks className="size-6" />} title="Nothing here yet" description="This section is coming soon." />
    </>
  )
}
