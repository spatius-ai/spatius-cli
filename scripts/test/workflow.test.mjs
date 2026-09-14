import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';

const workflow = parse(
  await readFile(
    new URL('../../.github/workflows/publish.yml', import.meta.url),
    'utf8',
  ),
);
const { build, deploy, publish } = workflow.jobs;
const dependencies = (job) => [job.needs ?? []].flat();
const action = (job, name) =>
  job.steps.find((step) => step.uses?.startsWith('actions/' + name + '@'));
const command = (job, match) =>
  job.steps.find((step) => match.test(step.run ?? ''));
const index = (job, step) => job.steps.indexOf(step);

test('published releases include prereleases and serialize production work', () => {
  assert.deepEqual(workflow.on, { release: { types: ['published'] } });
  assert.equal(typeof workflow.concurrency.group, 'string');
  assert.equal(workflow.concurrency.group.includes('${{'), false);
  assert.equal(workflow.concurrency.queue, 'max');
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  for (const job of Object.values(workflow.jobs)) {
    assert.equal(job.if, undefined);
    assert.equal(job.environment, undefined);
    assert.equal(job['runs-on'], 'ubuntu-latest');
    assert.ok(job['timeout-minutes'] > 0 && job['timeout-minutes'] <= 30);
  }
});

test('job dependency graph prevents deployment or publication after failed prerequisites', () => {
  assert.deepEqual(Object.keys(workflow.jobs), ['build', 'deploy', 'publish']);
  assert.deepEqual(dependencies(build), []);
  assert.deepEqual(dependencies(deploy), ['build']);
  assert.deepEqual(
    new Set(dependencies(publish)),
    new Set(['build', 'deploy']),
  );
  const eligible = (job, outcomes) =>
    dependencies(job).every((name) => outcomes[name] === 'success');
  for (const result of ['failure', 'cancelled', 'skipped']) {
    assert.equal(eligible(deploy, { build: result }), false);
    assert.equal(
      eligible(publish, { build: result, deploy: 'skipped' }),
      false,
    );
    assert.equal(
      eligible(publish, { build: 'success', deploy: result }),
      false,
    );
  }
  assert.equal(
    eligible(publish, { build: 'success', deploy: 'success' }),
    true,
  );
  assert.equal(dependencies(deploy).includes('publish'), false);
  for (const job of Object.values(workflow.jobs)) {
    assert.equal(job['continue-on-error'], undefined);
    for (const step of job.steps)
      assert.equal(step['continue-on-error'], undefined);
  }
});

test('Cloudflare secrets and npm OIDC are isolated to their required jobs', () => {
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(workflow.env, undefined);
  assert.equal(build.permissions, undefined);
  assert.equal(deploy.permissions, undefined);
  assert.deepEqual(publish.permissions, {
    contents: 'read',
    'id-token': 'write',
  });
  const credentialSteps = [];
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.equal(job.env, undefined);
    for (const step of job.steps) {
      for (const [key, value] of Object.entries(step.env ?? {})) {
        assert.doesNotMatch(
          key,
          /^(NPM_TOKEN|NODE_AUTH_TOKEN|SIGNING_KEYS|SPATIUS_API_KEY|SPATIUS_ACCESS_TOKEN)$/,
        );
        if (String(value).includes('secrets.'))
          credentialSteps.push({ name, key, value, step });
      }
    }
  }
  assert.equal(credentialSteps.length, 1);
  const [credential] = credentialSteps;
  assert.equal(credential.name, 'deploy');
  assert.equal(credential.key, 'CLOUDFLARE_API_TOKEN');
  assert.equal(credential.value, '${{ secrets.CLOUDFLARE_API_TOKEN }}');
  assert.match(credential.step.run, /wrangler deploy --env production/);
  assert.equal(
    credential.step.env.CLOUDFLARE_ACCOUNT_ID,
    '${{ vars.CLOUDFLARE_ACCOUNT_ID }}',
  );
});

test('all jobs use the original release commit and perform eligibility checks before mutation', () => {
  for (const job of [build, deploy, publish]) {
    const checkout = action(job, 'checkout');
    assert.equal(checkout.with.ref, '${{ github.sha }}');
    assert.equal(checkout.with['fetch-depth'], 0);
    assert.equal(checkout.with['persist-credentials'], false);
    assert.equal(action(job, 'setup-node').with['node-version'], 24);
    assert.equal(
      action(job, 'setup-node').with['package-manager-cache'],
      false,
    );
    const preflight = command(job, /node scripts\/prepare-release\.mjs/);
    assert.ok(preflight);
    const mutation = command(job, /wrangler deploy|npm publish/);
    if (mutation) assert.ok(index(job, preflight) < index(job, mutation));
  }
  const worker = command(deploy, /wrangler deploy/);
  assert.match(worker.run, /--tag "\$RELEASE_TAG" --message "\$RELEASE_SHA"/);
  assert.equal(worker.env.RELEASE_SHA, '${{ github.sha }}');
  assert.equal(worker.env.RELEASE_TAG, '${{ needs.build.outputs.tag }}');
  const health = command(deploy, /node scripts\/check-deployment\.mjs/);
  assert.ok(index(deploy, worker) < index(deploy, health));
  assert.equal(
    deploy.outputs.version_id,
    '${{ steps.' + health.id + '.outputs.version_id }}',
  );
});

test('publication consumes the exact validated build artifact without rebuilding', () => {
  const checks = command(build, /^pnpm check$/m);
  const pack = command(build, /pnpm package:check.*--artifact-dir/);
  const upload = action(build, 'upload-artifact');
  assert.ok(checks, 'Release artifacts require the full check suite');
  assert.ok(pack);
  assert.ok(upload);
  assert.ok(index(build, checks) < index(build, pack));
  assert.ok(index(build, pack) < index(build, upload));
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert.match(upload.with.path, /release\/\*\.tgz/);
  assert.match(upload.with.path, /release\/release-artifact\.json/);
  assert.equal(
    build.outputs.artifact_id,
    '${{ steps.' + upload.id + '.outputs.artifact-id }}',
  );
  const download = action(publish, 'download-artifact');
  assert.equal(
    download.with['artifact-ids'],
    '${{ needs.build.outputs.artifact_id }}',
  );
  const verify = command(publish, /node scripts\/verify-release-artifact\.mjs/);
  const npm = command(publish, /^npm publish /m);
  assert.ok(index(publish, download) < index(publish, verify));
  assert.ok(index(publish, verify) < index(publish, npm));
  assert.equal(
    verify.env.RELEASE_VERSION,
    '${{ needs.build.outputs.version }}',
  );
  assert.equal(
    npm.env.RELEASE_TARBALL,
    '${{ steps.' + verify.id + '.outputs.tarball }}',
  );
  assert.equal(npm.env.NPM_DIST_TAG, '${{ needs.build.outputs.dist_tag }}');
  assert.match(npm.run, /^npm publish "\$RELEASE_TARBALL"/);
  assert.match(npm.run, /--ignore-scripts/);
  assert.match(npm.run, /--access public/);
  assert.match(npm.run, /--provenance(?:\s|$)/);
  for (const step of publish.steps)
    assert.doesNotMatch(
      step.run ?? '',
      /(?:npm|pnpm) (?:install|pack|build|check)(?:\s|$)/m,
    );
  assert.equal(
    action(publish, 'setup-node').with['registry-url'],
    'https://registry.npmjs.org',
  );
});

test('failure handlers report partial state without rollback or repeated npm publication', () => {
  const allSteps = Object.values(workflow.jobs).flatMap((job) => job.steps);
  assert.equal(
    allSteps.filter((step) => /^npm publish /m.test(step.run ?? '')).length,
    1,
  );
  for (const step of allSteps) {
    assert.doesNotMatch(
      step.run ?? '',
      /^\s*(?:(?:pnpm|npx).*?wrangler|wrangler)\s+rollback(?:\s|$)/m,
    );
    if (step.if === 'failure()') {
      assert.match(step.run, /GITHUB_STEP_SUMMARY/);
      assert.doesNotMatch(step.run, /^\s*(?:npm|pnpm|npx|wrangler)\b/m);
    }
  }
  assert.ok(publish.steps.some((step) => step.if === 'failure()'));
});
