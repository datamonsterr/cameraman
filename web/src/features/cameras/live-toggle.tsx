import { Radio } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Small opt-in "live" switch for grid tiles. */
export function LiveToggle({ live, onChange, label }: { live: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      aria-pressed={live}
      aria-label={`${live ? 'Stop live view' : 'Start live view'}: ${label}`}
      title={live ? 'Stop live stream' : 'Live stream'}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onChange(!live)
      }}
      className={cn(
        'absolute top-1 right-1 z-10 grid size-6 place-items-center rounded bg-black/60 text-white hover:bg-black/80',
        live && 'bg-red-600/90 hover:bg-red-600',
      )}
    >
      <Radio className="size-3.5" />
    </button>
  )
}
