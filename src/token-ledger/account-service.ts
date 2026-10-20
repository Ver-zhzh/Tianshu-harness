import { TokenLedgerService } from './service.js'
import { createAccountLedgerCredentials } from './account-credentials.js'
import { createAccountFetch } from '../server/account-network.js'
import { getNetworkConfig } from '../config/manager.js'
import type { Config } from '../config/schema.js'
export function createAccountLedgerService(config: Config): TokenLedgerService {
  const service = new TokenLedgerService(config,{accountCredentials:createAccountLedgerCredentials(),fetchImpl:createAccountFetch(getNetworkConfig) as unknown as NonNullable<import('./service.js').TokenLedgerServiceDeps['fetchImpl']>})
  service.accountChanged()
  return service
}
