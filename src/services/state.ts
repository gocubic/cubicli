import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { STATE_DIR, STATE_FILE, type DopplerConfig } from '../config/projects';

export interface ProcessInfo {
  pid: number;
  port: number;
  status: 'starting' | 'running' | 'stopped' | 'error';
}

export interface AppState {
  activeProject: string | null;
  dopplerConfig: DopplerConfig;
  startedAt: string | null;
  processes: Record<string, ProcessInfo>;
}

const DEFAULT_STATE: AppState = {
  activeProject: null,
  dopplerConfig: 'dev',
  startedAt: null,
  processes: {},
};

export async function ensureStateDir(): Promise<void> {
  if (!existsSync(STATE_DIR)) {
    await mkdir(STATE_DIR, { recursive: true });
  }
}

export async function loadState(): Promise<AppState> {
  await ensureStateDir();

  try {
    if (existsSync(STATE_FILE)) {
      const content = await readFile(STATE_FILE, 'utf-8');
      return { ...DEFAULT_STATE, ...JSON.parse(content) };
    }
  } catch {
    // Ignore errors, return default state
  }

  return { ...DEFAULT_STATE };
}

export async function saveState(state: AppState): Promise<void> {
  await ensureStateDir();
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

export async function updateState(updates: Partial<AppState>): Promise<AppState> {
  const state = await loadState();
  const newState = { ...state, ...updates };
  await saveState(newState);
  return newState;
}

export async function clearState(): Promise<void> {
  await saveState(DEFAULT_STATE);
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface ProcessStats {
  cpu: number;  // percentage
  memory: number;  // MB
}

export async function getProcessStats(pid: number): Promise<ProcessStats | null> {
  try {
    // Use ps command to get CPU and memory usage (works on macOS and Linux)
    const proc = Bun.spawn(['ps', '-p', pid.toString(), '-o', '%cpu=,rss='], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const output = await new Response(proc.stdout).text();
    await proc.exited;

    const parts = output.trim().split(/\s+/);
    if (parts.length >= 2) {
      const cpu = parseFloat(parts[0]) || 0;
      const rssKb = parseInt(parts[1], 10) || 0;
      const memoryMb = rssKb / 1024;

      return { cpu, memory: memoryMb };
    }
  } catch {
    // Process might not exist or ps failed
  }
  return null;
}

export async function verifyRunningProcesses(): Promise<AppState> {
  const state = await loadState();

  let changed = false;
  for (const [appName, info] of Object.entries(state.processes)) {
    // Check any non-stopped process - if PID is dead, mark as stopped
    if (info.status !== 'stopped' && !isProcessRunning(info.pid)) {
      state.processes[appName] = { ...info, status: 'stopped' };
      changed = true;
    }
  }

  // If all processes stopped, clear active project
  const allStopped = Object.values(state.processes).every(p => p.status === 'stopped');
  if (allStopped && state.activeProject) {
    state.activeProject = null;
    state.startedAt = null;
    state.processes = {};
    changed = true;
  }

  if (changed) {
    await saveState(state);
  }

  return state;
}

/**
 * Get all PIDs using a specific port using multiple methods
 */
export async function getPidsOnPort(port: number): Promise<number[]> {
  const pids = new Set<number>();

  // Method 1: lsof
  try {
    const proc = Bun.spawn(['lsof', '-t', `-i:${port}`], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    output
      .trim()
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => parseInt(line.trim(), 10))
      .filter((pid) => !isNaN(pid))
      .forEach((pid) => pids.add(pid));
  } catch {
    // lsof failed, try other methods
  }

  // Method 2: lsof with TCP specifically
  try {
    const proc = Bun.spawn(['lsof', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    output
      .trim()
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => parseInt(line.trim(), 10))
      .filter((pid) => !isNaN(pid))
      .forEach((pid) => pids.add(pid));
  } catch {
    // Ignore
  }

  return Array.from(pids);
}

/**
 * Check if a port is currently in use
 */
export async function isPortInUse(port: number): Promise<boolean> {
  const pids = await getPidsOnPort(port);
  return pids.length > 0;
}

/**
 * Kill a single process with SIGTERM then SIGKILL
 */
async function killProcess(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return; // Process already dead
  }

  // Wait for graceful shutdown
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!isProcessRunning(pid)) return;
  }

  // Force kill
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already dead
  }

  // Wait for force kill to take effect
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!isProcessRunning(pid)) return;
  }
}

/**
 * Kill all processes using a specific port with retries
 */
export async function killProcessesOnPort(port: number): Promise<void> {
  const maxAttempts = 3;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const pids = await getPidsOnPort(port);
    if (pids.length === 0) return;

    // Kill all found processes
    await Promise.all(pids.map((pid) => killProcess(pid)));

    // Wait and verify
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Check if port is now free
    if (!(await isPortInUse(port))) return;
  }

  // Last resort: use fuser to force kill
  try {
    await Bun.spawn(['fuser', '-k', `${port}/tcp`], {
      stdout: 'pipe',
      stderr: 'pipe',
    }).exited;
  } catch {
    // fuser might not be available
  }
}

/**
 * Reset the nx daemon to clear any stale state
 */
export async function resetNxDaemon(projectPath: string): Promise<void> {
  try {
    const proc = Bun.spawn(['npx', 'nx', 'reset'], {
      cwd: projectPath,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await proc.exited;
  } catch {
    // Ignore errors - nx reset is best-effort
  }
}

/**
 * Try to actually bind to a port to verify it's free
 * More reliable than lsof-based detection
 */
export async function isPortActuallyFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const server = Bun.serve({
        port,
        fetch() {
          return new Response('test');
        },
      });
      // Port is free - close the server immediately
      server.stop();
      resolve(true);
    } catch {
      // Port is in use
      resolve(false);
    }
  });
}

/**
 * Ensure all specified ports are available by killing any processes using them
 */
export async function ensurePortsAvailable(ports: number[]): Promise<void> {
  const maxRetries = 5;

  for (let retry = 0; retry < maxRetries; retry++) {
    // Kill processes on all ports
    await Promise.all(ports.map((port) => killProcessesOnPort(port)));

    // Give OS time to release the ports
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Verify all ports are actually free using TCP binding test
    let allFree = true;
    for (const port of ports) {
      if (!(await isPortActuallyFree(port))) {
        allFree = false;
        break;
      }
    }

    if (allFree) {
      return; // Success - all ports are free
    }

    // Wait longer before next retry
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // Last resort - throw an error or just continue and hope for the best
  // We'll log a warning but continue anyway
}
