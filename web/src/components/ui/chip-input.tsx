import { X } from 'lucide-react'
import { useState, type KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'

/** Free-text chips: Enter / comma / blur adds, Backspace on empty removes the last. */
export function ChipInput({
  value,
  onChange,
  placeholder,
  disabled,
  validate,
  id,
  'aria-label': ariaLabel,
  className,
}: {
  value: string[]
  onChange: (v: string[]) => void
  placeholder?: string
  disabled?: boolean
  validate?: (v: string) => boolean
  id?: string
  'aria-label'?: string
  className?: string
}) {
  const [draft, setDraft] = useState('')

  function commit() {
    const v = draft.trim().replace(/,$/, '').trim()
    setDraft('')
    if (v && !value.includes(v)) onChange([...value, v])
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      commit()
    } else if (e.key === 'Backspace' && !draft && value.length) {
      onChange(value.slice(0, -1))
    }
  }

  return (
    <div
      className={cn(
        'border-input dark:bg-input/30 flex min-h-8 flex-wrap items-center gap-1 rounded-md border bg-transparent px-1.5 py-1 shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50',
        disabled && 'opacity-60',
        className,
      )}
    >
      {value.map((v) => (
        <span
          key={v}
          className={cn(
            'bg-secondary inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]',
            validate && !validate(v) && 'bg-destructive/20 text-destructive',
          )}
        >
          {v}
          {!disabled && (
            <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((x) => x !== v))}>
              <X className="size-3" />
            </button>
          )}
        </span>
      ))}
      <input
        id={id}
        aria-label={ariaLabel}
        className="min-w-24 flex-1 bg-transparent px-1 text-xs outline-none"
        value={draft}
        disabled={disabled}
        placeholder={value.length ? '' : placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        onBlur={commit}
      />
    </div>
  )
}
