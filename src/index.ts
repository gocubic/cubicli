#!/usr/bin/env bun

import { TUIApp } from './ui/app';

async function main(): Promise<void> {
  const app = new TUIApp();

  // Handle process signals
  process.on('SIGINT', async () => {
    await app.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await app.stop();
    process.exit(0);
  });

  // Handle uncaught errors
  process.on('uncaughtException', async (err) => {
    await app.stop();
    console.error('Uncaught exception:', err);
    process.exit(1);
  });

  process.on('unhandledRejection', async (err) => {
    await app.stop();
    console.error('Unhandled rejection:', err);
    process.exit(1);
  });

  await app.start();
}

main().catch(async (err) => {
  console.error('Failed to start cubicli:', err);
  process.exit(1);
});
