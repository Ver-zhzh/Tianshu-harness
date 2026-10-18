import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { vitestProjectIdentitySource } from './test-vitest-identity.js'

export function createVitestDiscovery(directory: string, api: string, root: string, args: string[], output: string): string {
  const file = join(directory, 'discover.mjs')
  writeFileSync(file, `import {writeFileSync} from 'node:fs';
${vitestProjectIdentitySource(root)}
const api=await import(${JSON.stringify(pathToFileURL(api).href)});
const parsed=api.parseCLI(['vitest',...${JSON.stringify(args)}]);
const ctx=await api.createVitest('test',{...parsed.options,watch:false,run:true});
try {const specs=ctx.globTestSpecifications?await ctx.globTestSpecifications():await ctx.globTestSpecs();
writeFileSync(${JSON.stringify(output)},JSON.stringify(specs.map(s=>({file:s.moduleId??s[1],projectName:s.project?.name??s[0]?.config?.name??'',projectConfig:projectConfig(s.project?.config??s[0]?.config)}))),{mode:0o600});
} finally {await ctx.close()}
`, { mode: 0o600 })
  return file
}
