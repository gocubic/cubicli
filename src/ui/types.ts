import type { Project, DopplerConfig } from '../config/projects';
import type { AppState } from '../services/state';
import type { GitStatus } from '../services/git';

export type ViewMode = 'dashboard' | 'logs';

export interface ProjectWithGit extends Project {
  git: GitStatus;
}

export interface AppUIState {
  viewMode: ViewMode;
  selectedProjectIndex: number;
  selectedLogApp: number;
  selectedLogProject: number; // Index of project to view logs for
  logScrollOffset: number;
  logFollowMode: boolean;
  // Velocity-based scrolling state
  scrollVelocity: number;      // Current velocity (lines per tick)
  scrollAccumulator: number;   // Sub-line precision accumulator
  lastScrollTime: number;      // Timestamp for velocity calculation
  momentumActive: boolean;     // Whether momentum animation is running
  searchMode: boolean;
  searchQuery: string;
  searchMatches: number[];
  searchMatchIndex: number;
  quitConfirmMode: boolean;
  projects: ProjectWithGit[];
  appState: AppState;
  terminalWidth: number;
  terminalHeight: number;
  // Action feedback
  lastAction: string;
  lastActionTime: number;
}

export interface RenderContext {
  state: AppUIState;
  width: number;
  height: number;
}
