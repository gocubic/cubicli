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
  logScrollOffset: number;
  logFollowMode: boolean;
  searchMode: boolean;
  searchQuery: string;
  searchMatches: number[];
  searchMatchIndex: number;
  quitConfirmMode: boolean;
  projects: ProjectWithGit[];
  appState: AppState;
  terminalWidth: number;
  terminalHeight: number;
}

export interface RenderContext {
  state: AppUIState;
  width: number;
  height: number;
}
