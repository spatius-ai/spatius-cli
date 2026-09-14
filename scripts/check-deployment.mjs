import { appendFile, readFile } from 'node:fs/promises';
import { checkDeployment, deploymentVersion, MEDIA_URL } from './release.mjs';

try {
  const [outputFile] = process.argv.slice(2);
  if (!outputFile) throw new Error('Pass the Wrangler deployment output file.');
  const version = deploymentVersion(await readFile(outputFile, 'utf8'));
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, 'version_id=' + version + '\n');
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      'Production Worker deployed: ' +
        version +
        '\n\nEndpoint: ' +
        MEDIA_URL +
        '\n\n',
    );
  await checkDeployment();
  console.log(
    'Production Worker health and unauthenticated-access checks passed.',
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
