import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'

interface LoadingContextValue {
  isLoading: boolean
  startLoading: (key: string) => void
  stopLoading: (key: string) => void
}

export const LoadingContext = createContext<LoadingContextValue>({
  isLoading: false,
  startLoading: () => {},
  stopLoading: () => {},
})

export function LoadingProvider({ children }: { children: ReactNode }) {
  const [keys, setKeys] = useState<Set<string>>(new Set())

  const startLoading = useCallback((key: string) => {
    setKeys(prev => new Set([...prev, key]))
  }, [])

  const stopLoading = useCallback((key: string) => {
    setKeys(prev => { const n = new Set(prev); n.delete(key); return n })
  }, [])

  return (
    <LoadingContext.Provider value={{ isLoading: keys.size > 0, startLoading, stopLoading }}>
      {children}
    </LoadingContext.Provider>
  )
}

export const useLoadingContext = () => useContext(LoadingContext)
