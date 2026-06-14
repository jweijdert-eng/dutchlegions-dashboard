import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import Sidebar from './Sidebar'
import LoadingBar from './LoadingBar'
import MotdBanner from './MotdBanner'
import { useIsMobile } from '../hooks/useIsMobile'

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
      gap: '0.5rem',
      flexWrap: 'wrap',
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
  const isMobile = useIsMobile()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const location = useLocation()

  // Sluit de drawer bij navigatie
  useEffect(() => { setDrawerOpen(false) }, [location.pathname])

  // Voorkom scrollen achter de open drawer
  useEffect(() => {
    if (isMobile && drawerOpen) {
      document.body.style.overflow = 'hidden'
      return () => { document.body.style.overflow = '' }
    }
  }, [isMobile, drawerOpen])

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100%', overflow: 'hidden', background: 'var(--bg)' }}>
      {isMobile ? (
        <>
          {drawerOpen && (
            <div
              onClick={() => setDrawerOpen(false)}
              style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 150 }}
            />
          )}
          <Sidebar mobile open={drawerOpen} onClose={() => setDrawerOpen(false)} />
        </>
      ) : (
        <Sidebar />
      )}

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
        <LoadingBar />
        <MotdBanner />

        {/* Mobiele topbalk met hamburger */}
        {isMobile && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: '0.6rem',
            padding: '0.5rem 0.75rem', borderBottom: '1px solid var(--border)',
            background: 'var(--surface)', flexShrink: 0,
          }}>
            <button
              onClick={() => setDrawerOpen(true)}
              aria-label="Menu openen"
              style={{
                display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 4,
                width: 34, height: 34, padding: 8,
                background: 'rgba(0,180,216,0.07)', border: '1px solid rgba(0,180,216,0.25)',
                borderRadius: 4, cursor: 'pointer', flexShrink: 0,
              }}
            >
              {[0, 1, 2].map(i => <span key={i} style={{ height: 2, background: 'var(--blue)', borderRadius: 2 }} />)}
            </button>
            <span style={{ color: 'var(--blue)', fontWeight: 700, fontSize: '0.75rem', letterSpacing: '0.16em' }}>EVE</span>
            <span style={{ color: 'var(--text-dim)', fontSize: '0.6rem', letterSpacing: '0.1em' }}>DASHBOARD</span>
          </div>
        )}

        {header}
        <main style={{ flex: 1, overflowY: 'auto', padding: isMobile ? '0.6rem 0.7rem 1.5rem' : '0.875rem 1.25rem 1.5rem', ...mainStyle }}>
          {children}
        </main>
      </div>
    </div>
  )
}
