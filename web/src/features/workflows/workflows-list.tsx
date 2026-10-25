import { GitBranch, Plus } from 'lucide-react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { EmptyState, PageHeader } from '@/components/layout/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useCanOperate } from '@/hooks/use-can-operate'
import { timeAgo } from '@/lib/time'
import { useSetEnabled, useWorkflows } from './api'

export function WorkflowsList() {
  const canOperate = useCanOperate()
  const { data, isLoading, error } = useWorkflows()
  const toggle = useSetEnabled()

  async function onToggle(id: string, enabled: boolean) {
    try {
      await toggle.mutateAsync({ id, enabled })
      toast.success(enabled ? 'Workflow enabled' : 'Workflow disabled')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not change workflow state')
    }
  }

  return (
    <>
      <PageHeader
        title="Workflows"
        description="Build and run detection workflows."
        actions={
          canOperate && (
            <Button size="sm" variant="outline" asChild>
              <Link to="/workflows/new">
                <Plus />
                New workflow
              </Link>
            </Button>
          )
        }
      />
      {isLoading ? (
        <Skeleton className="h-32" />
      ) : error ? (
        <p role="alert" className="text-destructive text-sm">
          {error.message}
        </p>
      ) : data && data.length > 0 ? (
        <ul className="divide-y rounded-lg border">
          {data.map((w) => (
            <li key={w.id} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <Link to={`/workflows/${w.id}`} className="truncate text-sm font-medium hover:underline">
                  {w.name}
                </Link>
                {w.description && <p className="text-muted-foreground truncate text-xs">{w.description}</p>}
              </div>
              {w.active_version != null && <Badge variant="outline">v{w.active_version}</Badge>}
              <span className="text-muted-foreground hidden w-16 text-right text-[11px] sm:block">{timeAgo(w.updated_at)}</span>
              <Switch
                aria-label={`${w.enabled ? 'Disable' : 'Enable'} ${w.name}`}
                checked={w.enabled}
                disabled={!canOperate || toggle.isPending}
                onCheckedChange={(v) => void onToggle(w.id, v)}
              />
              <Button size="xs" variant="ghost" asChild>
                <Link to={`/workflows/${w.id}`}>{canOperate ? 'Edit' : 'View'}</Link>
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          icon={<GitBranch className="size-6" />}
          title="No workflows yet"
          description={canOperate ? 'Create a workflow to wire cameras to code blocks and notifications.' : 'No workflows have been created.'}
        />
      )}
    </>
  )
}
