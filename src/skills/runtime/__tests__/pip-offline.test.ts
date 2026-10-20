import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { detectPythonInterpreter } from '../interpreter.js'
import { auditRequirements } from '../requirements.js'

it('offline real pip enforces audited hashes and intersections for direct/transitive dependencies', { timeout: 60_000 }, async () => {
  const python = await detectPythonInterpreter()
  assert.ok(python.found && python.pipOk, 'runtime CI must provide Python and pip')
  const pythonPath = python.path
  const root = mkdtempSync(join(tmpdir(), 'runtime-offline-pip-'))
  const wheels = join(root, 'wheels'), pkg = join(root, 'pkg')
  mkdirSync(wheels); mkdirSync(join(pkg, 'config'), { recursive: true })
  try {
    const code = `import sys,zipfile,os
for name in ['rivet_runtime_direct','rivet_runtime_dep']:
 for version in ['1.0','2.0']:
  info=name+'-'+version+'.dist-info'
  with zipfile.ZipFile(os.path.join(sys.argv[1],name+'-'+version+'-py3-none-any.whl'),'w') as z:
   meta='Metadata-Version: 2.1\\nName: '+name+'\\nVersion: '+version+'\\n'
   if name.endswith('direct'): meta+='Requires-Dist: rivet-runtime-dep>=1\\n'
   z.writestr(info+'/METADATA',meta)
   z.writestr(info+'/WHEEL','Wheel-Version: 1.0\\nGenerator: runtime-fixture\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n')
   z.writestr(info+'/RECORD','')
   z.writestr(name+'/__init__.py','__version__='+repr(version))`
    execFileSync(python.path, ['-c', code, wheels])
    function install(source: string, id: string, requirementsFile = 'requirements.txt') {
      const audit = auditRequirements(source, { packageRoot: pkg, requirementsFile })
      assert.ok(audit.ok)
      const audited = join(root, id + '-input'), target = join(root, id)
      for (const [name, content] of Object.entries(audit.audited.files)) {
        const path = join(audited, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content)
      }
      const result = spawnSync(pythonPath, ['-m', 'pip', 'install', '--no-index', '--find-links', wheels, '--no-input', '--no-cache-dir', '--disable-pip-version-check', '--ignore-installed', '--target', target, '-r', join(audited, audit.audited.rootFile)], { encoding: 'utf8', timeout: 30_000 })
      return { result, target }
    }
    writeFileSync(join(pkg, 'constraints.txt'), 'rivet-runtime-direct<2\nrivet-runtime-dep<2 ; python_version >= "3.0"\n')
    writeFileSync(join(pkg, 'config', 'more.txt'), 'rivet-runtime-direct>=1\n')
    const constrained = install('-c ../constraints.txt\n-r more.txt\n', 'constraints', 'config/requirements.txt')
    assert.equal(constrained.result.status, 0, constrained.result.stderr)
    const installed = readdirSync(constrained.target).filter(name => name.endsWith('.dist-info')).sort()
    assert.deepEqual(installed, ['rivet_runtime_dep-1.0.dist-info', 'rivet_runtime_direct-1.0.dist-info'])
    const hash = (name: string) => createHash('sha256').update(readFileSync(join(wheels, name + '-1.0-py3-none-any.whl'))).digest('hex')
    const source = `rivet-runtime-direct==1.0 --hash=sha256:${hash('rivet_runtime_direct')}\nrivet-runtime-dep==1.0 --hash=sha256:${hash('rivet_runtime_dep')}\n`
    const valid = install(source, 'valid-hashes')
    assert.equal(valid.result.status, 0, valid.result.stderr)
    const invalid = install(source.replace(hash('rivet_runtime_direct'), '0'.repeat(64)), 'invalid-hash')
    assert.notEqual(invalid.result.status, 0)
    assert.match(invalid.result.stderr, /HASHES|hashes/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
