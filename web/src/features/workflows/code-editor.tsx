import { lazy, Suspense } from 'react'
import { Skeleton } from '@/components/ui/skeleton'

const Monaco = lazy(() => import('@monaco-editor/react'))

/** Monaco Python editor, loaded on demand. */
export function CodeEditor({
  value,
  onChange,
  readOnly,
  height = 280,
}: {
  value: string
  onChange: (v: string) => void
  readOnly?: boolean
  height?: number
}) {
  return (
    <Suspense fallback={<Skeleton style={{ height }} />}>
      <div className="overflow-hidden rounded-md border" data-testid="code-editor">
        <Monaco
          height={height}
          language="python"
          theme="vs-dark"
          value={value}
          onChange={(v) => onChange(v ?? '')}
          options={{
            readOnly,
            minimap: { enabled: false },
            fontSize: 12,
            scrollBeyondLastLine: false,
            tabSize: 4,
            automaticLayout: true,
          }}
        />
      </div>
    </Suspense>
  )
}
