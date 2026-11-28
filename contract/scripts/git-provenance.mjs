import { execFileSync } from 'node:child_process';

/** Source archives have content hashes but may have no Git metadata/tool. */
export function gitProvenance(root) {
  const optionalGit = (...args) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch { return null; }
  };
  return { gitCommit: optionalGit('rev-parse', 'HEAD'),
    gitStatus: optionalGit('status', '--porcelain=v1') };
}
