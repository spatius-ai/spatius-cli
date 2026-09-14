import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  chmod,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bundledSkillsDirectory,
  InstallServices,
  skillNames,
} from '../src/install/services.js';
import {
  runProcess,
  type ProcessRequest,
  type ProcessResult,
} from '../src/install/process.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((p) => rm(p, { force: true, recursive: true })),
  );
});
async function fixture(platform: NodeJS.Platform = 'darwin') {
  const directory = await mkdtemp(join(tmpdir(), 'spatius install '));
  directories.push(directory);
  const root = join(directory, 'lib', 'node_modules');
  const pkg = join(root, '@spatius', 'cli');
  const bin = platform === 'win32' ? directory : join(directory, 'bin');
  await mkdir(join(pkg, 'dist'), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(pkg, 'package.json'),
    JSON.stringify({ name: '@spatius/cli', version: '0.1.0-beta.0' }),
  );
  await writeFile(join(pkg, 'dist', 'cli.js'), '');
  const binary = join(bin, platform === 'win32' ? 'spatius.cmd' : 'spatius');
  await writeFile(binary, '');
  await chmod(binary, 0o755);
  const runner = vi.fn(
    async (request: ProcessRequest): Promise<ProcessResult> => ({
      code: 0,
      stderr: '',
      stdout:
        request.args[0] === 'root'
          ? root
          : request.args[0] === 'prefix'
            ? directory
            : '0.1.0-beta.0\n',
    }),
  );
  const controller = new AbortController();
  const services = (path = bin) =>
    new InstallServices({
      runner,
      cwd: directory,
      signal: controller.signal,
      environment: { PATH: path },
      platform,
    });
  return { directory, bin, pkg, binary, runner, controller, services };
}

describe('installer package services', () => {
  it('reuses an exact version and verifies the executable', async () => {
    const h = await fixture();
    const service = h.services();
    expect(
      await service.installCli('0.1.0-beta.0', await service.inspectGlobal()),
    ).toEqual({ version: '0.1.0-beta.0', reused: true, available: true });
    expect(h.runner.mock.calls.some(([r]) => r.args[0] === 'install')).toBe(
      false,
    );
    expect(h.runner).toHaveBeenCalledWith(
      expect.objectContaining({ command: h.binary, args: ['--version'] }),
    );
  });
  it('installs the exact running version with separate argv even for paths with spaces', async () => {
    const h = await fixture();
    const service = h.services();
    const global = await service.inspectGlobal();
    await service.installCli('0.1.0-beta.0', { ...global, version: '0.0.1' });
    expect(h.runner).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'npm',
        args: ['install', '--global', '@spatius/cli@0.1.0-beta.0'],
        cwd: h.directory,
        inherit: false,
      }),
    );
  });
  it.each(['missing', 'shadowed'])(
    'reports %s PATH with concrete recovery paths',
    async (kind) => {
      const h = await fixture();
      const other = join(h.directory, 'other');
      await mkdir(other);
      if (kind === 'shadowed') {
        await writeFile(join(other, 'spatius'), '');
        await chmod(join(other, 'spatius'), 0o755);
      }
      const service = h.services(other);
      const result = await service.installCli(
        '0.1.0-beta.0',
        await service.inspectGlobal(),
      );
      expect(result.available).toBe(false);
      expect(result.warning).toContain(h.bin);
      expect(result.warning).toContain(h.binary);
      if (kind === 'shadowed')
        expect(result.warning).toContain(join(other, 'spatius'));
    },
  );
  it('ignores the temporary npx launcher when checking persistent PATH', async () => {
    const h = await fixture();
    const launcher = join(
      h.directory,
      '_npx',
      'abc123',
      'node_modules',
      '.bin',
    );
    await mkdir(launcher, { recursive: true });
    await writeFile(join(launcher, 'spatius'), '');
    await chmod(join(launcher, 'spatius'), 0o755);
    const service = h.services(`${launcher}:${h.bin}`);
    expect(
      (await service.installCli('0.1.0-beta.0', await service.inspectGlobal()))
        .available,
    ).toBe(true);
  });
  it('recognizes symlinked global binaries', async () => {
    const h = await fixture();
    const other = join(h.directory, 'alias');
    await mkdir(other);
    await symlink(h.binary, join(other, 'spatius'));
    const service = h.services(other);
    expect(
      (await service.installCli('0.1.0-beta.0', await service.inspectGlobal()))
        .available,
    ).toBe(true);
  });
  it('uses Windows global prefix and .cmd executable', async () => {
    const h = await fixture('win32');
    const service = h.services();
    const global = await service.inspectGlobal();
    expect(global.binary).toBe(join(h.directory, 'spatius.cmd'));
    expect((await service.installCli('0.1.0-beta.0', global)).available).toBe(
      true,
    );
  });
  it('classifies npm permissions without exposing captured secrets', async () => {
    const h = await fixture();
    const service = h.services();
    const global = await service.inspectGlobal();
    h.runner.mockResolvedValue({
      code: 1,
      stdout: '',
      stderr: 'EACCES DO_NOT_LOG_TEST_SECRET',
    });
    try {
      await service.installCli('0.1.0-beta.0', {
        ...global,
        version: undefined,
      });
      throw new Error('Expected error');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'INSTALL_FAILED',
        options: { recovery: expect.stringContaining('owned by your user') },
      });
      expect(JSON.stringify(error)).not.toContain('DO_NOT_LOG_TEST_SECRET');
    }
  });
  it('rejects missing or wrong-version global executables', async () => {
    const h = await fixture();
    const service = h.services();
    const global = await service.inspectGlobal();
    h.runner.mockResolvedValue({ code: 0, stdout: 'wrong', stderr: '' });
    await expect(
      service.installCli('0.1.0-beta.0', global),
    ).rejects.toMatchObject({ code: 'INSTALL_VERIFICATION_FAILED' });
    await rm(h.binary);
    await expect(
      service.installCli('0.1.0-beta.0', global),
    ).rejects.toMatchObject({ code: 'INSTALL_VERIFICATION_FAILED' });
  });
  it('hands off bundled skills with caller cwd and inherited terminal streams', async () => {
    const h = await fixture();
    const service = h.services();
    await service.installSkills();
    expect(h.runner).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'npx',
        args: [
          '--yes',
          'skills',
          'add',
          bundledSkillsDirectory(),
          '--skill',
          ...skillNames,
        ],
        cwd: h.directory,
        inherit: true,
      }),
    );
  });
  it.each([1, 130])(
    'handles skills exit %s without claiming success',
    async (code) => {
      const h = await fixture();
      h.runner.mockResolvedValue({ code, stdout: '', stderr: '' });
      await expect(h.services().installSkills()).rejects.toMatchObject({
        code: code === 130 ? 'INTERRUPTED' : 'INSTALL_FAILED',
      });
    },
  );
  it('rejects missing bundled assets before launching skills', async () => {
    const h = await fixture();
    const service = new InstallServices({
      runner: h.runner,
      cwd: h.directory,
      signal: h.controller.signal,
      skillsDirectory: h.directory,
    });
    await expect(service.installSkills()).rejects.toMatchObject({
      code: 'INSTALL_SKILLS_MISSING',
    });
    expect(h.runner).not.toHaveBeenCalled();
  });
  it('stops an aborted operation before spawning', async () => {
    const h = await fixture();
    h.controller.abort();
    await expect(h.services().prerequisites()).rejects.toMatchObject({
      code: 'INTERRUPTED',
    });
    expect(h.runner).not.toHaveBeenCalled();
  });
});

describe('installer subprocess runner', () => {
  const request = (args: string[], signal = new AbortController().signal) => ({
    command: process.execPath,
    args,
    cwd: tmpdir(),
    signal,
  });
  it('passes spaces and shell metacharacters literally', async () => {
    const value = 'path with spaces; $(echo unsafe) `echo unsafe` & %PATH%';
    const result = await runProcess(
      request(['-e', 'process.stdout.write(process.argv[1])', value]),
    );
    expect(result).toMatchObject({ code: 0, stdout: value });
  });
  it('reports nonzero exit and bounded diagnostics', async () => {
    const result = await runProcess(
      request([
        '-e',
        'process.stderr.write("x".repeat(100000)); process.exitCode=7',
      ]),
    );
    expect(result.code).toBe(7);
    expect(result.stderr.length).toBe(65536);
  });
  it('cancels a running process and removes abort listeners', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = runProcess(
      request(['-e', 'setInterval(() => {}, 1000)'], controller.signal),
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: 'INTERRUPTED',
      options: { exitCode: 130 },
    });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
  it('times out stalled prerequisite checks', async () => {
    await expect(
      runProcess({
        ...request(['-e', 'setInterval(() => {}, 1000)']),
        timeoutMs: 30,
      }),
    ).rejects.toMatchObject({ code: 'INSTALL_PROCESS_TIMEOUT' });
  });
  it('reports missing executables', async () => {
    await expect(
      runProcess({
        ...request([]),
        command: 'spatius-test-no-such-executable',
      }),
    ).rejects.toMatchObject({ code: 'INSTALL_PROCESS_UNAVAILABLE' });
  });
});
