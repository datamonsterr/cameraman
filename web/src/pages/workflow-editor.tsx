import { ArrowLeft } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import { Skeleton } from '@/components/ui/skeleton'
import { useNodeTypes, useWorkflow } from '@/features/workflows/api'
import { WorkflowEditor } from '@/features/workflows/workflow-editor'
import { useCanOperate } from '@/hooks/use-can-operate'

export function WorkflowEditorPage() {
  const { id } = useParams()
  const canOperate = useCanOperate()
  const types = useNodeTypes()
  const wf = useWorkflow(id)
  const isNew = !id

  let body
  if (types.isLoading || (!isNew && wf.isLoading)) body = <Skeleton className="h-96" />
  else if (types.error) {
    body = <p role="alert" className="text-destructive text-sm">Could not load node types: {types.error.message}</p>
  } else if (!isNew && (wf.error || !wf.data)) {
    body = <p role="alert" className="text-destructive text-sm">{wf.error?.message ?? 'Workflow not found'}</p>
  } else {
    body = (
      <WorkflowEditor
        key={wf.data?.id ?? 'new'}
        workflow={wf.data}
        nodeTypes={types.data ?? []}
        canEdit={canOperate}
      />
    )
  }

  return (
    <>
      <Link to="/workflows" className="text-muted-foreground hover:text-foreground mb-2 inline-flex items-center gap-1 text-xs">
        <ArrowLeft className="size-3" /> Workflows
      </Link>
      {body}
    </>
  )
}
