import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, api } from '@/lib/api'
import type {
  CreateWorkflowRequest,
  NodeType,
  NodeTypesResponse,
  UpdateWorkflowRequest,
  Workflow,
  WorkflowRun,
  WorkflowVersion,
} from '@/types/api'

export const workflowKeys = {
  all: ['workflows'] as const,
  list: () => [...workflowKeys.all, 'list'] as const,
  detail: (id: string) => [...workflowKeys.all, 'detail', id] as const,
  runs: (id: string) => [...workflowKeys.all, 'runs', id] as const,
  versions: (id: string) => [...workflowKeys.all, 'versions', id] as const,
  nodeTypes: ['node-types'] as const,
}

/** Accepts either a bare array or `{version, node_types}`. */
export async function fetchNodeTypes(): Promise<NodeType[]> {
  const res = await api.get<NodeType[] | NodeTypesResponse>('/node-types')
  return Array.isArray(res) ? res : (res?.node_types ?? [])
}

export const fetchWorkflows = () => api.get<Workflow[]>('/workflows')
export const fetchWorkflow = (id: string) => api.get<Workflow>(`/workflows/${id}`)
export const fetchVersions = (id: string) => api.get<WorkflowVersion[]>(`/workflows/${id}/versions`)
export const createWorkflow = (body: CreateWorkflowRequest) => api.post<Workflow>('/workflows', body)
export const updateWorkflow = (id: string, body: UpdateWorkflowRequest) => api.patch<Workflow>(`/workflows/${id}`, body)
export const setWorkflowEnabled = (id: string, enabled: boolean) =>
  api.post<Workflow>(`/workflows/${id}/${enabled ? 'enable' : 'disable'}`)

/** Missing runs endpoint degrades to an empty history. */
export async function fetchRuns(id: string): Promise<WorkflowRun[]> {
  try {
    return await api.get<WorkflowRun[]>(`/workflows/${id}/runs`)
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 501)) return []
    throw e
  }
}

export function useNodeTypes() {
  return useQuery({ queryKey: workflowKeys.nodeTypes, queryFn: fetchNodeTypes, staleTime: 5 * 60_000 })
}

export function useWorkflows() {
  return useQuery({ queryKey: workflowKeys.list(), queryFn: fetchWorkflows, refetchInterval: 20_000 })
}

export function useWorkflow(id: string | undefined) {
  return useQuery({
    queryKey: workflowKeys.detail(id ?? ''),
    queryFn: () => fetchWorkflow(id as string),
    enabled: !!id,
  })
}

export function useWorkflowRuns(id: string | undefined) {
  return useQuery({
    queryKey: workflowKeys.runs(id ?? ''),
    queryFn: () => fetchRuns(id as string),
    enabled: !!id,
    refetchInterval: 10_000,
  })
}

export function useCreateWorkflow() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: createWorkflow,
    onSuccess: () => qc.invalidateQueries({ queryKey: workflowKeys.all }),
  })
}

export function useUpdateWorkflow() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateWorkflowRequest }) => updateWorkflow(id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: workflowKeys.all }),
  })
}

export function useSetEnabled() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => setWorkflowEnabled(id, enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: workflowKeys.all }),
  })
}
