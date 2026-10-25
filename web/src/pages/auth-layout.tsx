import { Aperture } from 'lucide-react'
import type { ReactNode } from 'react'

export function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle: string; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="grid min-h-svh place-items-center p-4">
      <div className="w-full max-w-sm space-y-5">
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="bg-primary text-primary-foreground grid size-9 place-items-center rounded-lg">
            <Aperture className="size-5" />
          </div>
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          <p className="text-muted-foreground text-xs">{subtitle}</p>
        </div>
        <div className="bg-card rounded-xl border p-5 shadow-sm">{children}</div>
        <p className="text-muted-foreground text-center text-xs">{footer}</p>
      </div>
    </div>
  )
}
