import { spawnSync } from 'node:child_process';

const generatedPaths = [
  'data/reference',
  'tests/conformance/cases',
  'tests/conformance/regions/point_in_region.json',
  'packages-py/lod_data/src/lod_data/regions_builtin.json',
  'services/api/src/lod_api/catalog.json',
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

const generationStatus = run('pnpm', ['gen:reference']);
if (generationStatus !== 0) process.exit(generationStatus);

const diffStatus = run('git', ['diff', '--exit-code', '--', ...generatedPaths]);
const untracked = spawnSync(
  'git',
  ['ls-files', '--others', '--exclude-standard', '--', ...generatedPaths],
  { encoding: 'utf8' },
);
if (untracked.error) throw untracked.error;
if (untracked.status !== 0) process.exit(untracked.status ?? 1);

const generatedButUntracked = untracked.stdout.trim();
if (generatedButUntracked) {
  console.error('Generated files are not tracked:');
  console.error(generatedButUntracked);
  console.error('Add these generated artifacts so clean checkouts receive the complete contract.');
}

process.exit(diffStatus === 0 && !generatedButUntracked ? 0 : 1);
