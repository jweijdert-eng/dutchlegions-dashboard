export function secColor(sec: number): string {
  if (sec >= 1.0) return '#2C75E1'
  if (sec >= 0.9) return '#399AEB'
  if (sec >= 0.8) return '#4ECEF8'
  if (sec >= 0.7) return '#60DBA3'
  if (sec >= 0.5) return '#3ECF6E'
  if (sec >= 0.2) return '#F0C040'
  if (sec >= 0.0) return '#F59E0B'
  if (sec >= -0.3) return '#FB923C'
  if (sec >= -0.6) return '#F97316'
  return '#EF4444'
}
