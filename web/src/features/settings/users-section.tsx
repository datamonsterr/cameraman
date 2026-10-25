import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useUsers } from './api'

export function UsersSection() {
  const { data, isLoading, error } = useUsers()
  if (isLoading) return <Skeleton className="h-40" />
  if (error) return <p role="alert" className="text-destructive text-sm">{error.message}</p>
  if (!data) {
    return (
      <div className="rounded-lg border border-dashed p-4 text-xs">
        <p className="font-medium">User management is coming soon</p>
        <p className="text-muted-foreground mt-1">This server does not expose the users API yet. New accounts start as viewers.</p>
      </div>
    )
  }
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((u) => (
            <TableRow key={u.id}>
              <TableCell className="text-xs">{u.display_name}</TableCell>
              <TableCell className="text-xs">{u.email}</TableCell>
              <TableCell>
                <Badge variant="outline" className="capitalize">{u.role}</Badge>
              </TableCell>
              <TableCell className="text-muted-foreground text-xs">{u.is_active ? 'Active' : 'Disabled'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
