import { configuredEndpointNetwork } from '../config/endpoint-network-policy.js'
import { discoverVisionModels, validateVisionModel } from '../api/vision-model-onboarding.js'
import { registerVisionModelConfig } from '../config/manager.js'
import type { VisionOnboardingRequest } from './vision-onboarding-flow.js'

export async function executeVisionOnboarding(request: VisionOnboardingRequest) {
  const apiKeyEnv = request.body.apiKeyEnv
  if (apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
    throw new Error('apiKeyEnv must be a valid environment variable name')
  }
  const resolvedEnvKey = apiKeyEnv ? process.env[apiKeyEnv]?.trim() : undefined
  if (apiKeyEnv && !resolvedEnvKey) {
    throw new Error(`Environment variable "${apiKeyEnv}" is not set or is blank in this process`)
  }
  const network = configuredEndpointNetwork(request.body, request.body.baseUrl, request.body.providerName)
  const requestWithResolvedKey = {
    ...network,
    ...request.body,
    ...(resolvedEnvKey ? { apiKey: resolvedEnvKey } : {}),
  }
  if (request.kind === 'discover') {
    return await discoverVisionModels(requestWithResolvedKey)
  }
  await validateVisionModel({
    ...network,
    baseUrl: request.body.baseUrl,
    providerName: request.body.providerName,
    modelId: request.body.modelId,
    ...(requestWithResolvedKey.apiKey ? { apiKey: requestWithResolvedKey.apiKey } : {}),
  })
  registerVisionModelConfig({
    endpointNetworkPolicy: network.endpointNetworkPolicy,
    providerName: request.body.providerName,
    baseUrl: request.body.baseUrl,
    ...(request.body.apiKey && !apiKeyEnv ? { apiKey: request.body.apiKey } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    modelId: request.body.modelId,
  })
  return {}
}
