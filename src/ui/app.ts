import chalk from 'chalk';
import { PROJECTS, APPS, DOPPLER_CONFIGS, getPortForApp, type DopplerConfig } from '../config/projects';
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
  padString,
  truncateString,
  stripAnsi,
  colors,
  STATUS,
  BOX,
  writeLine,
  enableMouseTracking,
  disableMouseTracking,
} from './renderer';
import type { AppUIState, ProjectWithGit, ViewMode } from './types';

export class TUIApp {
  private state: AppUIState;
  private running = false;
  private renderInterval?: Timer;
  private mouseTrackingEnabled = false;

  constructor() {
    const { rows, cols } = getTerminalSize();
    this.state = {
      viewMode: 'dashboard',
      selectedProjectIndex: 0,
      selectedLogApp: 0,
      selectedLogProject: 0,
      logScrollOffset: 0,
      logFollowMode: true,
      searchMode: false,
      searchQuery: '',
      searchMatches: [],
      searchMatchIndex: 0,
      quitConfirmMode: false,
      projects: [],
      appState: {
        dopplerConfig: 'dev',
        activeProjects: {},
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

    // Set the selected project to the first active one if any
    const activeAliases = Object.keys(this.state.appState.activeProjects);
    if (activeAliases.length > 0) {
      const idx = this.state.projects.findIndex(p => activeAliases.includes(p.alias));
      if (idx >= 0) this.state.selectedProjectIndex = idx;
    }

    // Setup keyboard input
    this.setupKeyboardInput();

    // Setup log update handler
    processManager.setLogUpdateHandler((projectAlias: string, appName: string, _line: string, didShift: boolean) => {
      if (this.state.viewMode === 'logs') {
        const currentProject = this.state.projects[this.state.selectedLogProject];
        const currentApp = APPS[this.state.selectedLogApp].name;
        if (currentProject && projectAlias === currentProject.alias && appName === currentApp) {
          if (this.state.logFollowMode) {
            const buffer = processManager.getLogBuffer(currentProject.alias, currentApp);
            this.state.logScrollOffset = Math.max(0, buffer.lines.length - this.getLogViewHeight());
          } else if (didShift && this.state.logScrollOffset > 0) {
            // Adjust offset to keep the same content in view when buffer shifts
            this.state.logScrollOffset = Math.max(0, this.state.logScrollOffset - 1);
          }
        }
        // Skip render when follow mode is off (allows text selection)
        if (!this.state.logFollowMode) {
          return;
        }
      }
      this.render();
    });

    // Start render loop with stats and state updates
    this.renderInterval = setInterval(async () => {
      this.state.appState = await loadState();
      await this.refreshGitStatus();
      await processManager.updateStats();

      // Skip render when in logs view with follow mode off (allows text selection)
      if (this.state.viewMode === 'logs' && !this.state.logFollowMode) {
        return;
      }

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
      await processManager.stopAllProjects();
    }

    // Restore terminal
    if (this.mouseTrackingEnabled) {
      disableMouseTracking();
      this.mouseTrackingEnabled = false;
    }
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

  private updateMouseTracking(): void {
    const shouldEnable = this.state.viewMode === 'logs' && this.state.logFollowMode;
    if (shouldEnable && !this.mouseTrackingEnabled) {
      enableMouseTracking();
      this.mouseTrackingEnabled = true;
    } else if (!shouldEnable && this.mouseTrackingEnabled) {
      disableMouseTracking();
      this.mouseTrackingEnabled = false;
    }
  }

  private async handleKeypress(key: string): Promise<void> {
    // Handle mouse events (SGR mode: \x1b[<button;x;yM or m)
    // When mouse is clicked in log view, disable follow mode to allow text selection
    if (key.startsWith('\x1b[<') && this.state.viewMode === 'logs') {
      this.state.logFollowMode = false;
      this.updateMouseTracking();
      this.render(); // Update the follow indicator
      return;
    }

    // Handle Ctrl+C - always show quit confirmation
    if (key === '\x03') {
      this.state.quitConfirmMode = true;
      this.render();
      return;
    }

    // Handle quit confirmation mode
    if (this.state.quitConfirmMode) {
      await this.handleQuitConfirmKeypress(key);
      this.updateMouseTracking();
      return;
    }

    if (this.state.searchMode) {
      await this.handleSearchKeypress(key);
      this.updateMouseTracking();
      return;
    }

    if (this.state.viewMode === 'logs') {
      await this.handleLogKeypress(key);
      this.updateMouseTracking();
      return;
    }

    await this.handleDashboardKeypress(key);
    this.updateMouseTracking();
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

      // Number keys for quick project selection
      case '1':
        if (this.state.projects.length >= 1) this.state.selectedProjectIndex = 0;
        break;
      case '2':
        if (this.state.projects.length >= 2) this.state.selectedProjectIndex = 1;
        break;
      case '3':
        if (this.state.projects.length >= 3) this.state.selectedProjectIndex = 2;
        break;

      case '\r': // Enter - toggle start/stop for selected project
        await this.toggleSelectedProject();
        break;

      case 'c':
        await this.toggleDopplerConfig();
        break;

      case 'r':
        await this.restartSelectedProject();
        break;

      case 'A': // Shift+A - Start all projects
        await this.startAllProjects();
        break;

      case 'S': // Shift+S - Stop all projects
        await this.stopAllProjects();
        break;

      case 'l':
        this.state.viewMode = 'logs';
        this.state.selectedLogProject = this.state.selectedProjectIndex;
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
    const currentProject = this.state.projects[this.state.selectedLogProject];
    const buffer = currentProject
      ? processManager.getLogBuffer(currentProject.alias, APPS[this.state.selectedLogApp].name)
      : { lines: [], searchMatches: [] };
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

      case '\x1b[D': // Left arrow - switch app
        this.state.selectedLogApp = Math.max(0, this.state.selectedLogApp - 1);
        this.state.logScrollOffset = 0;
        this.state.logFollowMode = true;
        break;

      case '\x1b[C': // Right arrow - switch app
        this.state.selectedLogApp = Math.min(APPS.length - 1, this.state.selectedLogApp + 1);
        this.state.logScrollOffset = 0;
        this.state.logFollowMode = true;
        break;

      case '[': // Switch to previous project
        this.state.selectedLogProject = Math.max(0, this.state.selectedLogProject - 1);
        this.state.logScrollOffset = 0;
        this.state.logFollowMode = true;
        break;

      case ']': // Switch to next project
        this.state.selectedLogProject = Math.min(this.state.projects.length - 1, this.state.selectedLogProject + 1);
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
    const currentProject = this.state.projects[this.state.selectedLogProject];
    if (!currentProject) {
      this.state.searchMatches = [];
      return;
    }

    const buffer = processManager.getLogBuffer(currentProject.alias, APPS[this.state.selectedLogApp].name);
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

  /**
   * Toggle start/stop for the selected project
   */
  private async toggleSelectedProject(): Promise<void> {
    const project = this.state.projects[this.state.selectedProjectIndex];
    if (!project) return;

    if (processManager.isProjectRunning(project.alias)) {
      // Stop the project
      await processManager.stopProject(project.alias);
    } else {
      // Start the project
      await processManager.startProject(project, this.state.appState.dopplerConfig);
    }
    this.state.appState = await loadState();
  }

  private async toggleDopplerConfig(): Promise<void> {
    const currentIdx = DOPPLER_CONFIGS.indexOf(this.state.appState.dopplerConfig);
    const nextIdx = (currentIdx + 1) % DOPPLER_CONFIGS.length;
    const newConfig = DOPPLER_CONFIGS[nextIdx];

    this.state.appState.dopplerConfig = newConfig;

    // If any projects are running, restart them with new config
    const runningProjects = processManager.getRunningProjects();
    for (const alias of runningProjects) {
      const project = this.state.projects.find(p => p.alias === alias);
      if (project) {
        await processManager.restartProject(project, newConfig);
      }
    }
    this.state.appState = await loadState();
  }

  private async restartSelectedProject(): Promise<void> {
    const project = this.state.projects[this.state.selectedProjectIndex];
    if (!project || !processManager.isProjectRunning(project.alias)) return;

    await processManager.restartProject(project, this.state.appState.dopplerConfig);
    this.state.appState = await loadState();
  }

  private async restartSelectedApp(): Promise<void> {
    const currentProject = this.state.projects[this.state.selectedLogProject];
    if (!currentProject) return;

    const projectState = this.state.appState.activeProjects[currentProject.alias];
    if (!projectState) return;

    const appName = APPS[this.state.selectedLogApp].name;
    const dopplerConfig = projectState.dopplerConfig;
    await processManager.restartApp(appName, currentProject, dopplerConfig);
    this.state.appState = await loadState();
  }

  private async startAllProjects(): Promise<void> {
    await processManager.startAllProjects(this.state.appState.dopplerConfig);
    this.state.appState = await loadState();
  }

  private async stopAllProjects(): Promise<void> {
    await processManager.stopAllProjects();
    this.state.appState = await loadState();
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

    // Render each project as a card
    for (let i = 0; i < this.state.projects.length; i++) {
      const project = this.state.projects[i];
      const isSelected = i === this.state.selectedProjectIndex;
      const projectState = this.state.appState.activeProjects[project.alias];
      const isRunning = !!projectState;

      // Project header line
      const indicator = isSelected ? colors.selected('›') : ' ';
      const runningStatus = isRunning ? STATUS.running : STATUS.stopped;
      const projectName = project.alias.toUpperCase();
      const branch = truncateString(project.git.branch, 20);
      const dirty = project.git.isDirty ? colors.warning('*') : '';
      const config = isRunning ? colors.dim(`[${projectState.dopplerConfig}]`) : '';

      // Build ports string if running
      let portsStr = '';
      if (isRunning) {
        const portStrs = APPS.map(app => {
          const port = getPortForApp(app, project);
          return `${app.name.substring(0, 3)}:${port}`;
        });
        portsStr = portStrs.join('  ');
      } else {
        portsStr = 'Stopped';
      }

      const headerLeft = `${indicator} ${runningStatus} ${padString(projectName, 8)} ${colors.branch(`(${branch})`)}${dirty} ${config}`;
      const headerRight = portsStr;
      const headerPadding = width - stripAnsi(headerLeft).length - stripAnsi(headerRight).length - 4;
      let headerLine = `${headerLeft}${' '.repeat(Math.max(1, headerPadding))}${headerRight}`;

      if (isSelected) {
        const rawHeader = `${indicator} ${isRunning ? '●' : '○'} ${padString(projectName, 8)} (${branch})${project.git.isDirty ? '*' : ''} ${isRunning ? `[${projectState.dopplerConfig}]` : ''}`;
        headerLine = colors.selected(padString(stripAnsi(headerLine), width - 4));
      }

      lines.push(`${BOX.vertical} ${padString(headerLine, width - 4)} ${BOX.vertical}`);

      // Stats line if running
      if (isRunning) {
        let statsStr = '';
        let totalCpu = 0;
        let totalMem = 0;
        let statCount = 0;

        for (const app of APPS) {
          const stats = processManager.getStats(project.alias, app.name);
          if (stats) {
            totalCpu += stats.cpu;
            totalMem += stats.memory;
            statCount++;
          }
        }

        if (statCount > 0) {
          const cpu = totalCpu.toFixed(1).padStart(5);
          const mem = totalMem.toFixed(0).padStart(4);
          statsStr = colors.dim(`   CPU: ${cpu}% MEM: ${mem}MB`);
        }

        const uptime = this.formatUptime(projectState.startedAt);
        const statsLeft = statsStr || '   ';
        const statsRight = colors.dim(`Running ${uptime}`);
        const statsPadding = width - stripAnsi(statsLeft).length - stripAnsi(statsRight).length - 4;
        const statsLine = `${statsLeft}${' '.repeat(Math.max(1, statsPadding))}${statsRight}`;
        lines.push(`${BOX.vertical} ${padString(statsLine, width - 4)} ${BOX.vertical}`);
      }

      // Separator between projects (except last)
      if (i < this.state.projects.length - 1) {
        lines.push(drawHorizontalLine(width));
      }
    }

    // Config row
    lines.push(`${BOX.vertical}${' '.repeat(width - 2)}${BOX.vertical}`);
    const runningCount = Object.keys(this.state.appState.activeProjects).length;
    const configText = `DEFAULT CONFIG: ${colors.highlight(this.state.appState.dopplerConfig)}`;
    const runningText = `${runningCount}/${this.state.projects.length} projects running`;
    const configPadding = width - stripAnsi(configText).length - stripAnsi(runningText).length - 4;
    lines.push(
      `${BOX.vertical} ${configText}${' '.repeat(Math.max(1, configPadding))}${runningText} ${BOX.vertical}`
    );

    // Fill remaining space
    const contentRows = lines.length;
    const footerRows = 3;
    const remainingRows = this.state.terminalHeight - contentRows - footerRows;
    for (let i = 0; i < Math.max(0, remainingRows); i++) {
      lines.push(`${BOX.vertical}${' '.repeat(width - 2)}${BOX.vertical}`);
    }

    // Help bar
    lines.push(drawHorizontalLine(width));
    const helpText = [
      `${colors.key('[1-3]')} Select`,
      `${colors.key('[Enter]')} Toggle`,
      `${colors.key('[A]')} Start All`,
      `${colors.key('[S]')} Stop All`,
      `${colors.key('[c]')} Config`,
      `${colors.key('[r]')} Restart`,
      `${colors.key('[l]')} Logs`,
      `${colors.key('[q]')} Quit`,
    ].join('  ');
    lines.push(`${BOX.vertical} ${padString(helpText, width - 4)} ${BOX.vertical}`);
    lines.push(drawBoxBottom(width));

    return lines;
  }

  private renderLogViewer(): string[] {
    const width = this.state.terminalWidth;
    const height = this.state.terminalHeight;
    const lines: string[] = [];

    const currentProject = this.state.projects[this.state.selectedLogProject];
    const app = APPS[this.state.selectedLogApp];
    const buffer = currentProject
      ? processManager.getLogBuffer(currentProject.alias, app.name)
      : { lines: [], searchMatches: [] };

    // Title bar
    lines.push(drawBoxTop(width));
    const projectName = currentProject?.alias || 'none';
    const projectState = currentProject ? this.state.appState.activeProjects[currentProject.alias] : null;
    const configName = projectState?.dopplerConfig || this.state.appState.dopplerConfig;
    const title = colors.title(`  LOGS: ${projectName} › ${app.name}`) + colors.dim(` (${configName})`);
    const projectIndicator = `[${this.state.selectedLogProject + 1}/${this.state.projects.length}]`;
    const appIndicator = `[${this.state.selectedLogApp + 1}/${APPS.length}]`;
    const followIndicator = this.state.logFollowMode ? colors.success('FOLLOW ●') : '';
    const searchIndicator = this.state.searchMode
      ? `Search: ${this.state.searchQuery}▌`
      : this.state.searchQuery
        ? `[${this.state.searchMatchIndex + 1}/${this.state.searchMatches.length}]`
        : '';

    const headerRight = `${searchIndicator}  ${followIndicator}  ${projectIndicator} ${appIndicator}`;
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
          `${colors.key('[[/]]')} Project`,
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
