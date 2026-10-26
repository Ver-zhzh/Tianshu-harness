/* Hook protocol v1. Included after quoteArg; legacy launcher mode stays intact. */
#include <stdint.h>

typedef struct HookSupervisor {
  HANDLE job, parent, stop, inputReady, inputWrite, output;
  CRITICAL_SECTION outputLock;
  BYTE input[65536];
  DWORD inputLength;
  volatile LONG inputSeen;
} HookSupervisor;

typedef struct HookPump { HookSupervisor* host; HANDLE pipe; BYTE kind; } HookPump;

static int hsWriteAll(HANDLE handle, const BYTE* bytes, DWORD count) {
  while (count) {
    DWORD written = 0;
    if (!WriteFile(handle, bytes, count, &written, NULL) || !written) return 0;
    bytes += written; count -= written;
  }
  return 1;
}

static int hsReadAll(HANDLE handle, BYTE* bytes, DWORD count) {
  while (count) {
    DWORD received = 0;
    if (!ReadFile(handle, bytes, count, &received, NULL) || !received) return 0;
    bytes += received; count -= received;
  }
  return 1;
}

static int hsFrame(HookSupervisor* host, BYTE kind, const void* bytes, DWORD length) {
  BYTE header[5];
  header[0] = kind;
  memcpy(header + 1, &length, 4);
  EnterCriticalSection(&host->outputLock);
  int ok = hsWriteAll(host->output, header, 5) && (!length || hsWriteAll(host->output, bytes, length));
  LeaveCriticalSection(&host->outputLock);
  if (!ok) SetEvent(host->stop);
  return ok;
}

static DWORD WINAPI hsControl(LPVOID pointer) {
  HookSupervisor* host = (HookSupervisor*)pointer;
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  BYTE header[5];
  for (;;) {
    DWORD length;
    if (!hsReadAll(input, header, 5)) break;
    memcpy(&length, header + 1, 4);
    if (header[0] == 3 && length == 0) break;
    if (header[0] != 2 || length > sizeof host->input || InterlockedCompareExchange(&host->inputSeen, 1, 0) != 0) break;
    if (!hsReadAll(input, host->input, length)) break;
    host->inputLength = length;
    SetEvent(host->inputReady);
  }
  SetEvent(host->stop);
  return 0;
}

static DWORD WINAPI hsInput(LPVOID pointer) {
  HookSupervisor* host = (HookSupervisor*)pointer;
  hsWriteAll(host->inputWrite, host->input, host->inputLength);
  CloseHandle(host->inputWrite);
  return 0;
}

static DWORD WINAPI hsPump(LPVOID pointer) {
  HookPump* pump = (HookPump*)pointer;
  BYTE buffer[16384];
  DWORD count;
  while (ReadFile(pump->pipe, buffer, sizeof buffer, &count, NULL) && count) {
    if (!hsFrame(pump->host, pump->kind, buffer, count)) break;
  }
  CloseHandle(pump->pipe);
  return 0;
}

static int hsAppend(wchar_t* command, int* length, int capacity, const wchar_t* argument) {
  if (*length) { if (*length >= capacity - 1) return 0; command[(*length)++] = L' '; }
  int count = quoteArg(argument, command + *length, capacity - *length);
  if (count < 0) return 0;
  *length += count;
  return 1;
}

static int hookSupervisor(int argc, wchar_t** argv) {
  HookSupervisor host;
  ZeroMemory(&host, sizeof host);
  InitializeCriticalSection(&host.outputLock);
  host.output = GetStdHandle(STD_OUTPUT_HANDLE);
  host.stop = CreateEventW(NULL, TRUE, FALSE, NULL);
  host.inputReady = CreateEventW(NULL, TRUE, FALSE, NULL);
  const wchar_t* cwd = NULL;
  DWORD parentPid = 0, timeoutMs = 10000, code = 127;
  int index = 2, clean = 1, flags = 0;
  HANDLE control = NULL, inputThread = NULL, outThread = NULL, errThread = NULL;
  HANDLE childInput = NULL, childOutput = NULL, childError = NULL;
  HANDLE outRead = NULL, errRead = NULL, process = NULL;
  HookPump outPump, errPump;
  while (index < argc) {
    if (wcscmp(argv[index], L"--") == 0) { index++; break; }
    if (wcscmp(argv[index], L"--cwd") == 0 && index + 1 < argc) { cwd = argv[++index]; index++; continue; }
    if (wcscmp(argv[index], L"--parent-pid") == 0 && index + 1 < argc) { parentPid = wcstoul(argv[++index], NULL, 10); index++; continue; }
    if (wcscmp(argv[index], L"--timeout-ms") == 0 && index + 1 < argc) { timeoutMs = wcstoul(argv[++index], NULL, 10); index++; continue; }
    break;
  }
  if (index >= argc || !parentPid || !host.stop || !host.inputReady) goto done;
  host.parent = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, parentPid);
  if (!host.parent) goto done;
  {
    FILETIME ours, parent, a, b, c;
    if (!GetProcessTimes(GetCurrentProcess(), &ours, &a, &b, &c) ||
        !GetProcessTimes(host.parent, &parent, &a, &b, &c) || CompareFileTime(&parent, &ours) > 0) goto done;
  }
  {
    DWORD version = 1;
    if (!hsFrame(&host, 1, &version, 4)) goto done;
  }
  control = CreateThread(NULL, 0, hsControl, &host, 0, NULL);
  if (!control) goto done;
  {
    HANDLE waits[3] = { host.stop, host.parent, host.inputReady };
    if (WaitForMultipleObjects(3, waits, FALSE, timeoutMs) != WAIT_OBJECT_0 + 2) goto done;
  }
  host.job = CreateJobObjectW(NULL, NULL);
  if (!host.job) goto done;
  {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limit;
    ZeroMemory(&limit, sizeof limit);
    limit.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(host.job, JobObjectExtendedLimitInformation, &limit, sizeof limit)) goto done;
  }
  {
    SECURITY_ATTRIBUTES security = { sizeof security, NULL, TRUE };
    if (!CreatePipe(&childInput, &host.inputWrite, &security, 0) ||
        !CreatePipe(&outRead, &childOutput, &security, 0) ||
        !CreatePipe(&errRead, &childError, &security, 0)) goto done;
    SetHandleInformation(host.inputWrite, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(outRead, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(errRead, HANDLE_FLAG_INHERIT, 0);
    wchar_t self[32768], command[32768];
    int length = 0;
    if (!GetModuleFileNameW(NULL, self, 32768) ||
        !hsAppend(command, &length, 32768, self) || !hsAppend(command, &length, 32768, L"--hook-child") ||
        !hsAppend(command, &length, 32768, L"--")) goto done;
    for (int argument = index; argument < argc; argument++) if (!hsAppend(command, &length, 32768, argv[argument])) goto done;
    STARTUPINFOEXW startup;
    PROCESS_INFORMATION child;
    ZeroMemory(&startup, sizeof startup); ZeroMemory(&child, sizeof child);
    startup.StartupInfo.cb = sizeof startup;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = childInput;
    startup.StartupInfo.hStdOutput = childOutput;
    startup.StartupInfo.hStdError = childError;
    SIZE_T attributeBytes = 0;
    InitializeProcThreadAttributeList(NULL, 1, 0, &attributeBytes);
    startup.lpAttributeList = (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, attributeBytes);
    if (!startup.lpAttributeList || !InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &attributeBytes)) goto done;
    HANDLE inherited[3] = { childInput, childOutput, childError };
    if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        inherited, sizeof inherited, NULL, NULL)) {
      DeleteProcThreadAttributeList(startup.lpAttributeList); HeapFree(GetProcessHeap(), 0, startup.lpAttributeList); goto done;
    }
    int made = CreateProcessW(self, command, NULL, NULL, TRUE,
      CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, NULL, cwd, &startup.StartupInfo, &child);
    DeleteProcThreadAttributeList(startup.lpAttributeList);
    HeapFree(GetProcessHeap(), 0, startup.lpAttributeList);
    if (!made) goto done;
    process = child.hProcess;
    clean = 0;
    if (!AssignProcessToJobObject(host.job, process)) {
      TerminateProcess(process, 127); WaitForSingleObject(process, 2000); CloseHandle(child.hThread); goto done;
    }
    // The internal launcher belongs to the job before its first instruction.
    if (WaitForSingleObject(host.stop, 0) == WAIT_OBJECT_0 || ResumeThread(child.hThread) == (DWORD)-1) {
      TerminateJobObject(host.job, 127); CloseHandle(child.hThread); goto done;
    }
    CloseHandle(child.hThread);
  }
  CloseHandle(childInput); childInput = NULL;
  CloseHandle(childOutput); childOutput = NULL;
  CloseHandle(childError); childError = NULL;
  outPump.host = &host; outPump.pipe = outRead; outPump.kind = 4;
  errPump.host = &host; errPump.pipe = errRead; errPump.kind = 5;
  outThread = CreateThread(NULL, 0, hsPump, &outPump, 0, NULL);
  errThread = CreateThread(NULL, 0, hsPump, &errPump, 0, NULL);
  inputThread = CreateThread(NULL, 0, hsInput, &host, 0, NULL);
  if (!outThread || !errThread || !inputThread) goto done;
  {
    HANDLE waits[3] = { process, host.stop, host.parent };
    DWORD outcome = WaitForMultipleObjects(3, waits, FALSE, timeoutMs);
    if (outcome == WAIT_OBJECT_0) GetExitCodeProcess(process, &code);
    else { if (outcome == WAIT_TIMEOUT) flags |= 2; TerminateJobObject(host.job, 124); }
  }

done:
  if (childInput) CloseHandle(childInput);
  if (childOutput) CloseHandle(childOutput);
  if (childError) CloseHandle(childError);
  if (process) { CloseHandle(process); process = NULL; }
  if (host.job) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
    ULONGLONG deadline = GetTickCount64() + 1500;
    for (;;) {
      if (!QueryInformationJobObject(host.job, JobObjectBasicAccountingInformation, &accounting, sizeof accounting, NULL)) { clean = 0; break; }
      if (accounting.ActiveProcesses == 0) { clean = 1; break; }
      if (code != 127 && !flags) flags |= 1;
      TerminateJobObject(host.job, 124);
      if (GetTickCount64() >= deadline) { clean = 0; break; }
      Sleep(20);
    }
  }
  if (inputThread) { WaitForSingleObject(inputThread, 100); CloseHandle(inputThread); }
  else if (host.inputWrite) CloseHandle(host.inputWrite);
  if (outThread) { if (WaitForSingleObject(outThread, 100) != WAIT_OBJECT_0) clean = 0; CloseHandle(outThread); }
  else if (outRead) CloseHandle(outRead);
  if (errThread) { if (WaitForSingleObject(errThread, 100) != WAIT_OBJECT_0) clean = 0; CloseHandle(errThread); }
  else if (errRead) CloseHandle(errRead);
  if (control) { CancelSynchronousIo(control); WaitForSingleObject(control, 100); CloseHandle(control); }
  {
    BYTE payload[6];
    memcpy(payload, &code, 4); payload[4] = (BYTE)clean; payload[5] = (BYTE)flags;
    hsFrame(&host, 6, payload, 6);
  }
  if (host.job) CloseHandle(host.job);
  if (host.parent) CloseHandle(host.parent);
  if (host.stop) CloseHandle(host.stop);
  if (host.inputReady) CloseHandle(host.inputReady);
  return (int)code;
}
