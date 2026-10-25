import { createContext, useContext } from 'react'
import type { GraphIssue } from '@/types/api'
import type { Registry } from './graph'

export interface EditorCtxValue {
  registry: Registry
  /** Issues keyed by node id; only populated once errors are being shown. */
  issues: Map<string, GraphIssue[]>
}

export const EditorCtx = createContext<EditorCtxValue>({ registry: new Map(), issues: new Map() })
export const useEditorCtx = () => useContext(EditorCtx)
