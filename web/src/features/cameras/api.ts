import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type {
  Camera,
  Candidate,
  ConnectRequest,
  CreateCameraRequest,
  ScanResponse,
  StatusHistory,
  UpdateCameraRequest,
} from '@/types/api'

export const cameraKeys = {
  all: ['cameras'] as const,
  list: () => [...cameraKeys.all, 'list'] as const,
  detail: (id: string) => [...cameraKeys.all, 'detail', id] as const,
  history: (id: string, limit: number) => [...cameraKeys.all, 'history', id, limit] as const,
}

export const fetchCameras = () => api.get<Camera[]>('/cameras')
export const fetchCamera = (id: string) => api.get<Camera>(`/cameras/${id}`)
export const fetchStatusHistory = (id: string, limit = 50) =>
  api.get<StatusHistory[]>(`/cameras/${id}/status/history?limit=${limit}`)
export const scanCameras = (cidr?: string) =>
  api.post<ScanResponse>('/cameras/scan', cidr ? { cidr } : {})
export const createCamera = (body: CreateCameraRequest) => api.post<Camera>('/cameras', body)
export const updateCamera = (id: string, body: UpdateCameraRequest) => api.patch<Camera>(`/cameras/${id}`, body)
export const deleteCamera = (id: string) => api.delete(`/cameras/${id}`)
export const connectCamera = (id: string, body: ConnectRequest = {}) =>
  api.post<Camera>(`/cameras/${id}/connect`, body)
export const snapshotPath = (id: string) => `/cameras/${id}/snapshot`
export const fetchSnapshotBlob = (id: string, signal?: AbortSignal) => api.blob(snapshotPath(id), { signal })

/** Build a create-request from a discovered candidate. */
export function candidateToCreate(c: Candidate, over: Partial<CreateCameraRequest> = {}): CreateCameraRequest {
  return {
    name: over.name?.trim() || `${c.vendor ?? 'Camera'} ${c.host}`,
    host: c.host,
    port: c.port,
    rtsp_path: over.rtsp_path?.trim() || c.paths[0] || '/',
    ...(c.vendor ? { vendor: c.vendor } : {}),
  }
}

export function useCameras() {
  return useQuery({ queryKey: cameraKeys.list(), queryFn: fetchCameras, refetchInterval: 15_000 })
}

export function useCamera(id: string | undefined) {
  return useQuery({
    queryKey: cameraKeys.detail(id ?? ''),
    queryFn: () => fetchCamera(id as string),
    enabled: !!id,
    refetchInterval: 15_000,
  })
}

export function useStatusHistory(id: string | undefined, limit = 50) {
  return useQuery({
    queryKey: cameraKeys.history(id ?? '', limit),
    queryFn: () => fetchStatusHistory(id as string, limit),
    enabled: !!id,
  })
}

export function useScan() {
  return useMutation({ mutationFn: (cidr?: string) => scanCameras(cidr) })
}

function useInvalidateCameras() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: cameraKeys.all })
}

export function useCreateCamera() {
  const invalidate = useInvalidateCameras()
  return useMutation({ mutationFn: createCamera, onSuccess: invalidate })
}

export function useUpdateCamera() {
  const invalidate = useInvalidateCameras()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateCameraRequest }) => updateCamera(id, body),
    onSuccess: invalidate,
  })
}

export function useDeleteCamera() {
  const invalidate = useInvalidateCameras()
  return useMutation({ mutationFn: deleteCamera, onSuccess: invalidate })
}

export function useConnectCamera() {
  const invalidate = useInvalidateCameras()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body?: ConnectRequest }) => connectCamera(id, body),
    onSettled: invalidate,
  })
}
