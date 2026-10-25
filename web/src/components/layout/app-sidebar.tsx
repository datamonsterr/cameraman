import { Aperture } from 'lucide-react'
import { matchPath, NavLink, useLocation } from 'react-router-dom'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar'
import { NAV_ITEMS } from './nav'

export function AppSidebar() {
  const { pathname } = useLocation()
  return (
    <Sidebar collapsible="icon" variant="sidebar">
      <SidebarHeader className="h-12 justify-center border-b border-sidebar-border">
        <div className="flex items-center gap-2 px-1">
          <div className="bg-primary text-primary-foreground grid size-6 shrink-0 place-items-center rounded-md">
            <Aperture className="size-3.5" />
          </div>
          <span className="truncate text-sm font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
            Cameraman
          </span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
                <SidebarMenuItem key={to}>
                  <SidebarMenuButton
                    asChild
                    isActive={!!matchPath({ path: to, end: !!end }, pathname)}
                    tooltip={label}
                    size="sm"
                  >
                    <NavLink to={to} end={end}>
                      <Icon />
                      <span>{label}</span>
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  )
}
