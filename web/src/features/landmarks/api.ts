import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, api } from '@/lib/api'
import type { Landmark, LandmarkInput, LandmarkPatch, RawLandmark } from '@/types/api'
import { fromRawBox } from './geometry'

export const landmarkKeys = {
  all: ['landmarks'] as const,
  camera: (id: string) => [...landmarkKeys.all, 'camera', id] as const,
}

export function normalizeLandmark(r: RawLandmark): Landmark {
  return { ...r, box: fromRawBox(r.box) }
}

/** 404/501 (not shipped) degrades to an empty list. */
export async function fetchLandmarks(cameraId: string): Promise<Landmark[]> {
  try {
    const res = await api.get<RawLandmark[] | { landmarks: RawLandmark[] }>(`/landmarks?camera=${encodeURIComponent(cameraId)}`)
    const list = Array.isArray(res) ? res : (res?.landmarks ?? [])
    return list.map(normalizeLandmark)
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 501)) return []
    throw e
  }
}

export function useLandmarks(cameraId: string | undefined, pollMs = 4000) {
  return useQuery({
    queryKey: landmarkKeys.camera(cameraId ?? ''),
    queryFn: () => fetchLandmarks(cameraId as string),
    enabled: !!cameraId,
    refetchInterval: pollMs,
  })
}

function useInvalidate() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: landmarkKeys.all })
}

export function useCreateLandmark() {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: (b: LandmarkInput) => api.post<RawLandmark>('/landmarks', b), onSuccess: invalidate })
}

export function useUpdateLandmark() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: LandmarkPatch }) => api.patch<RawLandmark>(`/landmarks/${id}`, body),
    onSuccess: invalidate,
  })
}

export function useDeleteLandmark() {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: (id: string) => api.delete(`/landmarks/${id}`), onSuccess: invalidate })
}
