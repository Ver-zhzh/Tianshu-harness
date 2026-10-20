import { accountStore, jwtSubject } from '../auth/account.js'
import type { TokenData } from '../auth/token-store.js'
import { rivetHome } from '../config/paths.js'
import { getNetworkConfig } from '../config/manager.js'
import { createAccountFetch } from '../server/account-network.js'

const endpoint = 'https://tianshuharness.com/token/v1/client/'
export interface AccountLedgerCredential { key: string; userId: string; deviceId: string; sessionId: string; expiresAt: number; scope: 'usage:write' }
interface AccountState extends TokenData { ledgerCredential?: AccountLedgerCredential }
interface CredentialStore { load(): AccountState | null; save(value: AccountState): void }
function sessionId(accessToken: string): string | undefined {
  try {
    const claims = JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString())
    return claims.type === 'access' && typeof claims.session_id === 'string' ? claims.session_id : undefined
  } catch { return undefined }
}

export class AccountLedgerCredentials {
  private flight: Promise<AccountLedgerCredential | undefined> | undefined
  private retryAt = 0
  private last?: AccountLedgerCredential
  constructor(private store: CredentialStore, private fetcher: typeof fetch, private now = Date.now) {}
  available(): boolean {
    const account = this.store.load()
    return Boolean(account && account.expiresAt > this.now() && jwtSubject(account.accessToken) && sessionId(account.accessToken))
  }
  cached(deviceId: string): AccountLedgerCredential | undefined {
    const account = this.store.load(), value = account?.ledgerCredential
    if (!account || account.expiresAt <= this.now() || !value || value.scope !== 'usage:write' || value.deviceId !== deviceId || value.userId !== jwtSubject(account.accessToken) || value.sessionId !== sessionId(account.accessToken) || value.expiresAt <= this.now()+60_000 || !/^tsu_[0-9a-f]{32}$/.test(value.key)) return undefined
    this.last = value
    return value
  }
  async resolve(deviceId: string): Promise<AccountLedgerCredential | undefined> {
    const cached = this.cached(deviceId)
    if (cached) return cached
    if (!this.available() || this.retryAt > this.now()) return undefined
    if (this.flight) return this.flight
    const account = this.store.load()!
    this.flight = (async () => {
      try {
        const response = await this.fetcher(endpoint+'credentials',{method:'POST',headers:{Authorization:`Bearer ${account.accessToken}`,'content-type':'application/json'},body:JSON.stringify({deviceId}),redirect:'error',signal:AbortSignal.timeout(12_000)})
        if (!response.ok) {
          const seconds = Number(response.headers.get('retry-after'))
          this.retryAt = this.now()+Math.max(300_000,Number.isFinite(seconds)&&seconds>0?Math.min(3_600_000,seconds*1000):0)
          return undefined
        }
        const value = await response.json() as AccountLedgerCredential
        const current = this.store.load()
        if (value.userId !== jwtSubject(account.accessToken) || value.deviceId !== deviceId || value.scope !== 'usage:write' || !/^tsu_[0-9a-f]{32}$/.test(value.key) || !Number.isFinite(value.expiresAt) || value.expiresAt <= this.now() || value.expiresAt > this.now()+3_600_000) {
          this.retryAt = this.now()+300_000
          return undefined
        }
        if (!current || current.expiresAt <= this.now() || jwtSubject(current.accessToken) !== value.userId || sessionId(current.accessToken) !== sessionId(account.accessToken)) {
          this.revoke(value)
          return undefined
        }
        const credential = {key:value.key,userId:value.userId,deviceId,sessionId:sessionId(account.accessToken)!,expiresAt:value.expiresAt,scope:'usage:write' as const}
        this.store.save({...current,ledgerCredential:credential})
        this.last = credential
        this.retryAt = 0
        return credential
      } catch { this.retryAt = this.now()+300_000; return undefined }
    })().finally(() => {this.flight=undefined})
    return this.flight
  }
  changed(): void {
    const previous = this.last
    this.last = undefined
    this.retryAt = 0
    const current = this.store.load()
    if (previous && (jwtSubject(current?.accessToken ?? '') !== previous.userId || sessionId(current?.accessToken ?? '') !== previous.sessionId)) this.revoke(previous)
  }
  private revoke(credential: AccountLedgerCredential): void {
    void this.fetcher(endpoint+'revoke',{method:'POST',headers:{Authorization:`Bearer ${credential.key}`,'content-type':'application/json'},body:'{}',redirect:'error',signal:AbortSignal.timeout(5000)}).catch(()=>{})
  }
}

export function createAccountLedgerCredentials(): AccountLedgerCredentials {
  return new AccountLedgerCredentials(accountStore(rivetHome()),createAccountFetch(getNetworkConfig))
}
