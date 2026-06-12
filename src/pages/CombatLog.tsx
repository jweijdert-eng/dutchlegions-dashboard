import { type ReactNode, useMemo, useState } from 'react'
import {
  ResponsiveContainer, ComposedChart, BarChart, Bar,
  Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import Layout, { PageHeader } from '../components/Layout'
import { useCombatLog } from '../hooks/useCombatLog'
import { bucketEvents, type BucketRow } from '../utils/combatLogParser'

const BUCKET_SECS = 5

const WINDOWS = [
  { label: '30s',   value: 30   as number | null },
  { label: '1m',    value: 60   as number | null },
  { label: '2m',    value: 120  as number | null },
  { label: '5m',    value: 300  as number | null },
  { label: '10m',   value: 600  as number | null },
  { label: 'Alles', value: null as number | null },
]

const AXIS_TICK = { fill: 'var(--text-dim)', fontSize: 10 }
const TIP_STYLE = { background: 'var(--surface)', border: '1px solid var(--border)', fontSize: '0.7rem', color: 'var(--text)' }

function btnStyle(active: boolean, col = 'var(--blue)'): React.CSSProperties {
  return {
    padding: '0.25rem 0.65rem', borderRadius: 2, fontSize: '0.68rem', fontWeight: 600,
    cursor: 'pointer',
    background: active ? 'rgba(0,180,216,0.15)' : 'transparent',
    border: `1px solid ${active ? col : 'var(--border)'}`,
    color: active ? col : 'var(--text-dim)',
  }
}

function StatCard({ label, val, col = 'var(--text)', sub }: { label: string; val: string; col?: string; sub?: string }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.75rem 1rem' }}>
      <div style={{ fontSize: '0.57rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.18em', marginBottom: '0.3rem' }}>{label}</div>
      <div style={{ fontSize: '1.1rem', fontWeight: 700, color: col }}>{val}</div>
      {sub && <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', marginTop: '0.15rem' }}>{sub}</div>}
    </div>
  )
}

function ChartSection({ title, children, show }: { title: string; children: ReactNode; show: boolean }) {
  if (!show) return null
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '1rem', marginBottom: '0.75rem' }}>
      <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.14em', marginBottom: '0.75rem' }}>{title}</div>
      <div style={{ height: 220 }}>{children}</div>
    </div>
  )
}

function peak(data: BucketRow[], key: keyof BucketRow): number {
  return data.reduce((m, r) => Math.max(m, r[key] as number), 0)
}

function total(data: BucketRow[], key: keyof BucketRow): number {
  return data.reduce((s, r) => s + (r[key] as number), 0)
}

function fmt(n: number, d = 0): string { return n.toFixed(d) }

function fmtLogName(name: string): string {
  // EVE log files are like "Gamelogs_2024-01-15_20-30-00.txt" — show just date+time
  const m = /(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})/.exec(name)
  return m ? m[1].replace('_', ' ').replace(/-/g, (c, i) => i > 9 ? ':' : '-') : name
}

export default function CombatLog() {
  const { events, fileName, lastUpdated, isLive, error, serverAvailable, logFiles, openFile, selectFile, toggleLive, clearEvents } = useCombatLog()
  const [timeWindow, setTimeWindow] = useState<number | null>(300)
  const [showFileList, setShowFileList] = useState(false)

  const data = useMemo(() => bucketEvents(events, timeWindow, BUCKET_SECS), [events, timeWindow])

  const hasDamage = data.some(r => r.dpsOut > 0 || r.dpsIn > 0)
  const hasLogi   = data.some(r => r.shieldOut > 0 || r.shieldIn > 0 || r.armorOut > 0 || r.armorIn > 0 || r.hullOut > 0 || r.hullIn > 0)
  const hasCap    = data.some(r => r.capOut > 0 || r.capIn > 0 || r.neutOut > 0 || r.neutIn > 0 || r.nosOut > 0 || r.nosIn > 0)
  const hasMining = data.some(r => r.mined > 0)
  const hasAny    = events.length > 0

  const totalDmgOut = total(data, 'dpsOut') * BUCKET_SECS
  const totalDmgIn  = total(data, 'dpsIn')  * BUCKET_SECS
  const totalLogi   = total(data, 'shieldOut') + total(data, 'armorOut') + total(data, 'hullOut')
  const totalMined  = total(data, 'mined')

  return (
    <Layout header={
      <PageHeader
        title="Combat Log"
        sub={fileName
          ? `${events.length} events · ${fileName}${lastUpdated ? ` · ${lastUpdated.toLocaleTimeString()}` : ''}`
          : serverAvailable ? 'Zoeken naar log bestanden...' : 'Geen bestand geladen'}
        right={
          <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', position: 'relative' }}>
            {fileName && (
              <>
                <button onClick={toggleLive} style={btnStyle(isLive, isLive ? 'var(--green)' : 'var(--blue)')}>
                  {isLive ? '⬤ Live' : '○ Live'}
                </button>
                <button onClick={clearEvents} style={btnStyle(false)}>Reset</button>
              </>
            )}
            {serverAvailable && logFiles.length > 0 && (
              <div style={{ position: 'relative' }}>
                <button
                  onClick={() => setShowFileList(v => !v)}
                  style={btnStyle(showFileList)}
                >
                  ⊞ Log kiezen
                </button>
                {showFileList && (
                  <div style={{
                    position: 'absolute', top: '100%', right: 0, marginTop: 4,
                    background: 'var(--surface)', border: '1px solid var(--border)',
                    borderRadius: 3, zIndex: 100, minWidth: 260, maxHeight: 300, overflowY: 'auto',
                  }}>
                    {logFiles.map(f => (
                      <button
                        key={f.name}
                        onClick={() => { selectFile(f.name).catch(() => {}); setShowFileList(false) }}
                        style={{
                          display: 'block', width: '100%', textAlign: 'left',
                          padding: '0.5rem 0.75rem', cursor: 'pointer',
                          background: fileName === f.name ? 'rgba(0,180,216,0.1)' : 'transparent',
                          border: 'none', borderBottom: '1px solid var(--border)',
                          color: fileName === f.name ? 'var(--blue)' : 'var(--text-dim)',
                          fontSize: '0.68rem',
                        }}
                      >
                        {fmtLogName(f.name)}
                        <span style={{ float: 'right', color: 'var(--border)', fontSize: '0.6rem' }}>
                          {(f.size / 1024).toFixed(0)} KB
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {!serverAvailable && (
              <button onClick={() => { openFile().catch(() => {}) }} style={btnStyle(true)}>
                {fileName ? '↻ Ander bestand' : '⊕ Log openen'}
              </button>
            )}
          </div>
        }
      />
    }>
      {error && (
        <div style={{ background: 'rgba(224,85,85,0.1)', border: '1px solid var(--red)', borderRadius: 3, padding: '0.75rem 1rem', marginBottom: '0.75rem', fontSize: '0.72rem', color: 'var(--red)' }}>
          {error}
        </div>
      )}

      {!hasAny ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '60vh', gap: '1.5rem' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '2.5rem', color: 'var(--border)', marginBottom: '0.75rem' }}>◉</div>
            {serverAvailable ? (
              <>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-dim)', marginBottom: '0.5rem' }}>
                  Geen EVE log gevonden
                </div>
                <div style={{ fontSize: '0.7rem', color: 'var(--border)', lineHeight: 1.7 }}>
                  Verwacht in:<br />
                  <code style={{ color: 'var(--blue)', fontSize: '0.65rem' }}>Documents\EVE\logs\Gamelogs\</code>
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-dim)', marginBottom: '0.5rem' }}>
                  Geen combat log geladen
                </div>
                <div style={{ fontSize: '0.7rem', color: 'var(--border)', lineHeight: 1.7 }}>
                  Start de app via <code style={{ color: 'var(--blue)', fontSize: '0.65rem' }}>npx vite</code> voor automatisch laden,<br />
                  of selecteer handmatig een log:
                </div>
                <button
                  onClick={() => { openFile().catch(() => {}) }}
                  style={{ marginTop: '1rem', padding: '0.6rem 1.5rem', background: 'rgba(0,180,216,0.1)', border: '1px solid var(--blue)', borderRadius: 3, color: 'var(--blue)', fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer' }}
                >
                  ⊕ Log bestand openen
                </button>
              </>
            )}
          </div>
        </div>
      ) : (
        <>
          {/* Time window filter */}
          <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
            {WINDOWS.map(w => (
              <button key={String(w.value)} onClick={() => setTimeWindow(w.value)} style={btnStyle(timeWindow === w.value)}>
                {w.label}
              </button>
            ))}
          </div>

          {/* Stat cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '0.65rem', marginBottom: '0.75rem' }}>
            <StatCard label="PEAK DPS UIT"   val={fmt(peak(data, 'dpsOut'), 1)}  col="#ff9900"      sub="/s" />
            <StatCard label="PEAK DPS IN"    val={fmt(peak(data, 'dpsIn'), 1)}   col="var(--red)"   sub="/s" />
            <StatCard label="TOT SCHADE UIT" val={fmt(totalDmgOut)}              col="#ff9900"      sub="HP" />
            <StatCard label="TOT SCHADE IN"  val={fmt(totalDmgIn)}               col="var(--red)"   sub="HP" />
            <StatCard label="LOGI GEGEVEN"   val={fmt(totalLogi)}                col="var(--green)" sub="HP" />
            <StatCard label="GEMIJND"        val={`${fmt(totalMined)} m3`}       col="#a0c860" />
          </div>

          {!hasDamage && !hasLogi && !hasCap && !hasMining && (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '2rem', textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.78rem' }}>
              Geen gevechtsdata in dit tijdvenster — probeer een groter venster of kies "Alles".
            </div>
          )}

          {/* DPS chart */}
          <ChartSection title="DPS — SCHADE UIT / IN" show={hasDamage}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={data}>
                <CartesianGrid stroke="rgba(255,255,255,0.05)" strokeDasharray="3 3" />
                <XAxis dataKey="time" tick={AXIS_TICK} interval="preserveStartEnd" />
                <YAxis tick={AXIS_TICK} />
                <Tooltip contentStyle={TIP_STYLE} />
                <Legend wrapperStyle={{ fontSize: '0.65rem' }} />
                <Area type="monotone" dataKey="dpsOut" name="DPS Uit" stroke="#ff9900" fill="rgba(255,153,0,0.2)" strokeWidth={2} />
                <Area type="monotone" dataKey="dpsIn"  name="DPS In"  stroke="#e05555" fill="rgba(224,85,85,0.15)" strokeWidth={2} />
              </ComposedChart>
            </ResponsiveContainer>
          </ChartSection>

          {/* Logistics chart */}
          <ChartSection title="LOGISTICS — SHIELD / ARMOR / HULL" show={hasLogi}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={data}>
                <CartesianGrid stroke="rgba(255,255,255,0.05)" strokeDasharray="3 3" />
                <XAxis dataKey="time" tick={AXIS_TICK} interval="preserveStartEnd" />
                <YAxis tick={AXIS_TICK} />
                <Tooltip contentStyle={TIP_STYLE} />
                <Legend wrapperStyle={{ fontSize: '0.65rem' }} />
                <Area type="monotone" dataKey="shieldOut" name="Shield Uit" stroke="#00b4d8" fill="rgba(0,180,216,0.2)"   strokeWidth={1.5} />
                <Area type="monotone" dataKey="shieldIn"  name="Shield In"  stroke="#80d8e8" fill="rgba(128,216,232,0.1)" strokeWidth={1.5} />
                <Area type="monotone" dataKey="armorOut"  name="Armor Uit"  stroke="#f0c040" fill="rgba(240,192,64,0.2)"  strokeWidth={1.5} />
                <Area type="monotone" dataKey="armorIn"   name="Armor In"   stroke="#f8e090" fill="rgba(248,224,144,0.1)" strokeWidth={1.5} />
                <Area type="monotone" dataKey="hullOut"   name="Hull Uit"   stroke="#909090" fill="rgba(144,144,144,0.2)" strokeWidth={1.5} />
                <Area type="monotone" dataKey="hullIn"    name="Hull In"    stroke="#c0c0c0" fill="rgba(192,192,192,0.1)" strokeWidth={1.5} />
              </ComposedChart>
            </ResponsiveContainer>
          </ChartSection>

          {/* Cap / Neut / NOS chart */}
          <ChartSection title="CAP TRANSFERS / NEUT / NOS" show={hasCap}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={data}>
                <CartesianGrid stroke="rgba(255,255,255,0.05)" strokeDasharray="3 3" />
                <XAxis dataKey="time" tick={AXIS_TICK} interval="preserveStartEnd" />
                <YAxis tick={AXIS_TICK} />
                <Tooltip contentStyle={TIP_STYLE} />
                <Legend wrapperStyle={{ fontSize: '0.65rem' }} />
                <Area type="monotone" dataKey="capOut"  name="Cap Uit"  stroke="#40d0a0" fill="rgba(64,208,160,0.2)"  strokeWidth={1.5} />
                <Area type="monotone" dataKey="capIn"   name="Cap In"   stroke="#80e8c0" fill="rgba(128,232,192,0.1)" strokeWidth={1.5} />
                <Area type="monotone" dataKey="neutOut" name="Neut Uit" stroke="#c060ff" fill="rgba(192,96,255,0.2)"  strokeWidth={1.5} />
                <Area type="monotone" dataKey="neutIn"  name="Neut In"  stroke="#e0a0ff" fill="rgba(224,160,255,0.1)" strokeWidth={1.5} />
                <Area type="monotone" dataKey="nosOut"  name="NOS Uit"  stroke="#ff60a0" fill="rgba(255,96,160,0.2)"  strokeWidth={1.5} />
                <Area type="monotone" dataKey="nosIn"   name="NOS In"   stroke="#ffb0d0" fill="rgba(255,176,208,0.1)" strokeWidth={1.5} />
              </ComposedChart>
            </ResponsiveContainer>
          </ChartSection>

          {/* Mining chart */}
          <ChartSection title="MINING — M3 PER BUCKET" show={hasMining}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data}>
                <CartesianGrid stroke="rgba(255,255,255,0.05)" strokeDasharray="3 3" />
                <XAxis dataKey="time" tick={AXIS_TICK} interval="preserveStartEnd" />
                <YAxis tick={AXIS_TICK} />
                <Tooltip contentStyle={TIP_STYLE} />
                <Bar dataKey="mined" name="Gemijnd (m3)" fill="rgba(160,200,96,0.8)" />
              </BarChart>
            </ResponsiveContainer>
          </ChartSection>
        </>
      )}
    </Layout>
  )
}
