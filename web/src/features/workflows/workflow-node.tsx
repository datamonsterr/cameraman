import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { AlertCircle, Camera, Code2, Mail, Box } from 'lucide-react'
import type { ComponentType } from 'react'
import { cn } from '@/lib/utils'
import { useEditorCtx } from './editor-context'

export type NodeData = { typeId: string; config: Record<string, unknown> }
export type CmNode = Node<NodeData, 'cm'>

const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  camera: Camera,
  codeblock: Code2,
  email: Mail,
}

const CATEGORY_TINT: Record<string, string> = {
  source: 'text-sky-400',
  process: 'text-violet-400',
  action: 'text-amber-400',
}

/** Port handle colors per data type; unknown types fall back to muted. */
const PORT_COLOR: Record<string, string> = {
  frame: '!bg-sky-400',
  object: '!bg-emerald-400',
  action: '!bg-amber-400',
}

export function WorkflowNode({ id, data, selected }: NodeProps<CmNode>) {
  const { registry, issues } = useEditorCtx()
  const nt = registry.get(data.typeId)
  const Icon = ICONS[data.typeId] ?? Box
  const errs = issues.get(id) ?? []
  const inputs = nt?.descriptor.inputs ?? []
  const outputs = nt?.descriptor.outputs ?? []
  const rows = Math.max(inputs.length, outputs.length, 1)

  return (
    <div
      data-testid={`node-${id}`}
      className={cn(
        'bg-card min-w-44 rounded-lg border text-xs shadow-sm',
        selected && 'ring-ring ring-2',
        errs.length > 0 && 'border-destructive',
        !nt && 'border-dashed',
      )}
    >
      <div className="flex items-center gap-1.5 border-b px-2.5 py-1.5">
        <Icon className={cn('size-3.5', CATEGORY_TINT[nt?.category ?? ''])} />
        <span className="flex-1 truncate font-medium">{nt?.title ?? data.typeId}</span>
        {errs.length > 0 && (
          <span className="text-destructive flex items-center gap-0.5" title={errs.map((e) => e.message).join('\n')}>
            <AlertCircle className="size-3.5" />
            {errs.length}
          </span>
        )}
      </div>
      <div className="text-muted-foreground relative py-1.5">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex h-5 items-center justify-between gap-4 px-2.5 text-[11px]">
            <span>{inputs[i]?.id ?? ''}</span>
            <span>{outputs[i]?.id ?? ''}</span>
          </div>
        ))}
        {inputs.map((p, i) => (
          <Handle
            key={p.id}
            id={p.id}
            type="target"
            position={Position.Left}
            title={`${p.id}: ${p.type}`}
            className={cn('!size-2.5', PORT_COLOR[p.type] ?? '!bg-muted-foreground')}
            style={{ top: 6 + i * 20 + 10 }}
          />
        ))}
        {outputs.map((p, i) => (
          <Handle
            key={p.id}
            id={p.id}
            type="source"
            position={Position.Right}
            title={`${p.id}: ${p.type}`}
            className={cn('!size-2.5', PORT_COLOR[p.type] ?? '!bg-muted-foreground')}
            style={{ top: 6 + i * 20 + 10 }}
          />
        ))}
      </div>
    </div>
  )
}
