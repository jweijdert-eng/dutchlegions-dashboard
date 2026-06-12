import { useEffect, useId } from 'react'
import { useLoadingContext } from '../context/LoadingContext'

export function usePageLoading(loading: boolean) {
  const { startLoading, stopLoading } = useLoadingContext()
  const id = useId()

  useEffect(() => {
    if (loading) startLoading(id)
    else stopLoading(id)
    return () => stopLoading(id)
  }, [loading, id, startLoading, stopLoading])
}
