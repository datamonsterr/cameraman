import { useState } from 'react'
import { NativeSelect } from '@/components/ui/native-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatDateTime } from '@/lib/time'
import { useAudit } from './api'

export function AuditSection() {
  const [limit, setLimit] = useState(100)
  const { data, isLoading, error } = useAudit(limit)
  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-xs">Most recent administrative actions.</p>
        <NativeSelect aria-label="Rows" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
          {[50, 100, 250, 500].map((n) => (
            <option key={n} value={n}>
              {n} rows
            </option>
          ))}
        </NativeSelect>
      </div>
      {isLoading ? (
        <Skeleton className="h-40" />
      ) : error ? (
        <p role="alert" className="text-destructive text-sm">{error.message}</p>
      ) : data === null || data === undefined ? (
        <p className="text-muted-foreground rounded-lg border border-dashed p-4 text-xs">The audit log is not available on this server yet.</p>
      ) : data.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border border-dashed p-4 text-center text-xs">No audit entries.</p>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="text-muted-foreground text-xs whitespace-nowrap">{formatDateTime(a.created_at)}</TableCell>
                  <TableCell className="font-mono text-xs">{a.action}</TableCell>
                  <TableCell className="max-w-40 truncate text-xs">{a.target ?? '-'}</TableCell>
                  <TableCell className="text-muted-foreground max-w-28 truncate font-mono text-[11px]">{a.actor_id?.slice(0, 8) ?? 'system'}</TableCell>
                  <TableCell className="text-muted-foreground max-w-64 truncate font-mono text-[11px]" title={a.detail ? JSON.stringify(a.detail) : undefined}>
                    {a.detail ? JSON.stringify(a.detail) : '-'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
