import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './auth/AuthContext'
import Login from './pages/Login'
import Callback from './pages/Callback'
import { useKeybinds } from './hooks/useKeybinds'
import Layout, { PageHeader } from './components/Layout'
import { AlertsProvider } from './context/AlertsContext'
import { LoadingProvider } from './context/LoadingContext'
import { LayoutModeProvider, useLayoutMode } from './context/LayoutModeContext'
import { useSiteSettings } from './hooks/useSiteSettings'

const lz = <T extends React.ComponentType>(f: () => Promise<{ default: T }>) =>
  lazy(() => f().catch(() => { window.location.reload(); return new Promise<never>(() => {}) }))

const Dashboard    = lz(() => import('./pages/Dashboard'))
const Character    = lz(() => import('./pages/Character'))
const Wallet       = lz(() => import('./pages/Wallet'))
const Kills        = lz(() => import('./pages/Kills'))
const Industry     = lz(() => import('./pages/Industry'))
const Mining       = lz(() => import('./pages/Mining'))
const Planets      = lz(() => import('./pages/Planets'))
const Mail         = lz(() => import('./pages/Mail'))
const Fittings     = lz(() => import('./pages/Fittings'))
const Market       = lz(() => import('./pages/Market'))
const Skills       = lz(() => import('./pages/Skills'))
const Blueprints   = lz(() => import('./pages/Blueprints'))
const Contracts    = lz(() => import('./pages/Contracts'))
const Notes        = lz(() => import('./pages/Notes'))
const DebugUnresolved = lz(() => import('./pages/DebugUnresolved'))
const MultiChar    = lz(() => import('./pages/MultiChar'))
const LocalChat    = lz(() => import('./pages/LocalChat'))
const BuildvsBuy   = lz(() => import('./pages/BuildvsBuy'))
const Ratting      = lz(() => import('./pages/Ratting'))
const Hauling      = lz(() => import('./pages/Hauling'))
const Assets       = lz(() => import('./pages/Assets'))
const Admin        = lz(() => import('./pages/Admin'))

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    if (this.state.error) {
      const err = this.state.error as Error
      return (
        <div style={{ padding: '2rem', color: '#e05555', background: '#05050e', minHeight: '100vh', fontFamily: 'monospace' }}>
          <h2 style={{ marginBottom: '1rem' }}>Runtime Error</h2>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: '0.85rem', color: '#c8cde8' }}>{err.message}{'\n\n'}{err.stack}</pre>
        </div>
      )
    }
    return this.props.children
  }
}

function ComingSoon({ title }: { title: string }) {
  return (
    <Layout header={<PageHeader title={title} />}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', flexDirection: 'column', gap: '1rem' }}>
        <div style={{ fontSize: '2rem', color: 'var(--border)' }}>⬡</div>
        <div style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>Coming soon</div>
      </div>
    </Layout>
  )
}

function RootRoute() {
  const { tokens } = useAuth()
  const params = new URLSearchParams(window.location.search)
  const isCallback = params.has('code') && params.has('state')
  if (isCallback) return <Callback />
  if (tokens.length === 0) return <Login />
  return <Dashboard />
}

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { tokens } = useAuth()
  return tokens.length > 0 ? <>{children}</> : <Navigate to="/" replace />
}

function AdminRoute({ children }: { children: ReactNode }) {
  const { tokens } = useAuth()
  return tokens.some(t => t.characterId === ADMIN_CHAR_ID) ? <>{children}</> : <Navigate to="/" replace />
}

// Local Chat: toegankelijk voor ingelogde members zolang de admin de setting
// 'local_chat' aan heeft staan (default aan); de admin kan altijd.
function LocalChatRoute({ children }: { children: ReactNode }) {
  const { tokens } = useAuth()
  const settings = useSiteSettings()
  if (tokens.length === 0) return <Navigate to="/" replace />
  const isAdmin = tokens.some(t => t.characterId === ADMIN_CHAR_ID)
  return (settings.local_chat !== false || isAdmin) ? <>{children}</> : <Navigate to="/" replace />
}

function PageFallback() {
  return (
    <Layout>
      <div />
    </Layout>
  )
}


const ADMIN_CHAR_ID = 1831618559

function MaintenancePage() {
  return (
    <div style={{ minHeight: '100vh', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden', background: '#05050e' }}>
      <div style={{ position: 'absolute', inset: 0, backgroundImage: 'url(/bg.png)', backgroundSize: 'cover', backgroundPosition: 'center', filter: 'brightness(0.55) saturate(1.1)' }} />
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: 'radial-gradient(ellipse at center, transparent 40%, rgba(5,5,14,0.7) 100%)' }} />
      <div style={{ position: 'relative', zIndex: 10, textAlign: 'center', width: '100%', maxWidth: 420, padding: '0 1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '1.5rem', marginBottom: '1.5rem' }}>
          {[
            { src: `https://images.evetech.net/alliances/99013537/logo?size=256`, alt: 'Alliance Logo' },
            { src: `https://images.evetech.net/corporations/98652891/logo?size=256`, alt: 'Corporation Logo' },
          ].map(logo => (
            <img key={logo.alt} src={logo.src} alt={logo.alt} width={80} height={80} style={{ borderRadius: '50%', display: 'block' }} />
          ))}
        </div>
        <div style={{ fontSize: '1.5rem', fontWeight: 700, letterSpacing: '0.22em', color: '#fff', marginBottom: '0.25rem', textTransform: 'uppercase', textShadow: '0 0 30px rgba(0,180,216,0.5)' }}>
          Dutch Legions
        </div>
        <div style={{ fontSize: '0.65rem', color: 'var(--blue)', letterSpacing: '0.35em', textTransform: 'uppercase', marginBottom: '2.5rem', textShadow: '0 0 12px rgba(0,180,216,0.6)' }}>
          Dashboard
        </div>
        <div style={{ background: 'linear-gradient(160deg, rgba(11,11,26,0.92) 0%, rgba(5,5,14,0.96) 100%)', border: '1px solid rgba(0,180,216,0.2)', borderRadius: 6, padding: '2rem 2rem 1.75rem', boxShadow: '0 8px 60px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.05)', backdropFilter: 'blur(12px)' }}>
          <div style={{ fontSize: '0.8rem', color: '#fff', fontWeight: 700, letterSpacing: '0.12em', marginBottom: '0.75rem' }}>ONDERHOUD</div>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', lineHeight: 1.7 }}>
            Het dashboard is tijdelijk niet beschikbaar.<br />Kom later terug.
          </div>
        </div>
      </div>
    </div>
  )
}

function AppRoutes() {
  useKeybinds()
  const { tokens } = useAuth()
  const { previewMode } = useLayoutMode()
  const [maintenance, setMaintenance] = useState(false)

  useEffect(() => {
    fetch('/api/settings.php')
      .then(r => r.json())
      .then(data => { if (data.maintenance_mode === true) setMaintenance(true) })
      .catch(() => {})
  }, [])

  const isAdmin = tokens.some(t => t.characterId === ADMIN_CHAR_ID)
  if (maintenance && (!isAdmin || previewMode)) return <MaintenancePage />

  return (
    <Suspense fallback={<PageFallback />}>
    <Routes>
      <Route path="/" element={<RootRoute />} />
      <Route path="/character" element={<ProtectedRoute><Character /></ProtectedRoute>} />
      <Route path="/wallet"    element={<ProtectedRoute><Wallet /></ProtectedRoute>} />
      <Route path="/kills"     element={<ProtectedRoute><Kills /></ProtectedRoute>} />
      <Route path="/market"    element={<ProtectedRoute><Market /></ProtectedRoute>} />
      <Route path="/industry"  element={<ProtectedRoute><Industry /></ProtectedRoute>} />
      <Route path="/mining"    element={<ProtectedRoute><Mining /></ProtectedRoute>} />
      <Route path="/planets"   element={<ProtectedRoute><Planets /></ProtectedRoute>} />
      <Route path="/mail"      element={<ProtectedRoute><Mail /></ProtectedRoute>} />
      <Route path="/fittings"  element={<ProtectedRoute><Fittings /></ProtectedRoute>} />
      <Route path="/skills"      element={<ProtectedRoute><Skills /></ProtectedRoute>} />
      <Route path="/blueprints" element={<ProtectedRoute><Blueprints /></ProtectedRoute>} />
      <Route path="/contracts"  element={<ProtectedRoute><Contracts /></ProtectedRoute>} />
      <Route path="/notes"      element={<ProtectedRoute><Notes /></ProtectedRoute>} />
      <Route path="/overview"   element={<ProtectedRoute><MultiChar /></ProtectedRoute>} />
      <Route path="/local"      element={<LocalChatRoute><LocalChat /></LocalChatRoute>} />
      <Route path="/buildvsbuy" element={<ProtectedRoute><BuildvsBuy /></ProtectedRoute>} />
      <Route path="/ratting"    element={<ProtectedRoute><Ratting /></ProtectedRoute>} />
      <Route path="/hauling"    element={<ProtectedRoute><Hauling /></ProtectedRoute>} />
      <Route path="/assets"     element={<ProtectedRoute><Assets /></ProtectedRoute>} />
      <Route path="/admin"      element={<AdminRoute><Admin /></AdminRoute>} />
      <Route path="/login"      element={<Login />} />
      <Route path="/debug/unresolved" element={<ProtectedRoute><DebugUnresolved /></ProtectedRoute>} />
      <Route path="*"          element={<Navigate to="/" replace />} />
    </Routes>
    </Suspense>
  )
}

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <LoadingProvider>
            <AlertsProvider>
              <LayoutModeProvider>
                <AppRoutes />
              </LayoutModeProvider>
            </AlertsProvider>
          </LoadingProvider>
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  )
}
