import { open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { parse } from 'yaml';
import { skillNames } from '../install/assets.js';
import type { ProcessRunner } from '../install/process.js';
import { CliError } from '../core/errors.js';
import { isVersion } from './registry.js';

export interface SkillResult {
  name: string;
  scope: 'project' | 'global';
  path?: string;
  version?: string;
  status:
    'matching' | 'mismatched' | 'missing-version' | 'absent' | 'unverifiable';
}

export async function readSkillVersion(
  directory: string,
  name: string,
): Promise<string | undefined> {
  const file = await open(join(directory, 'SKILL.md'), 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 1024 * 1024)
      throw new Error('Invalid skill file.');
    const content = await file.readFile('utf8');
    const front = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!front) throw new Error('Missing skill frontmatter.');
    const metadata = parse(front[1]!);
    if (metadata?.name !== name) throw new Error('Unexpected skill name.');
    const version: unknown = metadata.metadata?.version;
    if (version === undefined) return undefined;
    if (!isVersion(version)) throw new Error('Invalid skill version.');
    return version;
  } finally {
    await file.close();
  }
}

export async function inspectSkills(options: {
  version: string;
  runner: ProcessRunner;
  cwd: string;
  signal: AbortSignal;
}): Promise<SkillResult[]> {
  const results: SkillResult[] = [];
  for (const scope of ['project', 'global'] as const) {
    try {
      const listing = await options.runner({
        command: 'npx',
        args: [
          '--yes',
          'skills',
          'list',
          '--json',
          ...(scope === 'global' ? ['--global'] : []),
        ],
        cwd: options.cwd,
        signal: options.signal,
        timeoutMs: 60000,
      });
      if (listing.code === 130)
        throw new CliError('INTERRUPTED', 'Skill inspection interrupted.', {
          exitCode: 130,
        });
      if (listing.code !== 0) throw new Error('Skill discovery failed.');
      const entries: unknown = JSON.parse(listing.stdout);
      if (
        !Array.isArray(entries) ||
        entries.some((entry) => !entry || typeof entry.name !== 'string')
      )
        throw new Error('Invalid skill discovery output.');
      for (const name of skillNames) {
        const found = entries.filter((entry) => entry.name === name);
        if (!found.length) results.push({ name, scope, status: 'absent' });
        for (const entry of found) {
          const path =
            typeof entry.path === 'string' && isAbsolute(entry.path)
              ? entry.path
              : undefined;
          try {
            if (!path || entry.scope !== scope)
              throw new Error('Invalid skill location.');
            const version = await readSkillVersion(path, name);
            results.push({
              name,
              scope,
              path,
              version,
              status:
                version === undefined
                  ? 'missing-version'
                  : version === options.version
                    ? 'matching'
                    : 'mismatched',
            });
          } catch {
            results.push({ name, scope, path, status: 'unverifiable' });
          }
        }
      }
    } catch (error) {
      if (
        options.signal.aborted ||
        (error instanceof CliError && error.code === 'INTERRUPTED')
      )
        throw new CliError('INTERRUPTED', 'Skill inspection interrupted.', {
          exitCode: 130,
        });
      results.push(
        ...skillNames.map((name): SkillResult => ({
          name,
          scope,
          status: 'unverifiable',
        })),
      );
    }
  }
  return results;
}
