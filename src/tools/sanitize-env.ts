/** Environment variable prefixes that should be preserved for child processes. */
const SAFE_ENV_PREFIXES = [
  'PATH', 'HOME', 'PWD', 'NODE_ENV', 'TERM', 'LANG', 'LC_', 'XDG_', 'EDITOR', 'VISUAL', 'PAGER', 'SHELL', 'USER', 'LOGNAME', 'TMPDIR', 'TEMP', 'TMP', 'COLOR', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR',
  // Windows-critical: without SystemRoot the child process cannot load system
  // DLLs, causing cmd.exe / powershell.exe to exit(0) with zero output.
  'COMSPEC', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMDATA', 'PUBLIC', 'HOMEDRIVE', 'ALLUSERSPROFILE', 'PROCESSOR_',
  // Toolchain vars: builds (maven/gradle/java/go/rust/android) and version
  // managers rely on these; stripping them broke `mvn`/`java` when launched from
  // a GUI with a minimal env. None contain sensitive keywords, so the KEY/TOKEN/
  // SECRET filter below still removes anything genuinely secret.
  'JAVA_HOME', 'JDK_HOME', 'JRE_HOME', 'CLASSPATH',
  'MAVEN_', 'M2_', 'M2', 'GRADLE_', 'ANT_HOME',
  'GOPATH', 'GOROOT', 'GOBIN', 'GO111MODULE', 'GOFLAGS', 'GOPROXY',
  'CARGO_HOME', 'RUSTUP_HOME',
  'ANDROID_', 'NVM_DIR', 'PYENV', 'SDKMAN_DIR',
  'DOTNET_', 'PYTHONPATH', 'VIRTUAL_ENV', 'CONDA_',
  'PNPM_HOME', 'VOLTA_HOME', 'FNM_DIR', 'MISE_', 'ASDF_', 'RBENV_ROOT', 'GEM_',
  // 注意：NODE_OPTIONS / JAVA_TOOL_OPTIONS 刻意排除（issue #137）——
  // 它们可在子进程启动时注入 --require/-javaagent 任意代码，构成环境污染
  // 攻击面；不含 KEY/TOKEN/SECRET 关键词，敏感过滤兜不住，必须显式剥离。
  'NODE_PATH', 'KUBECONFIG', 'DOCKER_HOST',
] as const

/** Keywords that indicate a sensitive env var — vars containing these substrings are stripped. */
const SENSITIVE_ENV_KEYWORDS = ['KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'CREDENTIAL', 'AUTH', 'PRIVATE'] as const

/** Strip sensitive environment variables before passing to child processes. */
export function sanitizeEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const clean: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase()
    const isSensitive = SENSITIVE_ENV_KEYWORDS.some(kw => upper.includes(kw))
    if (isSensitive) continue
    const isSafe = SAFE_ENV_PREFIXES.some(prefix => upper.startsWith(prefix))
    if (isSafe) {
      clean[key] = value
    }
  }
  return clean
}
