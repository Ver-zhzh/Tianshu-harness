import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { VisionOnboardingFlow } from '../vision-onboarding-flow.js'

describe('VisionOnboardingFlow', () => {
  it('produces only server discover and onboard descriptors', () => {
    const flow = new VisionOnboardingFlow()
    assert.equal(flow.submit('https://vision.example/v1').kind, 'next')
    assert.equal(flow.submit('vision-custom').kind, 'next')
    assert.equal(flow.choose('apiKeyEnv').kind, 'next')
    const discovery = flow.submit('VISION_API_KEY')
    assert.deepEqual(discovery, {
      kind: 'request',
      request: { kind: 'discover', body: {
        baseUrl: 'https://vision.example/v1', providerName: 'vision-custom', apiKeyEnv: 'VISION_API_KEY',
      } },
    })
    assert.equal(flow.applyDiscovery([{ id: 'custom-vision-1', knownVision: false }]).kind, 'next')
    const onboard = flow.choose('custom-vision-1')
    assert.deepEqual(onboard, {
      kind: 'request',
      request: { kind: 'onboard', body: {
        baseUrl: 'https://vision.example/v1', providerName: 'vision-custom', apiKeyEnv: 'VISION_API_KEY', modelId: 'custom-vision-1',
      } },
    })
    assert.equal(flow.applyOnboardSuccess().kind, 'done')
  })

  it('rejects unlisted models and restores selection after onboarding failure', () => {
    const flow = new VisionOnboardingFlow()
    flow.submit('https://vision.example/v1')
    flow.submit('vision-custom')
    flow.choose('apiKey')
    flow.submit('sk-test')
    flow.applyDiscovery([{ id: 'returned-model', knownVision: false }])
    const rejected = flow.choose('arbitrary-model')
    assert.equal(rejected.kind, 'error')
    assert.equal(flow.view().kind, 'choice')

    flow.choose('returned-model')
    const failed = flow.requestFailed('Vision validation returned no answer text')
    assert.equal(failed.kind, 'error')
    assert.equal(flow.view().kind, 'choice')
    assert.equal(flow.view().options?.[0]?.id, 'returned-model')
  })

  it('does not accept blank credentials or invalid endpoints', () => {
    const flow = new VisionOnboardingFlow()
    assert.equal(flow.submit('not a url').kind, 'error')
    flow.submit('https://vision.example/v1')
    flow.submit('vision-custom')
    flow.choose('apiKey')
    assert.equal(flow.submit('   ').kind, 'error')
  })

  // PR#38 审查应修：空候选不得停在 discovering busy 屏——退回 credential 步给出路。
  it('empty discovery candidates fall back to credential step with error (not stuck busy)', () => {
    const flow = new VisionOnboardingFlow()
    flow.submit('https://vision.example/v1')
    flow.submit('vision-custom')
    flow.choose('apiKeyEnv')
    flow.submit('VISION_API_KEY')
    const result = flow.applyDiscovery([])
    assert.equal(result.kind, 'error')
    // 与 requestFailed 同款回退：回到凭证步可重新发起，而非只能 Esc 的 busy 屏
    assert.notEqual(flow.view().kind, 'busy')
  })
})

it('private discovery cannot retry or persist consent before an explicit network choice', () => {
  const flow = new VisionOnboardingFlow()
  flow.submit('http://localhost:1234/v1'); flow.submit('local'); flow.choose('apiKey'); flow.submit('fixture')
  assert.equal(flow.requestFailed('endpoint_private_network_denied').kind, 'error')
  assert.equal(flow.view().options?.[0]?.id, 'public')
  const retry = flow.choose('private')
  assert.equal(retry.kind, 'request')
  if (retry.kind === 'request') assert.equal(retry.request.body.allowPrivateNetwork, true)
})
