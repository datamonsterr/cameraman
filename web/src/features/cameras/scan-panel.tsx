import { Radar } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { Candidate } from '@/types/api'
import { useScan } from './api'
import { ConnectDialog } from './connect-dialog'

export function ScanPanel({ knownHosts }: { knownHosts: Set<string> }) {
  const scan = useScan()
  const [cidr, setCidr] = useState('')
  const [target, setTarget] = useState<Candidate | null>(null)
  const candidates = scan.data?.candidates

  async function run() {
    try {
      const res = await scan.mutateAsync(cidr.trim() || undefined)
      toast.success(`Scan found ${res.candidates.length} candidate${res.candidates.length === 1 ? '' : 's'}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Scan failed')
    }
  }

  return (
    <section className="mb-5 rounded-lg border p-3" aria-label="LAN scan">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={run} disabled={scan.isPending}>
          <Radar />
          {scan.isPending ? 'Scanning…' : 'Scan LAN'}
        </Button>
        <Input
          className="h-8 w-44 text-xs"
          placeholder="CIDR (optional) 192.168.1.0/24"
          aria-label="CIDR"
          value={cidr}
          onChange={(e) => setCidr(e.target.value)}
        />
        {scan.data?.cidr && <span className="text-muted-foreground text-xs">scanned {scan.data.cidr}</span>}
      </div>
      {candidates && candidates.length === 0 && (
        <p className="text-muted-foreground mt-3 text-xs">No cameras found on this network.</p>
      )}
      {candidates && candidates.length > 0 && (
        <Table className="mt-3 text-xs">
          <TableHeader>
            <TableRow>
              <TableHead>Host</TableHead>
              <TableHead>Port</TableHead>
              <TableHead>Vendor</TableHead>
              <TableHead>Paths</TableHead>
              <TableHead>Auth</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {candidates.map((c) => {
              const saved = knownHosts.has(`${c.host}:${c.port}`)
              return (
                <TableRow key={`${c.host}:${c.port}`}>
                  <TableCell className="font-mono">{c.host}</TableCell>
                  <TableCell className="font-mono">{c.port}</TableCell>
                  <TableCell>{c.vendor ?? '-'}</TableCell>
                  <TableCell className="text-muted-foreground max-w-48 truncate font-mono">{c.paths.join(', ') || '-'}</TableCell>
                  <TableCell>
                    <Badge variant={c.requires_auth ? 'secondary' : 'outline'}>{c.requires_auth ? 'auth required' : 'open'}</Badge>
                  </TableCell>
                  <TableCell>
                    <Button size="xs" variant={saved ? 'ghost' : 'default'} disabled={saved} onClick={() => setTarget(c)}>
                      {saved ? 'Saved' : 'Connect'}
                    </Button>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
      <ConnectDialog candidate={target} onOpenChange={(o) => !o && setTarget(null)} />
    </section>
  )
}
