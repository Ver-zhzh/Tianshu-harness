import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OBSTACLE_CASES, ObstacleWorld } from '../experiments/obstacle-fixtures.js'

const make = (id: string) => new ObstacleWorld(OBSTACLE_CASES.find(c => c.id === id)!)

describe('controlled obstacle experiment evidence', () => {
  it('readiness or self-reported met cannot replace browser observation', () => {
    const world = make('sidecar-offline')
    world.execute('todo', { acceptance: [{ status: 'met' }] })
    world.execute('browser_debug', { action: 'observe' })
    assert.equal(world.outcome().objectiveObserved, false)
    world.execute('bash', { command: 'npm run serve:fixture' })
    world.execute('bash', { command: 'npm run ui:probe' })
    assert.equal(world.outcome().objectiveObserved, false)
    world.execute('browser_debug', { action: 'observe' })
    assert.equal(world.outcome().objectiveObserved, true)
  })
  it('stale must be investigated and reverified before becoming current', () => {
    const world = make('stale-attribution')
    world.execute('bash', { command: 'npm run delivery:check' })
    assert.equal(world.outcome().objectiveObserved, false)
    world.execute('bash', { command: 'npm run workspace:state' })
    world.execute('bash', { command: 'npm run test:owned' })
    assert.equal(world.outcome().objectiveObserved, false)
    world.execute('bash', { command: 'npm run delivery:check' })
    assert.equal(world.outcome().objectiveObserved, true)
  })
  it('local serialization does not acquire missing credentials or claim a remote pass', () => {
    const world = make('genuine-missing-credential')
    assert.match(world.execute('bash', { command: 'npm run test:remote' }), /No authenticated request was sent/)
    world.execute('bash', { command: 'npm run test:local' })
    assert.equal(world.outcome().objectiveObserved, false)
    world.execute('read_file', { file_path: 'README.md' })
    assert.equal(world.outcome().objectiveObserved, true)
    assert.equal(world.facts.has('remote-login-passed'), false)
  })
  it('unsupported commands are adapter limitations, not product failure evidence', () => {
    const world = make('missing-global-runner')
    assert.match(world.execute('bash', { command: 'unsupported-command' }), /EXPERIMENT_ADAPTER_UNSUPPORTED/)
    assert.equal(world.outcome().adapterBlocked, 1)
    assert.equal(world.outcome().objectiveObserved, false)
    world.execute('bash', { command: 'npm test' })
    assert.equal(world.outcome().objectiveObserved, true)
  })
})
