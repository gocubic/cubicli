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
