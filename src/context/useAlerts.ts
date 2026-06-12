import { useContext } from 'react'
import { AlertsContext } from './AlertsContext'

export const useAlerts = () => useContext(AlertsContext)
