import { useEffect, useRef, useState } from 'react'
import type { TokenData } from '../auth/sso'
import { tokenScopes } from '../api/esi'
import { CORP_WALLET_SCOPE, loadCorpWallets, type CorpWalletData } from '../api/corpWallet'

/**
 * De corp wallets die een van deze characters mag lezen, elke vijf minuten opnieuw zolang
 * het tabblad zichtbaar is. Heeft geen enkel character de toestemming, dan gaat er niets
 * naar ESI. Een mislukte verversing laat de vorige stand staan.
 */
export function useCorpWallets(tokens: TokenData[]) {
  const key = tokens.filter(t => tokenScopes(t.accessToken).includes(CORP_WALLET_SCOPE)).map(t => t.characterId).join('|')
  const tokensRef = useRef(tokens)
  tokensRef.current = tokens
  const [state, setState] = useState<{ key: string; wallets: CorpWalletData[]; time: number } | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!key) return
    const controller = new AbortController()
    loadCorpWallets(tokensRef.current, controller.signal)
      .then(r => { if (!controller.signal.aborted) setState({ key, wallets: r.wallets, time: Date.now() }) })
      .catch(() => { /* volgende ronde opnieuw */ })
    return () => controller.abort()
  }, [key, tick])

  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState === 'visible') setTick(n => n + 1) }, 5 * 60_000)
    return () => clearInterval(timer)
  }, [])

  return state?.key === key ? state : null
}
