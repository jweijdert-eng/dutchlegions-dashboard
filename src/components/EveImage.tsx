import { useEffect, useState } from 'react'

type Category = 'characters' | 'corporations' | 'alliances' | 'types'
type Variation = 'portrait' | 'logo' | 'icon' | 'render' | 'bp' | 'bpc'
type Size = 32 | 64 | 128 | 256 | 512 | 1024

interface Props {
  category: Category
  id: number
  variation: Variation
  size: Size
  px?: number
  round?: boolean
  style?: React.CSSProperties
}

function imgUrl(category: Category, id: number, variation: Variation, size: Size) {
  return `https://images.evetech.net/${category}/${id}/${variation}?size=${size}`
}

// Fallback chain per category/variation
function nextFallback(category: Category, id: number, variation: Variation, size: Size): string | null {
  if (category === 'characters' || category === 'corporations' || category === 'alliances') {
    return id !== 1 ? imgUrl(category, 1, variation, size) : null
  }
  if (category === 'types') {
    if (variation === 'icon')   return imgUrl('types', id, 'render', size)
    if (variation === 'render') return imgUrl('types', id, 'icon',   size)
  }
  return null
}

function Placeholder({ size, round, style }: { size: number; round?: boolean; style?: React.CSSProperties }) {
  return (
    <div style={{
      width: size, height: size,
      borderRadius: round ? '50%' : 3,
      background: 'rgba(0,0,0,0.3)',
      border: '1px solid rgba(255,255,255,0.06)',
      flexShrink: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      ...style,
    }}>
      <svg width={size * 0.45} height={size * 0.45} viewBox="0 0 10 10" fill="none">
        <rect x="1" y="1" width="8" height="8" rx="1" stroke="rgba(255,255,255,0.15)" strokeWidth="1.2" />
        <line x1="3" y1="5" x2="7" y2="5" stroke="rgba(255,255,255,0.15)" strokeWidth="1.2" strokeLinecap="round" />
        <line x1="5" y1="3" x2="5" y2="7" stroke="rgba(255,255,255,0.15)" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    </div>
  )
}

export default function EveImage({ category, id, variation, size, px, round, style }: Props) {
  const [src,    setSrc]    = useState(() => imgUrl(category, id, variation, size))
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setSrc(imgUrl(category, id, variation, size))
    setFailed(false)
  }, [category, id, variation, size])

  const displaySize = px ?? size

  if (failed) return <Placeholder size={displaySize} round={round} style={style} />

  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      style={{
        width: displaySize,
        height: displaySize,
        borderRadius: round ? '50%' : 3,
        background: 'rgba(0,0,0,0.3)',
        flexShrink: 0,
        ...style,
      }}
      onError={() => {
        const fallback = nextFallback(category, id, variation, size)
        if (fallback && fallback !== src) {
          setSrc(fallback)
        } else {
          setFailed(true)
        }
      }}
    />
  )
}
