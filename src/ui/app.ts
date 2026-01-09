import chalk from 'chalk';
import { PROJECTS, APPS, DOPPLER_CONFIGS, type DopplerConfig } from '../config/projects';
import { loadState, verifyRunningProcesses, type AppState } from '../services/state';
import { getGitStatus } from '../services/git';
import { processManager } from '../services/process-manager';
import {
  clearScreen,
  hideCursor,
  showCursor,
  moveCursorHome,
  saveScreen,
  restoreScreen,
  getTerminalSize,
  drawBoxTop,
  drawBoxBottom,
  drawHorizontalLine,
  drawRow,
  padString,
  truncateString,
  stripAnsi,
  colors,
  STATUS,
  BOX,
  write,
  writeLine,
} from './renderer';
import type { AppUIState, ProjectWithGit, ViewMode } from './types';

export class TUIApp {
  private state: AppUIState;
  private running = false;
  private renderInterval?: Timer;

  constructor() {
    const { rows, cols } = getTerminalSize();
    this.state = {
      viewMode: 'dashboard',
      selectedProjectIndex: 0,
      selectedLogApp: 0,
      logScrollOffset: 0,
      logFollowMode: true,
      searchMode: false,
      searchQuery: '',
      searchMatches: [],
      searchMatchIndex: 0,
      quitConfirmMode: false,
      projects: [],
      appState: {
        activeProject: null,
        dopplerConfig: 'dev',
        startedAt: null,
        processes: {},
      },
      terminalWidth: cols,
      terminalHeight: rows,
    };
  }

  async start(): Promise<void> {
    this.running = true;

    // Setup terminal
    saveScreen();
    hideCursor();
    clearScreen();

    // Load initial state
    await this.loadProjectsWithGit();
    this.state.appState = await verifyRunningProcesses();

    // Adopt any running processes from previous session
    await processManager.adoptRunningProcesses();

    // Set the selected project to the active one if any
    if (this.state.appState.activeProject) {
      const idx = this.state.projects.findIndex(p => p.alias === this.state.appState.activeProject);
      if (idx >= 0) this.state.selectedProjectIndex = idx;
    }

    // Setup keyboard input
    this.setupKeyboardInput();

    // Setup log update handler
    processManager.setLogUpdateHandler(() => {
      if (this.state.viewMode === 'logs' && this.state.logFollowMode) {
        const buffer = processManager.getLogBuffer(APPS[this.state.selectedLogApp].name);
        this.state.logScrollOffset = Math.max(0, buffer.lines.length - this.getLogViewHeight());
      }
      this.render();
    });

    // Start render loop with stats and state updates
    this.renderInterval = setInterval(async () => {
      this.state.appState = await loadState();
      await this.refreshGitStatus();
      await processManager.updateStats();
      this.render();
    }, 1000);
    this.render();

    // Handle resize
    process.stdout.on('resize', () => {
      const { rows, cols } = getTerminalSize();
      this.state.terminalWidth = cols;
      this.state.terminalHeight = rows;
      this.render();
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.renderInterval) {
      clearInterval(this.renderInterval);
    }

    // Kill all running processes before exiting
    if (processManager.isRunning()) {
      await processManager.stopAll();
    }

    // Restore terminal
    showCursor();
    restoreScreen();
  }

  private async loadProjectsWithGit(): Promise<void> {
    this.state.projects = await Promise.all(
      PROJECTS.map(async (project) => ({
        ...project,
        git: await getGitStatus(project.path),
      }))
    );
  }

  private async refreshGitStatus(): Promise<void> {
    await Promise.all(
      this.state.projects.map(async (project) => {
        project.git = await getGitStatus(project.path);
      })
    );
  }

  private setupKeyboardInput(): void {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (key: string) => this.handleKeypress(key));
  }

  private async handleKeypress(key: string): Promise<void> {
    // Handle Ctrl+C - always show quit confirmation
    if (key === '\x03') {
      this.state.quitConfirmMode = true;
      this.render();
      return;
    }

    // Handle quit confirmation mode
    if (this.state.quitConfirmMode) {
      await this.handleQuitConfirmKeypress(key);
      return;
    }

    if (this.state.searchMode) {
      await this.handleSearchKeypress(key);
      return;
    }

    if (this.state.viewMode === 'logs') {
      await this.handleLogKeypress(key);
      return;
    }

    await this.handleDashboardKeypress(key);
  }

  private async handleQuitConfirmKeypress(key: string): Promise<void> {
    switch (key) {
      case 'y':
      case 'Y':
        await this.quit();
        break;
      case 'n':
      case 'N':
      case '\x1b': // Escape
        this.state.quitConfirmMode = false;
        break;
    }
    this.render();
  }

  private async handleDashboardKeypress(key: string): Promise<void> {
    switch (key) {
      case '\x1b[A': // Up arrow
      case 'k':
        this.state.selectedProjectIndex = Math.max(0, this.state.selectedProjectIndex - 1);
        break;

      case '\x1b[B': // Down arrow
      case 'j':
        this.state.selectedProjectIndex = Math.min(
          this.state.projects.length - 1,
          this.state.selectedProjectIndex + 1
        );
        break;

      case '\r': // Enter
        await this.switchToSelectedProject();
        break;

      case 'c':
        await this.toggleDopplerConfig();
        break;

      case 'r':
        await this.restartProject();
        break;

      case 's':
        await this.stopProject();
        break;

      case 'l':
        this.state.viewMode = 'logs';
        this.state.logScrollOffset = 0;
        this.state.logFollowMode = true;
        break;

      case 'q':
        this.state.quitConfirmMode = true;
        break;
    }
    this.render();
  }

  private async handleLogKeypress(key: string): Promise<void> {
    const buffer = processManager.getLogBuffer(APPS[this.state.selectedLogApp].name);
    const viewHeight = this.getLogViewHeight();

    switch (key) {
      case '\x1b': // Escape
        this.state.viewMode = 'dashboard';
        break;

      case '\x1b[A': // Up arrow
      case 'k':
        this.state.logFollowMode = false;
        this.state.logScrollOffset = Math.max(0, this.state.logScrollOffset - 1);
        break;

      case '\x1b[B': // Down arrow
      case 'j':
        this.state.logScrollOffset = Math.min(
          Math.max(0, buffer.lines.length - viewHeight),
          this.state.logScrollOffset + 1
        );
        if (this.state.logScrollOffset >= buffer.lines.length - viewHeight) {
          this.state.logFollowMode = true;
        }
        break;

      case '\x1b[5~': // Page Up
        this.state.logFollowMode = false;
        this.state.logScrollOffset = Math.max(0, this.state.logScrollOffset - viewHeight);
        break;

      case '\x1b[6~': // Page Down
        this.state.logScrollOffset = Math.min(
          Math.max(0, buffer.lines.length - viewHeight),
          this.state.logScrollOffset + viewHeight
        );
        if (this.state.logScrollOffset >= buffer.lines.length - viewHeight) {
          this.state.logFollowMode = true;
        }
        break;

      case '\x1b[D': // Left arrow
        this.state.selectedLogApp = Math.max(0, this.state.selectedLogApp - 1);
        this.state.logScrollOffset = 0;
        this.state.logFollowMode = true;
        break;

      case '\x1b[C': // Right arrow
        this.state.selectedLogApp = Math.min(APPS.length - 1, this.state.selectedLogApp + 1);
        this.state.logScrollOffset = 0;
        this.state.logFollowMode = true;
        break;

      case 'f':
        this.state.logFollowMode = !this.state.logFollowMode;
        if (this.state.logFollowMode) {
          this.state.logScrollOffset = Math.max(0, buffer.lines.length - viewHeight);
        }
        break;

      case '/':
        this.state.searchMode = true;
        this.state.searchQuery = '';
        this.state.searchMatches = [];
        this.state.searchMatchIndex = 0;
        break;

      case 'n':
        if (this.state.searchMatches.length > 0) {
          this.state.searchMatchIndex =
            (this.state.searchMatchIndex + 1) % this.state.searchMatches.length;
          this.scrollToSearchMatch();
        }
        break;

      case 'N':
        if (this.state.searchMatches.length > 0) {
          this.state.searchMatchIndex =
            (this.state.searchMatchIndex - 1 + this.state.searchMatches.length) %
            this.state.searchMatches.length;
          this.scrollToSearchMatch();
        }
        break;

      case 'r':
        await this.restartSelectedApp();
        break;

      case 'q':
        this.state.quitConfirmMode = true;
        break;
    }
    this.render();
  }

  private async handleSearchKeypress(key: string): Promise<void> {
    switch (key) {
      case '\x1b': // Escape
        this.state.searchMode = false;
        this.state.searchQuery = '';
        break;

      case '\r': // Enter
        this.state.searchMode = false;
        this.performSearch();
        break;

      case '\x7f': // Backspace
        this.state.searchQuery = this.state.searchQuery.slice(0, -1);
        this.performSearch();
        break;

      default:
        if (key.length === 1 && key.charCodeAt(0) >= 32) {
          this.state.searchQuery += key;
          this.performSearch();
        }
    }
    this.render();
  }

  private performSearch(): void {
    const buffer = processManager.getLogBuffer(APPS[this.state.selectedLogApp].name);
    const query = this.state.searchQuery.toLowerCase();

    if (!query) {
      this.state.searchMatches = [];
      return;
    }

    this.state.searchMatches = buffer.lines
      .map((line, idx) => (stripAnsi(line).toLowerCase().includes(query) ? idx : -1))
      .filter((idx) => idx >= 0);

    this.state.searchMatchIndex = 0;
    if (this.state.searchMatches.length > 0) {
      this.scrollToSearchMatch();
    }
  }

  private scrollToSearchMatch(): void {
    if (this.state.searchMatches.length === 0) return;
    const matchLine = this.state.searchMatches[this.state.searchMatchIndex];
    const viewHeight = this.getLogViewHeight();
    this.state.logScrollOffset = Math.max(0, matchLine - Math.floor(viewHeight / 2));
    this.state.logFollowMode = false;
  }

  private getLogViewHeight(): number {
    return this.state.terminalHeight - 6; // Header + footer + borders
  }

  private async switchToSelectedProject(): Promise<void> {
    const project = this.state.projects[this.state.selectedProjectIndex];

    // If same project is already running, do nothing
    if (this.state.appState.activeProject === project.alias) {
      return;
    }

    // Stop current if running
    if (processManager.isRunning()) {
      await processManager.stopAll();
    }

    // Start new project
    await processManager.startAll(project, this.state.appState.dopplerConfig);
    this.state.appState = await loadState();
  }

  private async toggleDopplerConfig(): Promise<void> {
    const currentIdx = DOPPLER_CONFIGS.indexOf(this.state.appState.dopplerConfig);
    const nextIdx = (currentIdx + 1) % DOPPLER_CONFIGS.length;
    const newConfig = DOPPLER_CONFIGS[nextIdx];

    this.state.appState.dopplerConfig = newConfig;

    // If running, restart with new config
    if (processManager.isRunning() && this.state.appState.activeProject) {
      const project = this.state.projects.find(p => p.alias === this.state.appState.activeProject);
      if (project) {
        await processManager.restartAll(project, newConfig);
        this.state.appState = await loadState();
      }
    }
  }

  private async restartProject(): Promise<void> {
    if (!this.state.appState.activeProject) return;

    const project = this.state.projects.find(p => p.alias === this.state.appState.activeProject);
    if (project) {
      await processManager.restartAll(project, this.state.appState.dopplerConfig);
      this.state.appState = await loadState();
    }
  }

  private async restartSelectedApp(): Promise<void> {
    if (!this.state.appState.activeProject) return;

    const project = this.state.projects.find(p => p.alias === this.state.appState.activeProject);
    const appName = APPS[this.state.selectedLogApp].name;
    if (project) {
      await processManager.restartApp(appName, project, this.state.appState.dopplerConfig);
      this.state.appState = await loadState();
    }
  }

  private async stopProject(): Promise<void> {
    if (processManager.isRunning()) {
      await processManager.stopAll();
      this.state.appState = await loadState();
    }
  }

  private async quit(): Promise<void> {
    await this.stop();
    process.exit(0);
  }

  private render(): void {
    if (!this.running) return;

    moveCursorHome();
    let lines: string[];

    if (this.state.quitConfirmMode) {
      lines = this.renderQuitConfirmation();
    } else if (this.state.viewMode === 'dashboard') {
      lines = this.renderDashboard();
    } else {
      lines = this.renderLogViewer();
    }

    for (const line of lines) {
      writeLine(line);
    }
  }

  private renderQuitConfirmation(): string[] {
    const width = this.state.terminalWidth;
    const height = this.state.terminalHeight;
    const lines: string[] = [];

    // Fill with empty lines to center the dialog
    const dialogHeight = 7;
    const topPadding = Math.floor((height - dialogHeight) / 2);

    for (let i = 0; i < topPadding; i++) {
      lines.push(' '.repeat(width));
    }

    // Dialog box
    const dialogWidth = 40;
    const leftPadding = Math.floor((width - dialogWidth) / 2);
    const pad = ' '.repeat(leftPadding);

    lines.push(pad + drawBoxTop(dialogWidth));
    lines.push(pad + `${BOX.vertical}${' '.repeat(dialogWidth - 2)}${BOX.vertical}`);
    const title = colors.warning('  Quit cubicli?');
    lines.push(pad + `${BOX.vertical}${padString(title, dialogWidth - 2)}${BOX.vertical}`);
    lines.push(pad + `${BOX.vertical}${' '.repeat(dialogWidth - 2)}${BOX.vertical}`);
    const prompt = '  All processes will be stopped.';
    lines.push(pad + `${BOX.vertical}${padString(prompt, dialogWidth - 2)}${BOX.vertical}`);
    lines.push(pad + `${BOX.vertical}${' '.repeat(dialogWidth - 2)}${BOX.vertical}`);
    const options = `  ${colors.key('[y]')} Yes  ${colors.key('[n]')} No`;
    lines.push(pad + `${BOX.vertical}${padString(options, dialogWidth - 2)}${BOX.vertical}`);
    lines.push(pad + `${BOX.vertical}${' '.repeat(dialogWidth - 2)}${BOX.vertical}`);
    lines.push(pad + drawBoxBottom(dialogWidth));

    // Fill remaining lines
    while (lines.length < height) {
      lines.push(' '.repeat(width));
    }

    return lines;
  }

  private renderDashboard(): string[] {
    const width = this.state.terminalWidth;
    const lines: string[] = [];

    // Logo - green C-gear icon matching cubic branding
    const g = chalk.green;
    const logo = [
      `  ${g('██')}  ${g('██')}    ${chalk.bold.white('██████╗██╗   ██╗██████╗ ██╗ ██████╗')}`,
      ` ${g('██')}    ${g('██')}   ${chalk.bold.white('██╔════╝██║   ██║██╔══██╗██║██╔════╝')}`,
      ` ${g('██')}         ${chalk.bold.white('██║     ██║   ██║██████╔╝██║██║     ')}`,
      ` ${g('██')}    ${g('██')}   ${chalk.bold.white('██║     ██║   ██║██╔══██╗██║██║     ')}`,
      `  ${g('██')}  ${g('██')}    ${chalk.bold.white('╚██████╗╚██████╔╝██████╔╝██║╚██████╗')}`,
      `            ${chalk.bold.white(' ╚═════╝ ╚═════╝ ╚═════╝ ╚═╝ ╚═════╝')}`,
    ];

    // Title bar
    lines.push(drawBoxTop(width));
    for (const logoLine of logo) {
      lines.push(`${BOX.vertical} ${padString(logoLine, width - 4)} ${BOX.vertical}`);
    }
    lines.push(drawHorizontalLine(width));

    // Split into two columns
    const leftWidth = Math.floor((width - 4) / 2);
    const rightWidth = width - 4 - leftWidth - 1;

    // Headers
    const projectsHeader = colors.subtitle('PROJECTS');
    const statusHeader = colors.subtitle('STATUS');
    lines.push(
      `${BOX.vertical} ${padString(projectsHeader, leftWidth)}${padString(statusHeader, rightWidth)} ${BOX.vertical}`
    );

    // Content rows
    const maxRows = Math.max(this.state.projects.length, APPS.length);
    for (let i = 0; i < maxRows; i++) {
      const projectPart = this.renderProjectRow(i, leftWidth);
      const statusPart = this.renderStatusRow(i, rightWidth);
      lines.push(`${BOX.vertical} ${projectPart}${statusPart} ${BOX.vertical}`);
    }

    // Config and uptime row
    lines.push(`${BOX.vertical}${' '.repeat(width - 2)}${BOX.vertical}`);
    const configText = `CONFIG: ${colors.highlight(this.state.appState.dopplerConfig)}`;
    const uptimeText = this.state.appState.startedAt
      ? `UPTIME: ${colors.info(this.formatUptime(this.state.appState.startedAt))}`
      : '';
    lines.push(
      `${BOX.vertical} ${padString(configText, leftWidth)}${padString(uptimeText, rightWidth)} ${BOX.vertical}`
    );

    // Fill remaining space
    const contentRows = lines.length;
    const footerRows = 3;
    const remainingRows = this.state.terminalHeight - contentRows - footerRows;
    for (let i = 0; i < remainingRows; i++) {
      lines.push(`${BOX.vertical}${' '.repeat(width - 2)}${BOX.vertical}`);
    }

    // Help bar
    lines.push(drawHorizontalLine(width));
    const helpText = [
      `${colors.key('[Enter]')} Switch`,
      `${colors.key('[c]')} Config`,
      `${colors.key('[r]')} Restart`,
      `${colors.key('[s]')} Stop`,
      `${colors.key('[l]')} Logs`,
      `${colors.key('[q]')} Quit`,
    ].join('  ');
    lines.push(`${BOX.vertical} ${padString(helpText, width - 4)} ${BOX.vertical}`);
    lines.push(drawBoxBottom(width));

    return lines;
  }

  private renderProjectRow(index: number, width: number): string {
    if (index >= this.state.projects.length) {
      return padString('', width);
    }

    const project = this.state.projects[index];
    const isSelected = index === this.state.selectedProjectIndex;
    const isActive = project.alias === this.state.appState.activeProject;

    const indicator = isSelected ? '›' : ' ';
    const activeMarker = isActive ? STATUS.running : ' ';
    const name = padString(project.alias, 10);
    const branch = truncateString(colors.branch(project.git.branch), width - 16);
    const dirty = project.git.isDirty ? colors.warning('*') : ' ';

    let row = `${indicator} ${name} ${branch}${dirty} ${activeMarker}`;
    if (isSelected) {
      row = colors.selected(padString(stripAnsi(row), width));
    } else {
      row = padString(row, width);
    }

    return row;
  }

  private renderStatusRow(index: number, width: number): string {
    if (index >= APPS.length) {
      return padString('', width);
    }

    const app = APPS[index];
    const processInfo = this.state.appState.processes[app.name];
    const stats = processManager.getStats(app.name);

    let status = STATUS.stopped;
    let statusText = 'Stopped';
    let port = '';
    let statsText = '';

    if (processInfo) {
      switch (processInfo.status) {
        case 'running':
          status = STATUS.running;
          statusText = 'Running';
          port = colors.dim(`:${processInfo.port}`);
          if (stats) {
            const cpu = stats.cpu.toFixed(1).padStart(5);
            const mem = stats.memory.toFixed(0).padStart(4);
            statsText = colors.dim(` ${cpu}% ${mem}MB`);
          }
          break;
        case 'starting':
          status = STATUS.starting;
          statusText = 'Starting';
          break;
        case 'error':
          status = STATUS.error;
          statusText = 'Error';
          break;
        default:
          status = STATUS.stopped;
          statusText = 'Stopped';
      }
    }

    const name = padString(app.name, 12);
    const row = `${name} ${status} ${padString(statusText, 8)} ${port}${statsText}`;
    return padString(row, width);
  }

  private renderLogViewer(): string[] {
    const width = this.state.terminalWidth;
    const height = this.state.terminalHeight;
    const lines: string[] = [];

    const app = APPS[this.state.selectedLogApp];
    const buffer = processManager.getLogBuffer(app.name);

    // Title bar
    lines.push(drawBoxTop(width));
    const projectName = this.state.appState.activeProject || 'none';
    const configName = this.state.appState.dopplerConfig;
    const title = colors.title(`  LOGS: ${projectName} › ${app.name}`) + colors.dim(` (${configName})`);
    const appIndicator = `[${this.state.selectedLogApp + 1}/${APPS.length}]`;
    const followIndicator = this.state.logFollowMode ? colors.success('FOLLOW ●') : '';
    const searchIndicator = this.state.searchMode
      ? `Search: ${this.state.searchQuery}▌`
      : this.state.searchQuery
        ? `[${this.state.searchMatchIndex + 1}/${this.state.searchMatches.length}]`
        : '';

    const headerRight = `${searchIndicator}  ${followIndicator}  ${appIndicator}`;
    const headerPadding = width - stripAnsi(title).length - stripAnsi(headerRight).length - 4;
    lines.push(
      `${BOX.vertical} ${title}${' '.repeat(Math.max(0, headerPadding))}${headerRight} ${BOX.vertical}`
    );
    lines.push(drawHorizontalLine(width));

    // Log content
    const viewHeight = height - 6;
    const startLine = this.state.logScrollOffset;
    const endLine = Math.min(startLine + viewHeight, buffer.lines.length);

    for (let i = startLine; i < startLine + viewHeight; i++) {
      let line = i < buffer.lines.length ? buffer.lines[i] : '';

      // Highlight search matches
      if (
        this.state.searchQuery &&
        this.state.searchMatches.includes(i)
      ) {
        const query = this.state.searchQuery;
        const stripped = stripAnsi(line);
        const matchIdx = stripped.toLowerCase().indexOf(query.toLowerCase());
        if (matchIdx >= 0) {
          // Simple highlight - just mark the line
          line = colors.highlight('→') + ' ' + line;
        }
      }

      line = truncateString(line, width - 4);
      lines.push(`${BOX.vertical} ${padString(line, width - 4)} ${BOX.vertical}`);
    }

    // Help bar
    lines.push(drawHorizontalLine(width));
    const helpText = this.state.searchMode
      ? `${colors.key('[Enter]')} Confirm  ${colors.key('[Esc]')} Cancel`
      : [
          `${colors.key('[←/→]')} App`,
          `${colors.key('[↑/↓]')} Scroll`,
          `${colors.key('[/]')} Search`,
          `${colors.key('[n/N]')} Next/Prev`,
          `${colors.key('[f]')} Follow`,
          `${colors.key('[r]')} Restart`,
          `${colors.key('[Esc]')} Back`,
        ].join('  ');
    lines.push(`${BOX.vertical} ${padString(helpText, width - 4)} ${BOX.vertical}`);
    lines.push(drawBoxBottom(width));

    return lines;
  }

  private formatUptime(startedAt: string): string {
    const start = new Date(startedAt);
    const now = new Date();
    const diff = now.getTime() - start.getTime();

    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  }
}
