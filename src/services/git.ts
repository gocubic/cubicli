export interface GitStatus {
  branch: string;
  isDirty: boolean;
}

export async function getCurrentBranch(projectPath: string): Promise<string> {
  const proc = Bun.spawn({
    cmd: ['git', 'branch', '--show-current'],
    cwd: projectPath,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const output = await new Response(proc.stdout).text();
  await proc.exited;

  return output.trim() || 'unknown';
}

export async function getGitStatus(projectPath: string): Promise<GitStatus> {
  const branch = await getCurrentBranch(projectPath);

  // Check for uncommitted changes
  const statusProc = Bun.spawn({
    cmd: ['git', 'status', '--porcelain'],
    cwd: projectPath,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const statusOutput = await new Response(statusProc.stdout).text();
  await statusProc.exited;

  const isDirty = statusOutput.trim().length > 0;

  return { branch, isDirty };
}

export async function getAllBranches(projectPath: string): Promise<string[]> {
  const proc = Bun.spawn({
    cmd: ['git', 'branch', '-a'],
    cwd: projectPath,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const output = await new Response(proc.stdout).text();
  await proc.exited;

  return output
    .split('\n')
    .map(line => line.replace(/^\*?\s+/, '').trim())
    .filter(Boolean);
}
