import { GitBranch } from 'lucide-react'
import { EmptyState, PageHeader } from '@/components/layout/page-header'

export function WorkflowsPage() {
  return (
    <>
      <PageHeader title="Workflows" description="Build and run detection workflows." />
      <EmptyState icon={<GitBranch className="size-6" />} title="Nothing here yet" description="This section is coming soon." />
    </>
  )
}
