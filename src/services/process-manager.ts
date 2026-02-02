import treeKill from 'tree-kill';
import { appendFile, readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { APPS, LOG_DIR, PROJECTS, URL_ENV_VARS, getPortForApp, getProjectPorts, type AppConfig, type DopplerConfig, type Project } from '../config/projects';
import { loadState, saveState, isProcessRunning, getProcessStats, ensurePortsAvailable, resetNxDaemon, isPortInUse, type AppState, type ProcessInfo, type ProcessStats, type ProjectState } from './state';

const MAX_LOG_LINES = 10000;

export interface LogBuffer {
  lines: string[];
  searchMatches: number[];
}

// Key format: "projectAlias:appName"
function makeLogKey(projectAlias: string, appName: string): string {
  return `${projectAlias}:${appName}`;
}

export class ProcessManager {
  // Nested map: projectAlias -> appName -> subprocess
  private processes: Map<string, Map<string, Bun.Subprocess>> = new Map();
  // Adopted PIDs: projectAlias -> appName -> pid
  private adoptedPids: Map<string, Map<string, number>> = new Map();
  // Log buffers keyed by "projectAlias:appName"
  private logBuffers: Map<string, LogBuffer> = new Map();
  // Process stats keyed by "projectAlias:appName"
  private processStats: Map<string, ProcessStats> = new Map();
  // Port listening status keyed by "projectAlias:appName"
  private portListening: Map<string, boolean> = new Map();
  private onLogUpdate?: (projectAlias: string, appName: string, line: string, didShift: boolean) => void;
  private truncateCounter = 0;

  constructor() {
    // Ensure log directory exists
    this.ensureLogDir();
  }

  private async ensureLogDir(): Promise<void> {
    if (!existsSync(LOG_DIR)) {
      await mkdir(LOG_DIR, { recursive: true });
    }
  }

  private getLogFilePath(projectAlias: string, appName: string): string {
    return `${LOG_DIR}/${projectAlias}-${appName}.log`;
  }

  private async appendToLogFile(projectAlias: string, appName: string, line: string): Promise<void> {
    try {
      await this.ensureLogDir();
      await appendFile(this.getLogFilePath(projectAlias, appName), line + '\n');
    } catch {
      // Ignore write errors
    }
  }

  private async loadLogsFromFile(projectAlias: string, appName: string): Promise<void> {
    try {
      const filePath = this.getLogFilePath(projectAlias, appName);
      if (!existsSync(filePath)) return;

      const content = await readFile(filePath, 'utf-8');
      const lines = content.split('\n').filter(line => line.trim());

      // Take only the last MAX_LOG_LINES
      const recentLines = lines.slice(-MAX_LOG_LINES);

      const key = makeLogKey(projectAlias, appName);
      this.logBuffers.set(key, { lines: recentLines, searchMatches: [] });
    } catch {
      // Ignore read errors
    }
  }

  private async truncateLogFile(projectAlias: string, appName: string): Promise<void> {
    try {
      const filePath = this.getLogFilePath(projectAlias, appName);
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
    for (const [projectAlias, projectState] of Object.entries(state.activeProjects)) {
      for (const [appName, info] of Object.entries(projectState.processes)) {
        const key = makeLogKey(projectAlias, appName);
        if (info.status === 'running' || info.status === 'starting') {
          const stats = await getProcessStats(info.pid);
          if (stats) {
            this.processStats.set(key, stats);
          }
          // Check if port is actually listening
          const listening = await isPortInUse(info.port);
          this.portListening.set(key, listening);
        } else {
          this.portListening.set(key, false);
        }
      }
    }

    // Truncate log files every 60 seconds
    this.truncateCounter++;
    if (this.truncateCounter >= 60) {
      this.truncateCounter = 0;
      for (const project of PROJECTS) {
        for (const app of APPS) {
          await this.truncateLogFile(project.alias, app.name);
        }
      }
    }
  }

  getStats(projectAlias: string, appName: string): ProcessStats | undefined {
    const key = makeLogKey(projectAlias, appName);
    return this.processStats.get(key);
  }

  async adoptRunningProcesses(): Promise<void> {
    const state = await loadState();
    for (const [projectAlias, projectState] of Object.entries(state.activeProjects)) {
      for (const [appName, info] of Object.entries(projectState.processes)) {
        if (info.status === 'running' && isProcessRunning(info.pid)) {
          // Track this PID as adopted (we can kill it but can't read its output)
          if (!this.adoptedPids.has(projectAlias)) {
            this.adoptedPids.set(projectAlias, new Map());
          }
          this.adoptedPids.get(projectAlias)!.set(appName, info.pid);
          // Load recent logs from file
          await this.loadLogsFromFile(projectAlias, appName);
        }
      }
    }
  }

  setLogUpdateHandler(handler: (projectAlias: string, appName: string, line: string, didShift: boolean) => void): void {
    this.onLogUpdate = handler;
  }

  getLogBuffer(projectAlias: string, appName: string): LogBuffer {
    const key = makeLogKey(projectAlias, appName);
    return this.logBuffers.get(key) || { lines: [], searchMatches: [] };
  }

  clearLogBuffer(projectAlias: string, appName: string): void {
    const key = makeLogKey(projectAlias, appName);
    this.logBuffers.set(key, { lines: [], searchMatches: [] });
    // Also clear the log file
    writeFile(this.getLogFilePath(projectAlias, appName), '').catch(() => {});
  }

  private addLogLine(projectAlias: string, appName: string, line: string): boolean {
    const key = makeLogKey(projectAlias, appName);
    let buffer = this.logBuffers.get(key);
    if (!buffer) {
      buffer = { lines: [], searchMatches: [] };
      this.logBuffers.set(key, buffer);
    }

    buffer.lines.push(line);

    // Ring buffer - remove oldest if over limit
    let didShift = false;
    if (buffer.lines.length > MAX_LOG_LINES) {
      buffer.lines.shift();
      didShift = true;
    }

    // Persist to file (fire and forget)
    this.appendToLogFile(projectAlias, appName, line);

    this.onLogUpdate?.(projectAlias, appName, line, didShift);

    return didShift;
  }

  /**
   * Start a single project (all its apps)
   */
  async startProject(project: Project, dopplerConfig: DopplerConfig): Promise<void> {
    // Ensure all required ports for this project are available
    const requiredPorts = getProjectPorts(project);
    await ensurePortsAvailable(requiredPorts);

    // Reset nx daemon to clear any stale state from previous runs
    await resetNxDaemon(project.path);

    // Clear log buffers for this project
    for (const app of APPS) {
      this.clearLogBuffer(project.alias, app.name);
    }

    const state = await loadState();
    const projectState: ProjectState = {
      dopplerConfig,
      startedAt: new Date().toISOString(),
      processes: {},
    };

    // Initialize process map for this project
    if (!this.processes.has(project.alias)) {
      this.processes.set(project.alias, new Map());
    }

    for (const app of APPS) {
      await this.startApp(app, project, dopplerConfig, projectState);
    }

    state.activeProjects[project.alias] = projectState;
    await saveState(state);
  }

  /**
   * Start all projects
   */
  async startAllProjects(dopplerConfig: DopplerConfig): Promise<void> {
    for (const project of PROJECTS) {
      if (!this.isProjectRunning(project.alias)) {
        await this.startProject(project, dopplerConfig);
      }
    }
  }

  private async startApp(
    app: AppConfig,
    project: Project,
    dopplerConfig: DopplerConfig,
    projectState: ProjectState
  ): Promise<void> {
    const port = getPortForApp(app, project);

    // Build MICROSERVICE_*_PORT and MICROSERVICE_*_HOST env var overrides for all apps
    const envOverrides: string[] = [];
    for (const appConfig of APPS) {
      const appPort = getPortForApp(appConfig, project);
      envOverrides.push(`${appConfig.portEnvVar}=${appPort}`);
      envOverrides.push(`${appConfig.hostEnvVar}=http://localhost`);
    }

    // Add URL-based env vars (e.g., NEXT_PUBLIC_API_BASE_URL)
    for (const [envVar, appName] of Object.entries(URL_ENV_VARS)) {
      const appConfig = APPS.find(a => a.name === appName);
      if (appConfig) {
        const appPort = getPortForApp(appConfig, project);
        envOverrides.push(`${envVar}=http://localhost:${appPort}`);
      }
    }

    // Isolate NX daemon per project to prevent conflicts when running multiple projects
    const nxDaemonDir = `${LOG_DIR}/nx-daemon-${project.alias}`;
    envOverrides.push(`NX_DAEMON_SOCKET_DIR=${nxDaemonDir}`);
    envOverrides.push(`NX_PROJECT_GRAPH_CACHE_DIRECTORY=${nxDaemonDir}`);

    envOverrides.push(`PORT=${port}`);

    // Use env command to override doppler's values
    const cmdParts = app.command.split(' ');

    // Next.js apps need --port argument
    if (app.name === 'client-app' || app.name === 'mycelium') {
      cmdParts.push('--port', port.toString());
    }

    const cmd = [
      'doppler', 'run', '--config', dopplerConfig, '--',
      'env',
      ...envOverrides,
      ...cmdParts,
    ];

    const proc = Bun.spawn({
      cmd,
      cwd: project.path,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        FORCE_COLOR: '1',
      },
    });

    if (!this.processes.has(project.alias)) {
      this.processes.set(project.alias, new Map());
    }
    this.processes.get(project.alias)!.set(app.name, proc);

    projectState.processes[app.name] = {
      pid: proc.pid,
      port,
      status: 'starting',
    };

    // Stream stdout
    this.streamOutput(project.alias, app.name, proc.stdout);
    this.streamOutput(project.alias, app.name, proc.stderr);

    // Update status when process is ready (after a brief delay)
    setTimeout(async () => {
      const currentState = await loadState();
      const pState = currentState.activeProjects[project.alias];
      if (pState?.processes[app.name] && isProcessRunning(proc.pid)) {
        pState.processes[app.name].status = 'running';
        await saveState(currentState);
      }
    }, 3000);

    // Handle process exit
    proc.exited.then(async (code) => {
      const currentState = await loadState();
      const pState = currentState.activeProjects[project.alias];
      if (pState?.processes[app.name]) {
        pState.processes[app.name].status = code === 0 ? 'stopped' : 'error';
        await saveState(currentState);
      }
      this.processes.get(project.alias)?.delete(app.name);
    });
  }

  private async streamOutput(projectAlias: string, appName: string, stream: ReadableStream<Uint8Array>): Promise<void> {
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
            this.addLogLine(projectAlias, appName, `[${timestamp}] ${line}`);
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
        this.addLogLine(projectAlias, appName, `[${timestamp}] ${buffer}`);
      }
    } catch {
      // Stream closed
    }
  }

  /**
   * Stop a single project
   */
  async stopProject(projectAlias: string): Promise<void> {
    const state = await loadState();
    const projectState = state.activeProjects[projectAlias];

    // Stop spawned processes for this project
    const projectProcs = this.processes.get(projectAlias);
    if (projectProcs) {
      const stopPromises = Array.from(projectProcs.entries()).map(async ([appName, proc]) => {
        await this.killProcessTree(proc.pid);
        if (projectState?.processes[appName]) {
          projectState.processes[appName].status = 'stopped';
        }
      });
      await Promise.all(stopPromises);
      projectProcs.clear();
      this.processes.delete(projectAlias);
    }

    // Stop adopted processes for this project
    const adoptedProcs = this.adoptedPids.get(projectAlias);
    if (adoptedProcs) {
      const adoptedPromises = Array.from(adoptedProcs.entries()).map(async ([appName, pid]) => {
        await this.killProcessTree(pid);
        if (projectState?.processes[appName]) {
          projectState.processes[appName].status = 'stopped';
        }
      });
      await Promise.all(adoptedPromises);
      adoptedProcs.clear();
      this.adoptedPids.delete(projectAlias);
    }

    // Remove from active projects
    delete state.activeProjects[projectAlias];
    await saveState(state);
  }

  /**
   * Stop all projects
   */
  async stopAllProjects(): Promise<void> {
    const state = await loadState();
    const projectAliases = Object.keys(state.activeProjects);

    for (const alias of projectAliases) {
      await this.stopProject(alias);
    }
  }

  async restartProject(project: Project, dopplerConfig: DopplerConfig): Promise<void> {
    await this.stopProject(project.alias);
    await this.startProject(project, dopplerConfig);
  }

  async restartApp(appName: string, project: Project, dopplerConfig: DopplerConfig): Promise<void> {
    const app = APPS.find((a) => a.name === appName);
    if (!app) return;

    // Stop the specific app (check both spawned and adopted)
    const projectProcs = this.processes.get(project.alias);
    if (projectProcs) {
      const proc = projectProcs.get(appName);
      if (proc) {
        await this.killProcessTree(proc.pid);
        projectProcs.delete(appName);
      }
    }

    const adoptedProcs = this.adoptedPids.get(project.alias);
    if (adoptedProcs) {
      const adoptedPid = adoptedProcs.get(appName);
      if (adoptedPid) {
        await this.killProcessTree(adoptedPid);
        adoptedProcs.delete(appName);
      }
    }

    // Clear log buffer
    this.clearLogBuffer(project.alias, appName);

    // Start the app again
    const state = await loadState();
    let projectState = state.activeProjects[project.alias];
    if (!projectState) {
      projectState = {
        dopplerConfig,
        startedAt: new Date().toISOString(),
        processes: {},
      };
      state.activeProjects[project.alias] = projectState;
    }
    await this.startApp(app, project, dopplerConfig, projectState);
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

  /**
   * Check if any project is running
   */
  isRunning(): boolean {
    for (const projectProcs of this.processes.values()) {
      if (projectProcs.size > 0) return true;
    }
    for (const adoptedProcs of this.adoptedPids.values()) {
      if (adoptedProcs.size > 0) return true;
    }
    return false;
  }

  /**
   * Check if a specific project is running
   */
  isProjectRunning(projectAlias: string): boolean {
    const projectProcs = this.processes.get(projectAlias);
    if (projectProcs && projectProcs.size > 0) return true;
    const adoptedProcs = this.adoptedPids.get(projectAlias);
    if (adoptedProcs && adoptedProcs.size > 0) return true;
    return false;
  }

  /**
   * Check if a specific app is running for a project
   */
  isAppRunning(projectAlias: string, appName: string): boolean {
    const projectProcs = this.processes.get(projectAlias);
    if (projectProcs?.has(appName)) return true;
    const adoptedProcs = this.adoptedPids.get(projectAlias);
    if (adoptedProcs?.has(appName)) return true;
    return false;
  }

  /**
   * Check if a specific app's port is actually listening
   */
  isAppListening(projectAlias: string, appName: string): boolean {
    const key = makeLogKey(projectAlias, appName);
    return this.portListening.get(key) ?? false;
  }

  /**
   * Get count of listening apps for a project (ports actually responding)
   */
  getListeningAppCount(projectAlias: string): { listening: number; total: number } {
    let listening = 0;
    const total = APPS.length;
    for (const app of APPS) {
      if (this.isAppListening(projectAlias, app.name)) {
        listening++;
      }
    }
    return { listening, total };
  }

  /**
   * Get count of running apps for a project (process spawned)
   */
  getRunningAppCount(projectAlias: string): { running: number; total: number } {
    let running = 0;
    const total = APPS.length;
    for (const app of APPS) {
      if (this.isAppRunning(projectAlias, app.name)) {
        running++;
      }
    }
    return { running, total };
  }

  /**
   * Get list of running project aliases
   */
  getRunningProjects(): string[] {
    const running = new Set<string>();
    for (const [alias, procs] of this.processes.entries()) {
      if (procs.size > 0) running.add(alias);
    }
    for (const [alias, pids] of this.adoptedPids.entries()) {
      if (pids.size > 0) running.add(alias);
    }
    return Array.from(running);
  }

  getRunningProcesses(): Map<string, Map<string, Bun.Subprocess>> {
    return this.processes;
  }
}

// Singleton instance
export const processManager = new ProcessManager();
