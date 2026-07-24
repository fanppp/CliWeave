/**
 * 极简单 * glob 匹配（满足 rules/*.md 这类模式）。
 * 生产级可换 fast-glob，v1 不引入重依赖。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function resolveGlob(pattern: string, baseDir: string = process.cwd()): string[] {
  const absPattern = resolve(baseDir, pattern);
  const starIndex = absPattern.indexOf('*');
  if (starIndex === -1) {
    return existsSync(absPattern) ? [absPattern] : [];
  }
  const dir = dirname(absPattern.slice(0, starIndex + 1));
  const suffix = absPattern.slice(starIndex + 1);
  const prefix = absPattern.slice(0, starIndex);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => {
      const full = join(dir, entry);
      try {
        if (!statSync(full).isFile()) return false;
      } catch {
        return false;
      }
      const abs = full;
      if (!abs.startsWith(prefix)) return false;
      if (!abs.endsWith(suffix)) return false;
      return true;
    })
    .map((entry) => join(dir, entry))
    .sort();
}
