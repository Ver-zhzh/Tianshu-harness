import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readEvidenceFacts } from '../evidence-facts.js'
import { readDeliveryReceipt, recordDeliveryReceipt } from '../delivery-receipt.js'
import { saveVerificationRun } from '../verification-runs.js'

test('persistent facts preserve all commits, legacy receipts, versions and session isolation', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'evidence-facts-')), prior = process.env.RIVET_SESSION_DIR
  process.env.RIVET_SESSION_DIR = join(cwd, 'sessions')
  try {
    const dir = join(cwd, 'sessions', 'A'); mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'delivery-receipt.json'), JSON.stringify({ version: 1, sessionId: 'A', commitSha: 'a'.repeat(40) }))
    recordDeliveryReceipt(cwd, 'A', 'b'.repeat(40)); recordDeliveryReceipt(cwd, 'A', 'b'.repeat(40))
    assert.equal(readDeliveryReceipt(cwd, 'A'), 'b'.repeat(40))
    saveVerificationRun(cwd, { executionId: 'run', sessionId: 'A', cwd, command: 'fixture', executionState: 'exited', outcome: 'passed', coverageStatus: 'partial', status: 'passed', scope: 'targeted', workspaceFingerprint: 'v1', buildId: 'test', contractVersion: 2 })
    const facts = readEvidenceFacts(cwd, 'A')
    assert.deepEqual(facts.commits, ['a'.repeat(40), 'b'.repeat(40)])
    assert.equal(facts.resolve('execution:run').validity, 'unknown')
    assert.equal(readEvidenceFacts(cwd, 'A', 'v2').resolve('execution:run').validity, 'stale')
    assert.equal(readEvidenceFacts(cwd, 'B').resolve('execution:run').presence, 'missing')
    writeFileSync(join(dir, 'verification-runs.jsonl'), '{broken}\n')
    assert.equal(readEvidenceFacts(cwd, 'A').resolve('execution:run').presence, 'invalid')
  } finally { if (prior === undefined) delete process.env.RIVET_SESSION_DIR; else process.env.RIVET_SESSION_DIR = prior; rmSync(cwd, { recursive: true, force: true }) }
})
