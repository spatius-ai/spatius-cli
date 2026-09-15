import { isAbsolute } from 'node:path';
import { checkForUpdates } from './check.js';

// A hard deadline also bounds process lifetime when a filesystem or dependency stalls.
const deadline = setTimeout(() => process.exit(0), 10000);
deadline.unref();
const [directory, nonce] = process.argv.slice(2);
if (
  directory &&
  isAbsolute(directory) &&
  nonce &&
  /^[a-f0-9-]{36}$/.test(nonce)
)
  await checkForUpdates(directory, nonce, AbortSignal.timeout(5000));
clearTimeout(deadline);
