import type { CSSProperties, ReactNode } from 'react'
import Sidebar from './Sidebar'
import LoadingBar from './LoadingBar'

interface PageHeaderProps {
  title: string
  sub?: string
  right?: ReactNode
}

export function PageHeader({ title, sub, right }: PageHeaderProps) {
  return (
    <div style={{
      padding: '0.7rem 1.25rem',
      borderBottom: '1px solid var(--border)',
      background: 'var(--surface)',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      flexShrink: 0,
    }}>
      <div>
        <div style={{ fontSize: '0.78rem', fontWeight: 700, letterSpacing: '0.06em' }}>{title}</div>
        {sub && <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', marginTop: '0.1rem' }}>{sub}</div>}
      </div>
      {right && <div>{right}</div>}
    </div>
  )
}

interface LayoutProps {
  children: ReactNode
  header?: ReactNode
  mainStyle?: CSSProperties
}

export default function Layout({ children, header, mainStyle }: LayoutProps) {
  return (
    <div style={{ display: 'flex', height: '100vh', width: '100%', overflow: 'hidden', background: 'var(--bg)' }}>
      <Sidebar />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
        <LoadingBar />
        {header}
        <main style={{ flex: 1, overflowY: 'auto', padding: '0.875rem 1.25rem 1.5rem', ...mainStyle }}>
          {children}
        </main>
      </div>
    </div>
  )
}
