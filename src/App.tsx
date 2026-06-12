import { Component, lazy, Suspense, type ReactNode } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './auth/AuthContext'
import Login from './pages/Login'
import Callback from './pages/Callback'
import { useKeybinds } from './hooks/useKeybinds'
import Layout, { PageHeader } from './components/Layout'
import { AlertsProvider } from './context/AlertsContext'
import { LoadingProvider } from './context/LoadingContext'

const Dashboard    = lazy(() => import('./pages/Dashboard'))
const Character    = lazy(() => import('./pages/Character'))
const Wallet       = lazy(() => import('./pages/Wallet'))
const Kills        = lazy(() => import('./pages/Kills'))
const Industry     = lazy(() => import('./pages/Industry'))
const Mining       = lazy(() => import('./pages/Mining'))
const Planets      = lazy(() => import('./pages/Planets'))
const Mail         = lazy(() => import('./pages/Mail'))
const Fittings     = lazy(() => import('./pages/Fittings'))
const Market       = lazy(() => import('./pages/Market'))
const Skills       = lazy(() => import('./pages/Skills'))
const Blueprints   = lazy(() => import('./pages/Blueprints'))
const Contracts    = lazy(() => import('./pages/Contracts'))
const Intel        = lazy(() => import('./pages/Intel'))
const Notes        = lazy(() => import('./pages/Notes'))
const DebugUnresolved = lazy(() => import('./pages/DebugUnresolved'))
const MultiChar    = lazy(() => import('./pages/MultiChar'))
const LocalChat    = lazy(() => import('./pages/LocalChat'))
const BuildvsBuy   = lazy(() => import('./pages/BuildvsBuy'))
const Admin        = lazy(() => import('./pages/Admin'))

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

function PageFallback() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', color: 'var(--text-dim)', fontSize: '0.8rem' }}>
      Laden...
    </div>
  )
}

function AppRoutes() {
  useKeybinds()
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
      <Route path="/intel"      element={<ProtectedRoute><Intel /></ProtectedRoute>} />
      <Route path="/notes"      element={<ProtectedRoute><Notes /></ProtectedRoute>} />
      <Route path="/overview"   element={<ProtectedRoute><MultiChar /></ProtectedRoute>} />
      <Route path="/local"      element={<ProtectedRoute><LocalChat /></ProtectedRoute>} />
      <Route path="/buildvsbuy" element={<ProtectedRoute><BuildvsBuy /></ProtectedRoute>} />
      <Route path="/admin"      element={<ProtectedRoute><Admin /></ProtectedRoute>} />
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
              <AppRoutes />
            </AlertsProvider>
          </LoadingProvider>
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  )
}
