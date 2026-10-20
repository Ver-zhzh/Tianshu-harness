import { it } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const native = fileURLToPath(new URL('../../../native/', import.meta.url))

it('native launcher source keeps argv, cwd, quoting and process creation on wide Windows APIs', () => {
  const source = readFileSync(join(native, 'job-launch.c'), 'utf8')
  assert.ok(/\bwmain\s*\(int argc, wchar_t\*\* argv\)/.test(source), 'wide CRT entry is required')
  assert.ok(/quoteArg\(const wchar_t\* in, wchar_t\* out/.test(source), 'quoting must preserve wide argv')
  assert.ok(/const wchar_t\* cwd/.test(source), 'cwd must remain wide')
  assert.ok(/STARTUPINFOW/.test(source), 'wide startup information is required')
  assert.ok(/CreateProcessW\s*\(/.test(source), 'CreateProcessW must create the child')
  assert.ok(/wcscmp\s*\(/.test(source), 'option parsing must not narrow argv')
  assert.ok(/wcstoul\s*\(/.test(source), 'parent PID parsing must not narrow argv')
  assert.ok(/sizeof cmd\s*\/\s*sizeof cmd\[0\]/.test(source), 'command capacity must count UTF-16 units')
  assert.ok(!/\bmain\s*\(|CreateProcessA\s*\(|STARTUPINFOA|GetCurrentDirectoryA/.test(source), 'ANSI process handoff is forbidden')
})

it('native build source isolates per-architecture output and compiles the absolute tracked C source', () => {
  const batch = readFileSync(join(native, 'build-windows.bat'), 'utf8')
  assert.ok(/%~dp0win32-%TARGET%/.test(batch), 'default output must be architecture-specific')
  assert.ok(/%~2/.test(batch), 'the packer output directory must be honored')
  assert.ok(/\/Fe:"%OUTPUT_DIR%\\job-launch\.exe"/.test(batch), 'executable output must be isolated')
  assert.ok(/\/Fo:"%OUTPUT_DIR%\\job-launch\.obj"/.test(batch), 'object output must be isolated')
  assert.ok(/"%~dp0job-launch\.c"/.test(batch), 'C source must use its absolute tracked path')
  assert.ok(!/\/Fe:job-launch\.exe(?:\s|$)/.test(batch), 'the preferred host helper must not be overwritten')
})

it('native Windows Unicode argv roundtrip preserves cwd, filename, message, empty args and quoting', {
  skip: process.platform !== 'win32' ? 'requires native Windows and MSVC; source contracts run on this host' : false,
  timeout: 150_000,
}, context => {
  const root = mkdtempSync(join(tmpdir(), 'rivet-native-wide-'))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  for (const file of ['job-launch.c', 'build-windows.bat']) cpSync(join(native, file), join(root, file))
  const build = spawnSync(process.env.ComSpec || process.env.COMSPEC || 'cmd.exe', ['/d', '/c', 'build-windows.bat', process.arch], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120_000,
  })
  assert.equal(build.status, 0, build.stdout + build.stderr)
  const cwd = join(root, '中文 工作区-🧭-𠮷')
  mkdirSync(cwd)
  const filename = '提交 文件-📄-𠮷.txt'
  const content = 'Unicode fixture 汉字 🧭 𠮷'
  writeFileSync(join(cwd, filename), content)
  const probe = join(cwd, '参数 探针-🧪.cjs')
  writeFileSync(probe, "const fs = require('node:fs'); process.stdout.write(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), content: fs.readFileSync(process.argv[2], 'utf8') }));")
  const args = [filename, 'fix: 中文 "🧭" 𠮷 & message', '', '目录 𠮷\\', 'a\\"b', ':(glob)*']
  const result = spawnSync(join(root, `win32-${process.arch}`, 'job-launch.exe'), ['--cwd', cwd, '--parent-pid', String(process.pid), '--', process.execPath, probe, ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10_000,
  })
  assert.equal(result.status, 0, result.stderr)
  const actual = JSON.parse(result.stdout)
  assert.equal(realpathSync(actual.cwd), realpathSync(cwd))
  assert.deepEqual(actual.args, args)
  assert.equal(actual.content, content)
})
