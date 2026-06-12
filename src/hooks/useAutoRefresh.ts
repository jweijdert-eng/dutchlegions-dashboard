import { useEffect, useState } from 'react'

export function useAutoRefresh(ms = 2 * 60 * 1000) {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), ms)
    return () => clearInterval(id)
  }, [ms])
  return tick
}
