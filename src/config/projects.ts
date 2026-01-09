export interface Project {
  name: string;
  alias: string;
  path: string;
}

export interface AppConfig {
  name: string;
  port: number;
  command: string;
}

export const PROJECTS: Project[] = [
  {
    name: 'cubic',
    alias: 'cubic',
    path: '/Users/guypinchuk/Projects/cubic',
  },
  {
    name: 'cubic-alt',
    alias: 'alt',
    path: '/Users/guypinchuk/Projects/cubic-alt',
  },
  {
    name: 'cubic-alt-2',
    alias: 'alt-2',
    path: '/Users/guypinchuk/Projects/cubic-alt-2',
  },
];

export const APPS: AppConfig[] = [
  { name: 'api', port: 5555, command: 'nx serve api' },
  { name: 'client-app', port: 4200, command: 'nx serve client-app' },
  { name: 'mycelium', port: 4201, command: 'nx serve mycelium' },
];

export const DOPPLER_CONFIGS = ['dev', 'dev_guy'] as const;
export type DopplerConfig = (typeof DOPPLER_CONFIGS)[number];

export const STATE_DIR = `${process.env.HOME}/.cubicli`;
export const STATE_FILE = `${STATE_DIR}/state.json`;
export const LOG_DIR = `${STATE_DIR}/logs`;
