import { createHash } from 'node:crypto'

export const testScopeDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function normalizedProjectConfig(value: any, root: string): any {
  return Array.isArray(value) ? value.map(v => normalizedProjectConfig(v, root)) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().filter(k => !['id', 'cacheDirectory'].includes(k)).map(k => [k, normalizedProjectConfig(value[k], root)]))
    : typeof value === 'string' ? value.split(root).join('<repository>') : value
}

/** Shared by the native Jest sequencer and reporter; never use arrival ordinals. */
export function jestProjectIdentitySource(root: string, identities: string): string {
  return `const crypto=require('node:crypto');
const root=${JSON.stringify(root)};
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().filter(k=>!['id','cacheDirectory'].includes(k)).map(k=>[k,stable(v[k])])):typeof v==='string'?v.split(root).join('<repository>'):v;
const project=c=>{const mapping=JSON.parse(require('node:fs').readFileSync(${JSON.stringify(identities)},'utf8')),item=mapping.find(m=>m.id===c.id);const digest=crypto.createHash('sha256').update(JSON.stringify(stable(c))).digest('hex');return item?.digest===digest?item.project:'project_identity_unresolved';};
const scope=t=>({path:require('node:path').relative(root,t.path).replaceAll('\\\\','/'),project:project(t.context.config),label:t.context.config.displayName?.name??''});
`
}
