import { Outlet } from 'react-router-dom'
import { Separator } from '@/components/ui/separator'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { AppSidebar } from './app-sidebar'
import { ThemeToggle } from './theme-toggle'
import { UserMenu } from './user-menu'

export function AppShell() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="bg-background/80 sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b px-3 backdrop-blur">
          <SidebarTrigger className="-ml-1 size-8" />
          <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-4" />
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
            <UserMenu />
          </div>
        </header>
        <main className="flex-1 p-4 md:p-5">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
