import treeKill from 'tree-kill';
import { appendFile, readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { APPS, LOG_DIR, type AppConfig, type DopplerConfig, type Project } from '../config/projects';
import { loadState, saveState, isProcessRunning, getProcessStats, type AppState, type ProcessInfo, type ProcessStats } from './state';

const MAX_LOG_LINES = 10000;

export interface LogBuffer {
  lines: string[];
  searchMatches: number[];
}

export class ProcessManager {
  private processes: Map<string, Bun.Subprocess> = new Map();
  private adoptedPids: Map<string, number> = new Map(); // PIDs of processes we didn't spawn
  private logBuffers: Map<string, LogBuffer> = new Map();
  private processStats: Map<string, ProcessStats> = new Map();
  private onLogUpdate?: (appName: string, line: string) => void;
  private truncateCounter = 0;

  constructor() {
    // Initialize log buffers for each app
    for (const app of APPS) {
      this.logBuffers.set(app.name, { lines: [], searchMatches: [] });
    }
    // Ensure log directory exists
    this.ensureLogDir();
  }

  private async ensureLogDir(): Promise<void> {
    if (!existsSync(LOG_DIR)) {
      await mkdir(LOG_DIR, { recursive: true });
    }
  }

  private getLogFilePath(appName: string): string {
    return `${LOG_DIR}/${appName}.log`;
  }

  private async appendToLogFile(appName: string, line: string): Promise<void> {
    try {
      await this.ensureLogDir();
      await appendFile(this.getLogFilePath(appName), line + '\n');
    } catch {
      // Ignore write errors
    }
  }

  private async loadLogsFromFile(appName: string): Promise<void> {
    try {
      const filePath = this.getLogFilePath(appName);
      if (!existsSync(filePath)) return;

      const content = await readFile(filePath, 'utf-8');
      const lines = content.split('\n').filter(line => line.trim());

      // Take only the last MAX_LOG_LINES
      const recentLines = lines.slice(-MAX_LOG_LINES);

      const buffer = this.logBuffers.get(appName);
      if (buffer) {
        buffer.lines = recentLines;
      }
    } catch {
      // Ignore read errors
    }
  }

  private async truncateLogFile(appName: string): Promise<void> {
    try {
      const filePath = this.getLogFilePath(appName);
      if (!existsSync(filePath)) return;

      const content = await readFile(filePath, 'utf-8');
      const lines = content.split('\n').filter(line => line.trim());

      if (lines.length > MAX_LOG_LINES) {
        const truncatedLines = lines.slice(-MAX_LOG_LINES);
        await writeFile(filePath, truncatedLines.join('\n') + '\n');
      }
    } catch {
      // Ignore truncate errors
    }
  }

  async updateStats(): Promise<void> {
    const state = await loadState();
    for (const [appName, info] of Object.entries(state.processes)) {
      if (info.status === 'running') {
        const stats = await getProcessStats(info.pid);
        if (stats) {
          this.processStats.set(appName, stats);
        }
      }
    }

    // Truncate log files every 60 seconds
    this.truncateCounter++;
    if (this.truncateCounter >= 60) {
      this.truncateCounter = 0;
      for (const app of APPS) {
        await this.truncateLogFile(app.name);
      }
    }
  }

  getStats(appName: string): ProcessStats | undefined {
    return this.processStats.get(appName);
  }

  async adoptRunningProcesses(): Promise<void> {
    const state = await loadState();
    for (const [appName, info] of Object.entries(state.processes)) {
      if (info.status === 'running' && isProcessRunning(info.pid)) {
        // Track this PID as adopted (we can kill it but can't read its output)
        this.adoptedPids.set(appName, info.pid);
        // Load recent logs from file
        await this.loadLogsFromFile(appName);
      }
    }
  }

  setLogUpdateHandler(handler: (appName: string, line: string) => void): void {
    this.onLogUpdate = handler;
  }

  getLogBuffer(appName: string): LogBuffer {
    return this.logBuffers.get(appName) || { lines: [], searchMatches: [] };
  }

  clearLogBuffer(appName: string): void {
    this.logBuffers.set(appName, { lines: [], searchMatches: [] });
    // Also clear the log file
    writeFile(this.getLogFilePath(appName), '').catch(() => {});
  }

  private addLogLine(appName: string, line: string): void {
    const buffer = this.logBuffers.get(appName);
    if (!buffer) return;

    buffer.lines.push(line);

    // Ring buffer - remove oldest if over limit
    if (buffer.lines.length > MAX_LOG_LINES) {
      buffer.lines.shift();
    }

    // Persist to file (fire and forget)
    this.appendToLogFile(appName, line);

    this.onLogUpdate?.(appName, line);
  }

  async startAll(project: Project, dopplerConfig: DopplerConfig): Promise<void> {
    // Clear log buffers
    for (const app of APPS) {
      this.clearLogBuffer(app.name);
    }

    const state = await loadState();
    state.activeProject = project.alias;
    state.dopplerConfig = dopplerConfig;
    state.startedAt = new Date().toISOString();
    state.processes = {};

    for (const app of APPS) {
      await this.startApp(app, project, dopplerConfig, state);
    }

    await saveState(state);
  }

  private async startApp(
    app: AppConfig,
    project: Project,
    dopplerConfig: DopplerConfig,
    state: AppState
  ): Promise<void> {
    const cmd = ['doppler', 'run', '--config', dopplerConfig, '--', ...app.command.split(' ')];

    const proc = Bun.spawn({
      cmd,
      cwd: project.path,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        FORCE_COLOR: '1', // Preserve colors
      },
    });

    this.processes.set(app.name, proc);

    state.processes[app.name] = {
      pid: proc.pid,
      port: app.port,
      status: 'starting',
    };

    // Stream stdout
    this.streamOutput(app.name, proc.stdout);
    this.streamOutput(app.name, proc.stderr);

    // Update status when process is ready (after a brief delay)
    setTimeout(async () => {
      const currentState = await loadState();
      if (currentState.processes[app.name] && isProcessRunning(proc.pid)) {
        currentState.processes[app.name].status = 'running';
        await saveState(currentState);
      }
    }, 3000);

    // Handle process exit
    proc.exited.then(async (code) => {
      const currentState = await loadState();
      if (currentState.processes[app.name]) {
        currentState.processes[app.name].status = code === 0 ? 'stopped' : 'error';
        await saveState(currentState);
      }
      this.processes.delete(app.name);
    });
  }

  private async streamOutput(appName: string, stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete lines
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.trim()) {
            const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
            this.addLogLine(appName, `[${timestamp}] ${line}`);
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
        this.addLogLine(appName, `[${timestamp}] ${buffer}`);
      }
    } catch {
      // Stream closed
    }
  }

  async stopAll(): Promise<void> {
    const state = await loadState();

    // Stop spawned processes
    const stopPromises = Array.from(this.processes.entries()).map(async ([appName, proc]) => {
      await this.killProcessTree(proc.pid);
      if (state.processes[appName]) {
        state.processes[appName].status = 'stopped';
      }
    });

    // Stop adopted processes (ones we didn't spawn but are tracking)
    const adoptedPromises = Array.from(this.adoptedPids.entries()).map(async ([appName, pid]) => {
      await this.killProcessTree(pid);
      if (state.processes[appName]) {
        state.processes[appName].status = 'stopped';
      }
    });

    await Promise.all([...stopPromises, ...adoptedPromises]);

    this.processes.clear();
    this.adoptedPids.clear();
    state.activeProject = null;
    state.startedAt = null;
    state.processes = {};

    await saveState(state);
  }

  async restartAll(project: Project, dopplerConfig: DopplerConfig): Promise<void> {
    await this.stopAll();
    await this.startAll(project, dopplerConfig);
  }

  async restartApp(appName: string, project: Project, dopplerConfig: DopplerConfig): Promise<void> {
    const app = APPS.find((a) => a.name === appName);
    if (!app) return;

    // Stop the specific app (check both spawned and adopted)
    const proc = this.processes.get(appName);
    if (proc) {
      await this.killProcessTree(proc.pid);
      this.processes.delete(appName);
    } else {
      const adoptedPid = this.adoptedPids.get(appName);
      if (adoptedPid) {
        await this.killProcessTree(adoptedPid);
        this.adoptedPids.delete(appName);
      }
    }

    // Clear log buffer
    this.clearLogBuffer(appName);

    // Start the app again
    const state = await loadState();
    await this.startApp(app, project, dopplerConfig, state);
    await saveState(state);
  }

  private killProcessTree(pid: number, timeout = 5000): Promise<void> {
    return new Promise((resolve) => {
      // First try SIGTERM
      treeKill(pid, 'SIGTERM', (err) => {
        if (err) {
          // Process might already be dead
          resolve();
          return;
        }

        // Check if process is still running
        const checkInterval = setInterval(() => {
          if (!isProcessRunning(pid)) {
            clearInterval(checkInterval);
            clearTimeout(forceKillTimeout);
            resolve();
          }
        }, 100);

        // Force kill after timeout
        const forceKillTimeout = setTimeout(() => {
          clearInterval(checkInterval);
          treeKill(pid, 'SIGKILL', () => resolve());
        }, timeout);
      });
    });
  }

  isRunning(): boolean {
    return this.processes.size > 0 || this.adoptedPids.size > 0;
  }

  getRunningProcesses(): Map<string, Bun.Subprocess> {
    return this.processes;
  }
}

// Singleton instance
export const processManager = new ProcessManager();
