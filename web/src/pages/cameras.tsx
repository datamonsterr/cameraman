import { Camera } from 'lucide-react'
import { EmptyState, PageHeader } from '@/components/layout/page-header'

export function CamerasPage() {
  return (
    <>
      <PageHeader title="Cameras" description="Discover, connect and manage cameras." />
      <EmptyState icon={<Camera className="size-6" />} title="Nothing here yet" description="This section is coming soon." />
    </>
  )
}
