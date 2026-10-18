import { randomUUID } from 'node:crypto'
import type { RouteHandler } from './index.js'
import { withAuth } from './route-auth.js'
import { auditStorage, type StorageAudit } from '../storage/audit.js'

interface AuditJob { id: string; status: 'running' | 'complete' | 'cancelled' | 'failed'; files: number; report?: StorageAudit; error?: string; controller: AbortController; settledAt?: number }
export function buildStorageAuditRoutes(options: { apiToken?: string; root?: string; desktopRoot?: string } = {}): Record<string, RouteHandler> {
  const jobs = new Map<string, AuditJob>()
  const view = (job: AuditJob) => ({ id: job.id, status: job.status, files: job.files, error: job.error })
  return {
    'POST /storage/audits': withAuth(() => {
      for (const [id, job] of jobs) if (job.settledAt && Date.now() - job.settledAt > 10 * 60_000) jobs.delete(id)
      if ([...jobs.values()].some(job => job.status === 'running')) return { status: 409, body: { error: 'A storage audit is already running' } }
      // Bound retained reports as well as concurrent work.
      while (jobs.size >= 8) jobs.delete(jobs.keys().next().value!)
      const job: AuditJob = { id: randomUUID(), status: 'running', files: 0, controller: new AbortController() }
      jobs.set(job.id, job)
      setImmediate(() => {
        void auditStorage({ root: options.root, desktopRoot: options.desktopRoot, signal: job.controller.signal, onProgress: files => { job.files = files } })
          .then(report => { job.report = report; job.files = report.totals.files; job.status = 'complete' })
          .catch(error => { job.status = job.controller.signal.aborted ? 'cancelled' : 'failed'; job.error = String(error) })
          .finally(() => { job.settledAt = Date.now() })
      })
      return { status: 202, body: view(job) }
    }, options.apiToken),
    'GET /storage/audits/:auditId': withAuth((_body, params) => {
      const job = jobs.get(params?.auditId ?? '')
      if (!job) return { status: 404, body: { error: 'Audit not found' } }
      const page = Number(params?.page ?? 0), pageSize = 100
      if (!Number.isSafeInteger(page) || page < 0) return { status: 400, body: { error: 'Invalid page' } }
      const report = job.report
      if (!report) return { status: 200, body: view(job) }
      const projects = Object.entries(report.projects), errors = report.errors
      return { status: 200, body: { ...view(job), report: { ...report, projects: Object.fromEntries(projects.slice(page * pageSize, (page + 1) * pageSize)),
        errors: errors.slice(page * pageSize, (page + 1) * pageSize) }, page, hasMore: Math.max(projects.length, errors.length) > (page + 1) * pageSize } }
    }, options.apiToken),
    'DELETE /storage/audits/:auditId': withAuth((_body, params) => {
      const job = jobs.get(params?.auditId ?? '')
      if (!job) return { status: 404, body: { error: 'Audit not found' } }
      if (job.status === 'running') job.controller.abort()
      return { status: 200, body: { cancelled: true } }
    }, options.apiToken),
  }
}
