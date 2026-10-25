import { createBrowserRouter, Navigate } from 'react-router-dom'
import { AppShell } from '@/components/layout/app-shell'
import { LoginPage } from '@/pages/login'
import { RegisterPage } from '@/pages/register'
import { DashboardPage } from '@/pages/dashboard'
import { CamerasPage } from '@/pages/cameras'
import { CameraDetailPage } from '@/pages/camera-detail'
import { WorkflowsPage } from '@/pages/workflows'
import { WorkflowEditorPage } from '@/pages/workflow-editor'
import { EventsPage } from '@/pages/events'
import { SettingsPage } from '@/pages/settings'
import { NotFoundPage } from '@/pages/not-found'
import { RequireAuth, RequireRole } from './guards'

export const appRoutes = [
  { path: '/login', element: <LoginPage /> },
  { path: '/register', element: <RegisterPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppShell />,
        children: [
          { index: true, element: <DashboardPage /> },
          { path: 'cameras', element: <CamerasPage /> },
          { path: 'cameras/:id', element: <CameraDetailPage /> },
          { path: 'workflows', element: <WorkflowsPage /> },
          { element: <RequireRole roles={['operator']} />, children: [{ path: 'workflows/new', element: <WorkflowEditorPage /> }] },
          { path: 'workflows/:id', element: <WorkflowEditorPage /> },
          { path: 'events', element: <EventsPage /> },
          { path: 'settings', element: <SettingsPage /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]

export const router = createBrowserRouter(appRoutes)
