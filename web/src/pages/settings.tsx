import { PageHeader } from '@/components/layout/page-header'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { AuditSection } from '@/features/settings/audit-table'
import { SmtpSection } from '@/features/settings/smtp-form'
import { UsersSection } from '@/features/settings/users-section'
import { hasRole, useAuth } from '@/stores/auth'

export function SettingsPage() {
  const isAdmin = useAuth((s) => hasRole(s.user?.role, ['admin']))
  return (
    <>
      <PageHeader title="Settings" description="SMTP, users and audit log." />
      {!isAdmin && (
        <p className="text-muted-foreground mb-3 rounded-lg border border-dashed p-3 text-xs">
          System settings are managed by administrators. You are signed in without that role, so these sections are unavailable.
        </p>
      )}
      <Tabs defaultValue="smtp">
        <TabsList>
          <TabsTrigger value="smtp">SMTP</TabsTrigger>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="audit">Audit log</TabsTrigger>
        </TabsList>
        {isAdmin && (
          <>
            <TabsContent value="smtp" className="pt-2"><SmtpSection /></TabsContent>
            <TabsContent value="users" className="pt-2"><UsersSection /></TabsContent>
            <TabsContent value="audit" className="pt-2"><AuditSection /></TabsContent>
          </>
        )}
      </Tabs>
    </>
  )
}
