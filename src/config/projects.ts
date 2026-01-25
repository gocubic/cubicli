export interface Project {
  name: string;
  alias: string;
  path: string;
  index: number;
}

export interface AppConfig {
  name: string;
  basePort: number;
  command: string;
  portEnvVar: string;  // The MICROSERVICE_*_PORT env var name
  hostEnvVar: string;  // The MICROSERVICE_*_HOST env var name
}

// Additional env vars that need port-based URL overrides
export const URL_ENV_VARS = {
  // NEXT_PUBLIC_API_BASE_URL -> http://localhost:{api_port}
  NEXT_PUBLIC_API_BASE_URL: 'api',
} as const;

export const PORT_OFFSET = 100;

export const PROJECTS: Project[] = [
  {
    name: 'cubic',
    alias: 'cubic',
    path: '/Users/guypinchuk/Projects/cubic',
    index: 0,
  },
  {
    name: 'cubic-alt',
    alias: 'alt',
    path: '/Users/guypinchuk/Projects/cubic-alt',
    index: 1,
  },
  {
    name: 'cubic-alt-2',
    alias: 'alt-2',
    path: '/Users/guypinchuk/Projects/cubic-alt-2',
    index: 2,
  },
];

export const APPS: AppConfig[] = [
  {
    name: 'api',
    basePort: 5555,
    command: 'nx serve api',
    portEnvVar: 'MICROSERVICE_API_PORT',
    hostEnvVar: 'MICROSERVICE_API_HOST',
  },
  {
    name: 'client-app',
    basePort: 4200,
    command: 'nx serve client-app',
    portEnvVar: 'MICROSERVICE_CLIENT_APP_PORT',
    hostEnvVar: 'MICROSERVICE_CLIENT_APP_HOST',
  },
  {
    name: 'mycelium',
    basePort: 4201,
    command: 'nx serve mycelium',
    portEnvVar: 'MICROSERVICE_MYCELIUM_PORT',
    hostEnvVar: 'MICROSERVICE_MYCELIUM_HOST',
  },
];

/**
 * Get the actual port for an app running in a specific project
 * Formula: actualPort = basePort + (projectIndex × PORT_OFFSET)
 */
export function getPortForApp(app: AppConfig, project: Project): number {
  return app.basePort + (project.index * PORT_OFFSET);
}

/**
 * Get all ports that would be used by a project
 */
export function getProjectPorts(project: Project): number[] {
  return APPS.map(app => getPortForApp(app, project));
}

export const DOPPLER_CONFIGS = ['dev', 'dev_guy'] as const;
export type DopplerConfig = (typeof DOPPLER_CONFIGS)[number];

export const STATE_DIR = `${process.env.HOME}/.cubicli`;
export const STATE_FILE = `${STATE_DIR}/state.json`;
export const LOG_DIR = `${STATE_DIR}/logs`;
