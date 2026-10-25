import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'

export function NotFoundPage() {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
      <p className="text-4xl font-semibold tracking-tight">404</p>
      <p className="text-muted-foreground text-sm">That page does not exist.</p>
      <Button asChild size="sm">
        <Link to="/">Back to dashboard</Link>
      </Button>
    </div>
  )
}
