// job-launch.exe - a minimal Job Object holder for Windows.
//
// WHY THIS EXISTS
//   On Windows + Git Bash, a background descendant (nohup node ... &) escapes `taskkill /T`:
//   the Win32 parent chain is broken at nohup. Measured (issue #144): the descendant ends up in
//   NO job at all, and assigning the shell to a job *after* it has started does not help either -
//   children forked by an already-running MSYS shell do not inherit membership.
//
//   So the process must be "born in the job": someone that already belongs to the job has to
//   create it. This helper does exactly that, and nothing else:
//
//     1. CreateJobObject + JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
//     2. assign ITSELF into the job
//     3. CreateProcess the real command, inheriting its own std handles
//        (so the parent Node process keeps reading the pipes directly - zero stdio relay)
//     4. wait for the child, exit with its code
//     5. optionally watch the parent: if the parent dies, reap the whole job
//
//   Terminating this helper is therefore the whole fix: the last job handle closes, Windows
//   terminates every process still in the job (the shell, the nohup'd node, the whole fork chain).
//
// usage: job-launch.exe [--cwd <dir>] [--parent-pid <pid>] [--] <exe> [args...]
//
// NOTE: ASCII-only source on purpose (MSVC + a Chinese code page would emit C4819 warnings).
#define _CRT_SECURE_NO_WARNINGS
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0601
#endif
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

static HANDLE g_job = NULL;
static HANDLE g_parent = NULL;

// Quote one argument for CreateProcess's command line (MSVCRT rules). Returns UTF-16 units or -1 on overflow.
static int quoteArg(const wchar_t* in, wchar_t* out, int cap) {
  int written = 0;
  int needsQuotes = (in[0] == 0);
  for (const wchar_t* cursor = in; *cursor; cursor++) {
    if (*cursor == L' ' || *cursor == L'\t' || *cursor == L'"') { needsQuotes = 1; break; }
  }
  if (!needsQuotes) {
    size_t length = wcslen(in);
    if (cap <= 0 || length >= (size_t)cap) return -1;
    wmemcpy(out, in, length + 1);
    return (int)length;
  }
  if (cap < 3) return -1;
  out[written++] = L'"';
  int backslashes = 0;
  for (const wchar_t* cursor = in; ; cursor++) {
    if (*cursor == L'\\') { backslashes++; continue; }
    int slashCount = (*cursor == L'"' || *cursor == 0) ? backslashes * 2 : backslashes;
    if (*cursor == L'"') slashCount++;
    for (int count = 0; count < slashCount; count++) {
      if (written >= cap - 1) return -1;
      out[written++] = L'\\';
    }
    backslashes = 0;
    if (*cursor == 0) break;
    if (written >= cap - 1) return -1;
    out[written++] = *cursor;
  }
  if (written >= cap - 1) return -1;
  out[written++] = L'"';
  out[written] = 0;
  return written;
}

// Watchdog: if the parent process goes away (crash / hard kill), reap the job so we never leave
// an orphaned command tree behind.
static DWORD WINAPI parentWatch(LPVOID unused) {
  (void)unused;
  if (g_parent) {
    WaitForSingleObject(g_parent, INFINITE);
    if (g_job) TerminateJobObject(g_job, 0);
    ExitProcess(0);
  }
  return 0;
}

static const char hookProtocolMarker[] = "RIVET_HOOK_PROTOCOL=1";
#include "job-hook-supervisor.h"

int wmain(int argc, wchar_t** argv) {
  if (argc > 1 && wcscmp(argv[1], L"--hook-capabilities") == 0) { printf("{\"hookProtocol\":1,\"marker\":\"%s\"}\n", hookProtocolMarker); return 0; }
  if (argc > 1 && wcscmp(argv[1], L"--hook-supervisor") == 0) return hookSupervisor(argc, argv);
  int hookChildMode = argc > 1 && wcscmp(argv[1], L"--hook-child") == 0;
  const wchar_t* cwd = NULL;
  DWORD parentPid = 0;
  int index = hookChildMode ? 2 : 1;
  while (index < argc) {
    if (wcscmp(argv[index], L"--") == 0) { index++; break; }
    if (wcscmp(argv[index], L"--cwd") == 0 && index + 1 < argc) { cwd = argv[++index]; index++; continue; }
    if (wcscmp(argv[index], L"--parent-pid") == 0 && index + 1 < argc) { parentPid = (DWORD)wcstoul(argv[++index], NULL, 10); index++; continue; }
    break;
  }
  if (index >= argc) {
    fprintf(stderr, "usage: job-launch.exe [--cwd <dir>] [--parent-pid <pid>] [--] <exe> [args...]\n");
    return 2;
  }

  if (!hookChildMode) {
  g_job = CreateJobObjectW(NULL, NULL);
  if (!g_job) { fprintf(stderr, "job-launch: CreateJobObject failed %lu\n", GetLastError()); return 1; }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION info;
  ZeroMemory(&info, sizeof info);
  info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(g_job, JobObjectExtendedLimitInformation, &info, sizeof info)) {
    fprintf(stderr, "job-launch: SetInformationJobObject failed %lu\n", GetLastError());
    return 1;
  }

  // Step 2: we join the job FIRST, so everything we create inherits membership.
  if (!AssignProcessToJobObject(g_job, GetCurrentProcess())) {
    fprintf(stderr, "job-launch: self-assign failed %lu\n", GetLastError());
    return 1;
  }

  }

  // Build the child command line from argv (proper MSVCRT quoting).
  static wchar_t cmd[32768];
  const int capacity = (int)(sizeof cmd / sizeof cmd[0]);
  int length = 0;
  const wchar_t* commandBase = wcsrchr(argv[index], L'\\');
  commandBase = commandBase ? commandBase + 1 : argv[index];
  if (hookChildMode && argc - index == 5 && _wcsicmp(commandBase, L"cmd.exe") == 0 &&
      _wcsicmp(argv[index + 1], L"/d") == 0 && _wcsicmp(argv[index + 2], L"/s") == 0 && _wcsicmp(argv[index + 3], L"/c") == 0) {
    // cmd.exe does not use MSVCRT argument escaping. Expand the path once from
    // an environment variable, inside cmd's two quote pairs; literal % stays literal.
    if (wcschr(argv[index + 4], L'"') || !SetEnvironmentVariableW(L"RIVET_HOOK_SCRIPT", argv[index + 4])) return 2;
    length = _snwprintf(cmd, capacity, L"\"%ls\" /d /v:off /s /c \"\"%%RIVET_HOOK_SCRIPT%%\"\"", argv[index]);
    if (length < 0 || length >= capacity) return 2;
  } else for (int argument = index; argument < argc; argument++) {
    if (argument > index) {
      if (length >= capacity - 1) { fprintf(stderr, "job-launch: command line too long\n"); return 2; }
      cmd[length++] = L' ';
    }
    int written = quoteArg(argv[argument], cmd + length, capacity - length);
    if (written < 0) { fprintf(stderr, "job-launch: command line too long\n"); return 2; }
    length += written;
  }
  cmd[length] = 0;

  STARTUPINFOW si;
  PROCESS_INFORMATION pi;
  ZeroMemory(&si, sizeof si);
  si.cb = sizeof si;
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  ZeroMemory(&pi, sizeof pi);

  if (!CreateProcessW(NULL, cmd, NULL, NULL, TRUE, 0, NULL, cwd, &si, &pi)) {
    fprintf(stderr, "job-launch: CreateProcess failed %lu\n", GetLastError());
    return 127;
  }

  if (parentPid != 0) {
    // PROCESS_QUERY_LIMITED_INFORMATION is needed for the creation-time check below.
    g_parent = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, parentPid);
    if (g_parent) {
      // Recycled-pid guard: our own creation necessarily precedes any process that
      // later reuses the pid, so a "parent" born AFTER us proves the real parent
      // died and the pid was recycled. Treat it as parent-dead (reap the job)
      // rather than watching a stranger. Strict '>': FILETIME granularity can make
      // a legitimate parent's stamp equal ours - equality must not reap.
      FILETIME ours, parent, dummy1, dummy2, dummy3, dummy4;
      ULARGE_INTEGER o, p;
      int mismatch = 0;
      if (GetProcessTimes(GetCurrentProcess(), &ours, &dummy1, &dummy2, &dummy3) &&
          GetProcessTimes(g_parent, &parent, &dummy4, &dummy2, &dummy3)) {
        o.LowPart = ours.dwLowDateTime; o.HighPart = ours.dwHighDateTime;
        p.LowPart = parent.dwLowDateTime; p.HighPart = parent.dwHighDateTime;
        mismatch = p.QuadPart > o.QuadPart;
      }
      if (mismatch) {
        fprintf(stderr, "job-launch: parent pid %lu was recycled (created after us) - treating parent as dead\n", (unsigned long)parentPid);
        CloseHandle(g_parent);
        g_parent = NULL;
        if (g_job) TerminateJobObject(g_job, 0);
        return 0; // process exit closes the job handle -> KILL_ON_JOB_CLOSE
      }
      HANDLE th = CreateThread(NULL, 0, parentWatch, NULL, 0, NULL);
      if (th) CloseHandle(th);
    } else {
      DWORD err = GetLastError();
      if (err == ERROR_INVALID_PARAMETER) {
        // No such process: the parent died before we could open it. The watchdog
        // exists to prevent orphans - reap now instead of running unwatched.
        fprintf(stderr, "job-launch: parent pid %lu already gone - reaping job\n", (unsigned long)parentPid);
        if (g_job) TerminateJobObject(g_job, 0);
        return 0;
      }
      // Other failures (e.g. access denied): keep the old behavior (no watchdog)
      // rather than killing a possibly-healthy tree.
      fprintf(stderr, "job-launch: OpenProcess(parent=%lu) failed %lu - watchdog disabled\n", (unsigned long)parentPid, err);
    }
  }

  WaitForSingleObject(pi.hProcess, INFINITE);
  DWORD code = 0;
  GetExitCodeProcess(pi.hProcess, &code);
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  // Closing the job handle (process exit) triggers KILL_ON_JOB_CLOSE for anything left behind.
  return (int)code;
}
