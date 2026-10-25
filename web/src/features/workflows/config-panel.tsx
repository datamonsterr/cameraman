import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ChipInput } from '@/components/ui/chip-input'
import { NativeSelect } from '@/components/ui/native-select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import type { Camera, GraphIssue, JsonSchemaProp, NodeType } from '@/types/api'
import { CodeEditor } from './code-editor'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const LONG_TEXT = new Set(['body', 'description'])

/** Issues whose message quotes this config key, e.g. "missing required config 'code'". */
export function issuesForField(issues: GraphIssue[], key: string): GraphIssue[] {
  return issues.filter((i) => i.message.includes(`'${key}'`))
}

export function ConfigPanel({
  nodeId,
  nodeType,
  typeId,
  config,
  cameras,
  issues,
  readOnly,
  onChange,
}: {
  nodeId: string
  nodeType: NodeType | undefined
  typeId: string
  config: Record<string, unknown>
  cameras: Camera[]
  issues: GraphIssue[]
  readOnly: boolean
  onChange: (config: Record<string, unknown>) => void
}) {
  if (!nodeType) {
    return <p className="text-destructive text-xs">Unknown node type '{typeId}'. It is not in the registry.</p>
  }
  const schema = nodeType.descriptor.config
  const required = new Set(schema.required ?? [])
  const set = (key: string, v: unknown) => {
    const next = { ...config }
    if (v === undefined) delete next[key]
    else next[key] = v
    onChange(next)
  }

  return (
    <div className="grid gap-3" aria-label={`${nodeType.title} configuration`}>
      <div>
        <p className="text-sm font-medium">{nodeType.title}</p>
        <p className="text-muted-foreground text-[11px]">
          {nodeId} · {nodeType.category}
        </p>
      </div>
      {Object.entries(schema.properties ?? {}).map(([key, spec]) => (
        <Field
          key={key}
          name={key}
          spec={spec}
          required={required.has(key)}
          value={config[key]}
          cameras={cameras}
          errors={issuesForField(issues, key)}
          readOnly={readOnly}
          onChange={(v) => set(key, v)}
        />
      ))}
    </div>
  )
}

function Field({
  name,
  spec,
  required,
  value,
  cameras,
  errors,
  readOnly,
  onChange,
}: {
  name: string
  spec: JsonSchemaProp
  required: boolean
  value: unknown
  cameras: Camera[]
  errors: GraphIssue[]
  readOnly: boolean
  onChange: (v: unknown) => void
}) {
  const id = `cfg-${name}`
  const label = spec.title ?? name

  let control
  if (name === 'camera_id') {
    const v = typeof value === 'string' ? value : ''
    const known = cameras.some((c) => c.id === v)
    control = (
      <NativeSelect id={id} className="w-full" value={v} disabled={readOnly} aria-invalid={errors.length > 0} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">Select a camera…</option>
        {v && !known && <option value={v}>Unknown camera ({v.slice(0, 8)})</option>}
        {cameras.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
            {c.status !== 'online' ? ` (${c.status})` : ''}
          </option>
        ))}
      </NativeSelect>
    )
  } else if (spec.format === 'python') {
    control = <CodeEditor value={typeof value === 'string' ? value : ''} onChange={(v) => onChange(v)} readOnly={readOnly} />
  } else if (spec.type === 'array') {
    const isEmail = spec.items?.format === 'email'
    control = (
      <ChipInput
        id={id}
        value={Array.isArray(value) ? value.map(String) : []}
        disabled={readOnly}
        placeholder={isEmail ? 'name@example.com, press Enter' : 'Add item, press Enter'}
        validate={isEmail ? (v) => EMAIL_RE.test(v) : undefined}
        onChange={(v) => onChange(v)}
      />
    )
  } else if (spec.type === 'integer' || spec.type === 'number') {
    control = (
      <Input
        id={id}
        type="number"
        min={spec.minimum}
        max={spec.maximum}
        step={spec.type === 'integer' ? 1 : 'any'}
        value={typeof value === 'number' ? value : ''}
        disabled={readOnly}
        aria-invalid={errors.length > 0}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      />
    )
  } else if (spec.type === 'boolean') {
    control = <Switch id={id} checked={value === true} disabled={readOnly} onCheckedChange={onChange} />
  } else if (LONG_TEXT.has(name)) {
    control = (
      <Textarea id={id} rows={4} value={typeof value === 'string' ? value : ''} disabled={readOnly} onChange={(e) => onChange(e.target.value)} />
    )
  } else {
    control = (
      <Input
        id={id}
        value={typeof value === 'string' ? value : ''}
        disabled={readOnly}
        aria-invalid={errors.length > 0}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  }

  return (
    <div className="grid gap-1">
      <Label htmlFor={id} className="text-xs">
        {label}
        {required && <span className="text-destructive">*</span>}
      </Label>
      {control}
      {spec.description && <p className="text-muted-foreground text-[11px]">{spec.description}</p>}
      {errors.map((e, i) => (
        <p key={i} role="alert" className="text-destructive text-[11px]">
          {e.message}
        </p>
      ))}
    </div>
  )
}
