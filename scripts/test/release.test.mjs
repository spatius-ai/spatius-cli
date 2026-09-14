import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  checkDeployment,
  deploymentVersion,
  integrity,
  requireUnpublished,
  validateCheckout,
  validateRelease,
  verifyArtifact,
} from '../release.mjs';

function event(tag = 'v1.2.3', prerelease = false) {
  return {
    action: 'published',
    release: { tag_name: tag, prerelease, draft: false },
    repository: { full_name: 'spatius-ai/spatius-cli', private: false },
  };
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'spatius-release-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('canonical release versions select the intended npm channel', () => {
  for (const [tag, prerelease, distTag] of [
    ['v0.1.0', false, 'latest'],
    ['v12.34.56', false, 'latest'],
    ['v0.1.0-beta.0', true, 'beta'],
    ['v1.0.0-rc.2', true, 'beta'],
    ['v1.0.0-0', true, 'beta'],
    ['v1.0.0-preview-01.0a', true, 'beta'],
  ]) {
    assert.deepEqual(validateRelease(event(tag, prerelease)), {
      tag,
      version: tag.slice(1),
      distTag,
    });
  }
});

test('invalid release tags cannot become npm versions', () => {
  for (const tag of [
    '1.2.3',
    'v01.2.3',
    'v1.02.3',
    'v1.2.03',
    'v1.2',
    'v1.2.3.4',
    'v1.2.3-',
    'v1.2.3-beta..1',
    'v1.2.3-beta.01',
    'v1.2.3-01',
    'v1.2.3+build.1',
    'v1.2.3-beta.1+build.1',
    'v1.2.3\n',
    'v1.2.3;touch /tmp/release',
    '',
    null,
    123,
  ]) {
    assert.throws(() => validateRelease(event(tag)), undefined, String(tag));
  }
});

test('release visibility, repository, event, and prerelease policy fail closed', () => {
  const mutations = [
    (e) => {
      e.repository.private = true;
    },
    (e) => {
      delete e.repository.private;
    },
    (e) => {
      e.repository.full_name = 'another-owner/spatius-cli';
    },
    (e) => {
      delete e.repository;
    },
    (e) => {
      e.action = 'created';
    },
    (e) => {
      e.release.draft = true;
    },
    (e) => {
      delete e.release.draft;
    },
    (e) => {
      delete e.release.prerelease;
    },
    (e) => {
      e.release.prerelease = 'false';
    },
    (e) => {
      e.release.prerelease = true;
    },
    (e) => {
      e.release.tag_name = 'v1.2.3-beta.1';
    },
  ];
  for (const mutate of mutations) {
    const input = event();
    mutate(input);
    assert.throws(() => validateRelease(input));
  }
  assert.throws(() => validateRelease(undefined));
});

test('release checkout must be the tagged original commit reachable from main', async (t) => {
  const root = await temporaryDirectory(t);
  const git = (...args) =>
    execFileSync(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'user.name=Release Test',
        '-c',
        'user.email=release-test@example.invalid',
        ...args,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trim();
  git('init', '--quiet', '--initial-branch=main');
  git('commit', '--allow-empty', '--no-gpg-sign', '--quiet', '-m', 'base');
  const original = git('rev-parse', 'HEAD');
  git('tag', 'v1.2.3');
  git('update-ref', 'refs/remotes/origin/main', original);
  assert.doesNotThrow(() => validateCheckout(root, 'v1.2.3', original));
  assert.throws(
    () => validateCheckout(root, 'v1.2.3', original.slice(0, 7)),
    /full.*SHA/,
  );
  assert.throws(
    () => validateCheckout(root, 'v1.2.3', '0'.repeat(40)),
    /match/,
  );

  git(
    'commit',
    '--allow-empty',
    '--no-gpg-sign',
    '--quiet',
    '-m',
    'not merged',
  );
  const next = git('rev-parse', 'HEAD');
  git('tag', 'v1.2.4');
  assert.throws(() => validateCheckout(root, 'v1.2.4', next), /reachable/);
  assert.throws(() => validateCheckout(root, 'v1.2.3', next), /match/);

  git('update-ref', 'refs/remotes/origin/main', next);
  git('checkout', '--quiet', '--detach', original);
  assert.doesNotThrow(() => validateCheckout(root, 'v1.2.3', original));
  git('tag', '--force', 'v1.2.3', next);
  assert.throws(() => validateCheckout(root, 'v1.2.3', original), /match/);
});

test('npm preflight permits only 404 and releases response bodies', async () => {
  for (const status of [200, 401, 403, 429, 500, 503, 301, 302, 204, 404]) {
    let cancelled = false;
    const run = requireUnpublished('1.2.3-beta.0', async (url, options) => {
      assert.equal(
        url,
        'https://registry.npmjs.org/%40spatius%2Fcli/1.2.3-beta.0',
      );
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers['Cache-Control'], 'no-cache');
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.method, undefined);
      return {
        status,
        body: {
          cancel: async () => {
            cancelled = true;
          },
        },
      };
    });
    if (status === 404) await run;
    else
      await assert.rejects(
        run,
        status === 200 ? /already exists/ : /lookup failed/,
      );
    assert.equal(cancelled, true);
  }
});

test('npm network failure and transfer deadline stop admission', async (t) => {
  await assert.rejects(
    requireUnpublished('1.2.3', async () => {
      throw new TypeError('Network unavailable');
    }),
    /Network unavailable/,
  );
  const controller = new AbortController();
  t.mock.method(AbortSignal, 'timeout', (milliseconds) => {
    assert.equal(milliseconds, 15_000);
    return controller.signal;
  });
  const reason = new Error('Registry deadline');
  await assert.rejects(
    requireUnpublished('1.2.3', async (_url, options) => {
      controller.abort(reason);
      options.signal.throwIfAborted();
    }),
    reason,
  );
});

test('prepare-release changes only the runner manifest after every preflight succeeds', async (t) => {
  const root = await temporaryDirectory(t);
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'packages/cli'), { recursive: true });
  for (const name of ['prepare-release.mjs', 'release.mjs']) {
    await writeFile(
      join(root, 'scripts', name),
      await readFile(new URL('../' + name, import.meta.url)),
    );
  }
  const manifestPath = join(root, 'packages/cli/package.json');
  const originalManifest =
    JSON.stringify(
      {
        name: '@spatius/cli',
        version: '0.1.0-beta.0',
        bin: { spatius: './dist/cli.js' },
        description: 'Preserve other manifest fields',
      },
      null,
      2,
    ) + '\n';
  await writeFile(manifestPath, originalManifest);
  const preload = join(root, 'mock-fetch.mjs');
  await writeFile(
    preload,
    `
    globalThis.fetch = async (url, options) => {
      if (url !== 'https://registry.npmjs.org/%40spatius%2Fcli/0.1.0-beta.1')
        throw new Error('Unexpected external request');
      if (options.redirect !== 'error') throw new Error('Unsafe registry redirect');
      return new Response(null, { status: Number(process.env.TEST_REGISTRY_STATUS) });
    };
  `,
  );
  const gitEnvironment = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const git = (...args) =>
    execFileSync(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'user.name=Release Test',
        '-c',
        'user.email=release-test@example.invalid',
        ...args,
      ],
      {
        cwd: root,
        env: gitEnvironment,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trim();
  git('init', '--quiet', '--initial-branch=main');
  git('add', 'scripts', 'packages', 'mock-fetch.mjs');
  git('commit', '--no-gpg-sign', '--quiet', '-m', 'release source');
  const sha = git('rev-parse', 'HEAD');
  git('tag', 'v0.1.0-beta.1');
  git('update-ref', 'refs/remotes/origin/main', sha);
  const eventPath = join(root, 'github-event.json');
  const outputPath = join(root, 'github-output');
  await writeFile(eventPath, JSON.stringify(event('v0.1.0-beta.1', true)));
  await writeFile(outputPath, '');
  const run = (status) =>
    spawnSync(
      process.execPath,
      ['--import', preload, join(root, 'scripts/prepare-release.mjs')],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...gitEnvironment,
          NODE_OPTIONS: '',
          GITHUB_EVENT_NAME: 'release',
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_SHA: sha,
          GITHUB_OUTPUT: outputPath,
          TEST_REGISTRY_STATUS: String(status),
        },
      },
    );

  for (const status of [500, 200]) {
    const result = run(status);
    assert.equal(result.status, 1, result.stderr);
    assert.match(
      result.stderr,
      status === 200 ? /already exists/ : /lookup failed/,
    );
    assert.equal(await readFile(manifestPath, 'utf8'), originalManifest);
    assert.equal(await readFile(outputPath, 'utf8'), '');
    assert.equal(git('diff', '--name-only'), '');
  }
  const result = run(404);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')), {
    ...JSON.parse(originalManifest),
    version: '0.1.0-beta.1',
  });
  assert.equal(
    await readFile(outputPath, 'utf8'),
    'version=0.1.0-beta.1\ndist_tag=beta\ntag=v0.1.0-beta.1\n',
  );
  assert.equal(git('diff', '--name-only'), 'packages/cli/package.json');
  assert.equal(git('rev-parse', 'HEAD'), sha);
  assert.equal(git('tag', '--list'), 'v0.1.0-beta.1');
});

async function artifactFixture(t) {
  const directory = await temporaryDirectory(t);
  const version = '0.1.0-beta.1';
  const filename = 'spatius-cli-' + version + '.tgz';
  const bytes = Buffer.from('Validated package bytes');
  const metadata = {
    name: '@spatius/cli',
    version,
    filename,
    integrity: integrity(bytes),
  };
  await writeFile(join(directory, filename), bytes);
  const save = (value = metadata) =>
    writeFile(join(directory, 'release-artifact.json'), JSON.stringify(value));
  await save();
  return { directory, version, filename, bytes, metadata, save };
}

test('artifact verification binds package, version, filename, and exact bytes', async (t) => {
  const fixture = await artifactFixture(t);
  const verified = await verifyArtifact(fixture.directory, fixture.version);
  assert.equal(verified.tarball, join(fixture.directory, fixture.filename));
  assert.deepEqual(await readFile(verified.tarball), fixture.bytes);
  assert.equal(verified.integrity, fixture.metadata.integrity);
  for (const change of [
    { name: 'spatius-cli' },
    { version: '0.1.0' },
    { filename: '../spatius-cli-0.1.0-beta.1.tgz' },
    { filename: '/tmp/spatius-cli-0.1.0-beta.1.tgz' },
    { integrity: 'sha256-not-the-required-digest' },
    { integrity: null },
  ]) {
    await fixture.save({ ...fixture.metadata, ...change });
    await assert.rejects(
      verifyArtifact(fixture.directory, fixture.version),
      /metadata/,
    );
  }
  await fixture.save();
  await writeFile(verified.tarball, 'Modified after validation');
  await assert.rejects(
    verifyArtifact(fixture.directory, fixture.version),
    /integrity/,
  );
  await rm(verified.tarball);
  await assert.rejects(
    verifyArtifact(fixture.directory, fixture.version),
    /ENOENT/,
  );
  await rm(join(fixture.directory, 'release-artifact.json'));
  await assert.rejects(
    verifyArtifact(fixture.directory, fixture.version),
    /ENOENT/,
  );
});

const deployment = {
  type: 'deploy',
  version: 1,
  worker_name: 'spatius-cli-media',
  wrangler_environment: 'production',
  version_id: '11111111-2222-4333-8444-555555555555',
};

test('Wrangler output must identify exactly one production deployment', () => {
  const encode = (...entries) =>
    entries.map((entry) => JSON.stringify(entry)).join('\n');
  assert.equal(
    deploymentVersion(encode({ type: 'build' }, deployment) + '\n'),
    deployment.version_id,
  );
  for (const contents of [
    '',
    'not JSON',
    encode({ type: 'build' }),
    encode(deployment, deployment),
    ...[
      { version: 2 },
      { worker_name: 'spatius-cli-media-staging' },
      { wrangler_environment: 'staging' },
      { version_id: 'not-a-version-uuid' },
    ].map((change) => encode({ ...deployment, ...change })),
  ])
    assert.throws(() => deploymentVersion(contents));
});

function healthyResponse(url) {
  return url.endsWith('/health')
    ? Response.json({ status: 'ok' })
    : Response.json(
        { error: { code: 'unauthenticated', retryable: false } },
        { status: 401 },
      );
}

test('deployment probes use direct unauthenticated reads with bounded transfers', async (t) => {
  const deadlines = [];
  const controller = new AbortController();
  t.mock.method(AbortSignal, 'timeout', (milliseconds) => {
    deadlines.push(milliseconds);
    return new AbortController().signal;
  });
  const requests = [];
  await checkDeployment({
    signal: controller.signal,
    fetcher: async (url, options) => {
      requests.push(url);
      assert.equal(options.method ?? 'GET', 'GET');
      assert.equal(options.headers, undefined);
      assert.equal(options.body, undefined);
      assert.equal(options.redirect, 'error');
      assert.equal(options.cache, 'no-store');
      assert.ok(options.signal instanceof AbortSignal);
      return healthyResponse(url);
    },
    sleep: async () => {
      assert.fail('Healthy deployment should not retry');
    },
  });
  assert.deepEqual(requests, [
    'https://cli-media.spatius.ai/health',
    'https://cli-media.spatius.ai/v1/uploads',
  ]);
  assert.deepEqual(deadlines, [5000, 5000]);
});

test('deployment retries recover from propagation and stop at their attempt budget', async () => {
  let healthCalls = 0;
  const sleeps = [];
  await checkDeployment({
    attempts: 3,
    fetcher: async (url) => {
      if (url.endsWith('/health') && ++healthCalls < 3)
        return new Response('Propagating', { status: 503 });
      return healthyResponse(url);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(healthCalls, 3);
  assert.deepEqual(sleeps, [5000, 5000]);

  let failedCalls = 0;
  let failedSleeps = 0;
  await assert.rejects(
    checkDeployment({
      attempts: 3,
      fetcher: async () => {
        failedCalls++;
        throw new Error('Unavailable');
      },
      sleep: async () => {
        failedSleeps++;
      },
    }),
    /bounded retries/,
  );
  assert.equal(failedCalls, 3);
  assert.equal(failedSleeps, 2);
});

test('bad health and upload-auth responses cannot pass deployment checks', async () => {
  for (const [health, denied] of [
    [
      () => Response.json({ status: 'degraded' }),
      () => healthyResponse('/v1/uploads'),
    ],
    [() => new Response('Invalid JSON'), () => healthyResponse('/v1/uploads')],
    [() => healthyResponse('/health'), () => Response.json({ status: 'ok' })],
    [
      () => healthyResponse('/health'),
      () => Response.json({ error: { code: 'different' } }, { status: 401 }),
    ],
    [
      () => healthyResponse('/health'),
      () => new Response('Invalid JSON', { status: 401 }),
    ],
    [
      () => new Response(null, { status: 302 }),
      () => healthyResponse('/v1/uploads'),
    ],
  ]) {
    await assert.rejects(
      checkDeployment({
        attempts: 1,
        fetcher: async (url) => (url.endsWith('/health') ? health() : denied()),
        sleep: async () => {
          assert.fail('One attempt cannot sleep');
        },
      }),
      /checks failed/,
    );
  }
});

test('aborting deployment checks prevents additional network requests', async () => {
  const alreadyAborted = new AbortController();
  alreadyAborted.abort(new Error('Stopped before polling'));
  await assert.rejects(
    checkDeployment({
      signal: alreadyAborted.signal,
      fetcher: async () => {
        assert.fail('Aborted probe must not connect');
      },
    }),
    /Stopped before polling/,
  );

  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    checkDeployment({
      signal: controller.signal,
      fetcher: async () => {
        calls++;
        throw new Error('Not ready');
      },
      sleep: async (_ms, signal) => {
        controller.abort(new Error('Stopped while waiting'));
        signal.throwIfAborted();
      },
    }),
    /Stopped while waiting/,
  );
  assert.equal(calls, 1);
});
