import { createContext, useContext, useState, type ReactNode } from 'react'

interface LayoutModeContextValue {
  editMode: boolean
  setEditMode: (v: boolean) => void
  previewMode: boolean
  setPreviewMode: (v: boolean) => void
}

const LayoutModeContext = createContext<LayoutModeContextValue>({
  editMode: false, setEditMode: () => {},
  previewMode: false, setPreviewMode: () => {},
})

export function LayoutModeProvider({ children }: { children: ReactNode }) {
  const [editMode, setEditMode] = useState(false)
  const [previewMode, setPreviewMode] = useState(false)
  return (
    <LayoutModeContext.Provider value={{ editMode, setEditMode, previewMode, setPreviewMode }}>
      {children}
    </LayoutModeContext.Provider>
  )
}

export function useLayoutMode() {
  return useContext(LayoutModeContext)
}
