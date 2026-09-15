import { dirname, join } from 'node:path';
import { asCliError, CliError } from '../core/errors.js';
import { InstallServices, type CliInstallation } from '../install/services.js';
import { skillNames } from '../install/assets.js';
import { runProcess, type ProcessRunner } from '../install/process.js';
import compare from 'semver/functions/compare.js';
import {
  fetchVersions,
  isVersion,
  selectVersion,
  type Channel,
} from './registry.js';
import { inspectSkills, readSkillVersion, type SkillResult } from './skills.js';

export interface UpdateResult {
  previousVersion: string;
  targetVersion?: string;
  cli?: CliInstallation;
  skillsCommand: 'pending' | 'completed' | 'failed';
  skills: SkillResult[];
  message?: string;
}

// All dependencies are imported before npm can replace the running package.
// The interactive installer and Studio context are never loaded here.
export async function runUpdate(options: {
  version: string;
  channel?: Channel;
  signal: AbortSignal;
  cwd?: string;
  runner?: ProcessRunner;
  fetcher?: typeof fetch;
  services?: Pick<
    InstallServices,
    'prerequisites' | 'inspectGlobal' | 'installCli'
  >;
}): Promise<UpdateResult> {
  const cwd = options.cwd ?? process.cwd();
  const runner = options.runner ?? runProcess;
  const services =
    options.services ??
    new InstallServices({ runner, cwd, signal: options.signal });
  const result: UpdateResult = {
    previousVersion: options.version,
    skillsCommand: 'pending',
    skills: [],
  };
  let stage = 'prerequisites';
  try {
    await services.prerequisites();
    stage = 'registry';
    const versions = await fetchVersions(options.signal, options.fetcher);
    const global = await services.inspectGlobal();
    // An older npx invocation must not downgrade a newer persistent installation.
    const current =
      isVersion(global.version) && compare(global.version, options.version) > 0
        ? global.version
        : options.version;
    result.targetVersion = selectVersion(current, versions, options.channel);
    stage = 'cli';
    result.cli = await services.installCli(result.targetVersion, global);
    stage = 'bundled-skills';
    const bundled = join(dirname(dirname(global.entry)), 'skills');
    for (const name of skillNames) {
      if (
        (await readSkillVersion(join(bundled, name), name)) !==
        result.cli.version
      )
        throw new CliError(
          'UPDATE_BUNDLE_MISMATCH',
          'The installed CLI contains missing or mismatched skill versions.',
        );
    }
    stage = 'skills';
    const updated = await runner({
      command: 'npx',
      args: ['--yes', 'skills', 'update', ...skillNames, '--yes'],
      cwd,
      signal: options.signal,
    });
    result.skillsCommand = updated.code === 0 ? 'completed' : 'failed';
    if (updated.code === 130)
      throw new CliError('INTERRUPTED', 'Skills update interrupted.', {
        exitCode: 130,
      });
    result.skills = await inspectSkills({
      version: result.cli.version,
      runner,
      cwd,
      signal: options.signal,
    });
    if (updated.code !== 0)
      throw new CliError(
        'UPDATE_SKILLS_FAILED',
        `Skills update exited with code ${updated.code}.`,
      );
    if (
      result.skills.some(
        (skill) => skill.status !== 'matching' && skill.status !== 'absent',
      )
    )
      throw new CliError(
        'UPDATE_SKILLS_INCOMPLETE',
        'The CLI is updated, but some installed skills do not match or could not be verified.',
      );
    result.message = result.skills.every((skill) => skill.status === 'absent')
      ? 'CLI verified. No Spatius skills were discovered; no skills were installed.'
      : 'CLI and discovered Spatius skills have matching versions.';
    return result;
  } catch (error) {
    const failure = asCliError(error);
    throw new CliError(
      failure.code.startsWith('INSTALL_')
        ? failure.code.replace('INSTALL_', 'UPDATE_')
        : failure.code,
      failure.code === 'INTERNAL_ERROR'
        ? `Update failed during ${stage}.`
        : failure.message,
      {
        exitCode: failure.options.exitCode,
        retryable: failure.options.retryable,
        recovery:
          stage === 'skills'
            ? 'Completed updates are retained. Inspect skills list --json and skills list --global --json. skills update follows recorded sources and can skip local bundles; resolve their source/version mismatch manually, then rerun spatius update. No fallback installation was attempted.'
            : 'Completed updates are retained. Check npm permissions, registry access, and the global CLI package, then rerun spatius update.',
        details: { stage, ...result },
      },
    );
  }
}
