#!/usr/bin/env bun

import { TUIApp } from './ui/app';

let isShuttingDown = false;

async function shutdown(app: TUIApp, exitCode = 0): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  await app.stop();
  process.exit(exitCode);
}

async function main(): Promise<void> {
  const app = new TUIApp();

  // Handle process signals
  process.on('SIGINT', () => shutdown(app, 0));
  process.on('SIGTERM', () => shutdown(app, 0));

  // Handle uncaught errors
  process.on('uncaughtException', async (err) => {
    console.error('Uncaught exception:', err);
    await shutdown(app, 1);
  });

  process.on('unhandledRejection', async (err) => {
    console.error('Unhandled rejection:', err);
    await shutdown(app, 1);
  });

  await app.start();
}

main().catch(async (err) => {
  console.error('Failed to start cubicli:', err);
  process.exit(1);
});
