/** Public TestProject.config fields describing execution conditions, shared by discovery and observers. */
export function vitestProjectIdentitySource(root: string): string {
  return `const conditionKeys=['root','name','environment','environmentOptions','setupFiles','globalSetup','provide','pool','poolOptions','browser','include','exclude','includeSource','typecheck'];
const stableConfig=v=>Array.isArray(v)?v.map(stableConfig):v instanceof RegExp?String(v):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stableConfig(v[k])])):typeof v==='function'?String(v):typeof v==='string'?v.split(${JSON.stringify(root)}).join('<repository>'):v;
const projectConfig=c=>JSON.stringify(stableConfig(Object.fromEntries(conditionKeys.filter(k=>c?.[k]!==undefined).map(k=>[k,c[k]]))));
`
}
