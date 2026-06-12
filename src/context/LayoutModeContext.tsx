import { createContext, useContext, useState, type ReactNode } from 'react'

interface LayoutModeContextValue {
  editMode: boolean
  setEditMode: (v: boolean) => void
}

const LayoutModeContext = createContext<LayoutModeContextValue>({ editMode: false, setEditMode: () => {} })

export function LayoutModeProvider({ children }: { children: ReactNode }) {
  const [editMode, setEditMode] = useState(false)
  return (
    <LayoutModeContext.Provider value={{ editMode, setEditMode }}>
      {children}
    </LayoutModeContext.Provider>
  )
}

export function useLayoutMode() {
  return useContext(LayoutModeContext)
}
