import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { win32 } from "node:path";

export interface InhibitorDependencies {
  pid: number;
  platform?: NodeJS.Platform;
  env?: { SystemRoot?: string };
  spawn: (command: string, args: string[], options: SpawnOptions) => Pick<ChildProcess, "pid" | "on">;
  kill: (pid: number, signal: NodeJS.Signals) => void;
}

export function createInhibitor(dependencies: InhibitorDependencies = {
  pid: process.pid,
  spawn: nodeSpawn,
  kill: process.kill.bind(process),
}) {
  let child: ReturnType<InhibitorDependencies["spawn"]> | null = null;
  const owners = new Set<string>();
  const lossListeners = new Set<(owners: string[]) => void>();
  const platform = dependencies.platform ?? process.platform;
  function stopChild() {
    if (!child) return;
    const owned = child;
    child = null;
    if (owned.pid !== undefined) {
      try { dependencies.kill(platform === "win32" ? owned.pid : -owned.pid, "SIGTERM"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
  }
  function startChild() {
    if (child) return;
    let command: string;
    let args: string[];
    if (platform === "linux") {
      command = "/usr/bin/systemd-inhibit";
      args = ["--what=sleep", "--mode=block", "--who=keepgoing", "--why=Pi trabajando",
        "/usr/bin/tail", `--pid=${dependencies.pid}`, "-f", "/dev/null"];
    } else if (platform === "darwin") {
      command = "caffeinate";
      args = ["-i", "-w", String(dependencies.pid)];
    } else if (platform === "win32") {
      const root = (dependencies.env ?? process.env).SystemRoot;
      if (!root || !/^[A-Za-z]:[\\/]/.test(root)) throw new Error("SystemRoot must be an absolute local drive path");
      command = win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      // The execution-state flag belongs to the helper thread, never Pi's main thread.
      // Decimal UInt32 values avoid signed hexadecimal literals in Windows PowerShell 5.1.
      const script = `$ErrorActionPreference = 'Stop'
Add-Type -Namespace Win -Name Sleep -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'
if ([Win.Sleep]::SetThreadExecutionState([uint32]2147483649) -eq 0) { exit 1 }
try {
  while (Get-Process -Id ${dependencies.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 2 }
} finally {
  [void][Win.Sleep]::SetThreadExecutionState([uint32]2147483648)
}`;
      args = ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script];
    } else throw new Error(`Unsupported sleep inhibition platform: ${platform}`);
    const started = dependencies.spawn(command, args, { detached: true, stdio: "ignore", ...(platform === "win32" ? { windowsHide: true } : {}) });
    child = started;
    const clear = () => {
      if (child !== started) return;
      child = null;
      const affected = [...owners];
      owners.clear();
      for (const listener of [...lossListeners]) {
        try { listener(affected.slice()); }
        catch (error) { console.error("keepgoing: sleep inhibitor loss listener failed:", error); }
      }
    };
    started.on("error", clear);
    started.on("exit", clear);
  }
  return {
    get active() { return child !== null; },
    has(owner: string) { return child !== null && owners.has(owner); },
    onLoss(listener: (owners: string[]) => void) {
      lossListeners.add(listener);
      return () => { lossListeners.delete(listener); };
    },
    acquire(owner: string) {
      if (owners.has(owner)) return false;
      startChild();
      owners.add(owner);
      return true;
    },
    release(owner: string) {
      if (!owners.delete(owner)) return false;
      if (!owners.size) stopChild();
      return true;
    },
    start() { return this.acquire("manual"); },
    stop() { return this.release("manual"); },
  };
}
