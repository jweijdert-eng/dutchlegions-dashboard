import { useRef, useState } from 'react'

// Lichtgewicht vertaling via het (onofficiële) gtx-endpoint van Google Translate.
// Geen API-key nodig; werkt vanuit de browser. Resultaten worden gecached.
const cache = new Map<string, string>()

export type Lang = 'en' | 'nl'

export function cachedTranslation(text: string, lang: Lang): string | undefined {
  return cache.get(`${lang}:${text}`)
}

export async function translate(text: string, lang: Lang): Promise<string> {
  const key = `${lang}:${text}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  try {
    const res = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${lang}&dt=t&q=${encodeURIComponent(text)}`)
    if (!res.ok) throw new Error(String(res.status))
    const data = await res.json() as [Array<[string]>]
    const out = (data[0] ?? []).map(seg => seg[0]).join('')
    cache.set(key, out || text)
    return out || text
  } catch {
    cache.set(key, text)   // bij fout: origineel (niet blijven proberen)
    return text
  }
}

// Hook: geeft een functie die de vertaling teruggeeft (of het origineel tot 'ie binnen is).
// Vertaalt lazy en re-rendert wanneer een vertaling binnenkomt.
export function useTranslate(enabled: boolean, lang: Lang): (text: string) => string {
  const [, force] = useState(0)
  const pending = useRef(new Set<string>())
  return (text: string) => {
    if (!enabled || !text.trim()) return text
    const cached = cachedTranslation(text, lang)
    if (cached !== undefined) return cached
    const key = `${lang}:${text}`
    if (!pending.current.has(key)) {
      pending.current.add(key)
      translate(text, lang).finally(() => { pending.current.delete(key); force(n => n + 1) })
    }
    return text   // origineel tonen tot de vertaling binnen is
  }
}
