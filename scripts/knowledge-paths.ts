import path from 'node:path';

export function relativeLink(fromDirectory: string, targetPath: string): string {
  return path.relative(fromDirectory, targetPath).split(path.sep).join('/');
}
