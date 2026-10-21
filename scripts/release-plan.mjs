import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function releasePlan(tag, manifest, repository) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(tag);
  if (!match || match[4]?.split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) throw new Error('Use a SemVer tag such as v0.1.0 or v0.2.0-rc.1 (without build metadata).');
  const version = tag.slice(1);
  if (manifest.version !== version) throw new Error('Tag version must equal packages/client/package.json version.');
  if (manifest.private !== false || !/^@[a-z0-9-]+\/[a-z0-9._-]+$/.test(manifest.name)) throw new Error('Client must be a public scoped npm package.');
  for (const dependency of Object.values({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies })) {
    if (/^(workspace:|file:|link:)/.test(dependency)) throw new Error('Published client cannot depend on checkout-local packages.');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(repository)) throw new Error('GITHUB_REPOSITORY must identify an owner/repository.');
  return { version, npmTag: match[4] ? 'next' : 'latest', imagePrefix: 'ghcr.io/' + repository.toLowerCase(), repositoryUrl: 'git+https://github.com/' + repository + '.git' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const packagePath = resolve('packages/client/package.json');
  const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
  const plan = releasePlan(process.env.GITHUB_REF_NAME ?? '', manifest, process.env.GITHUB_REPOSITORY ?? '');
  if (process.argv.includes('--prepare-package')) {
    manifest.repository = { type: 'git', url: plan.repositoryUrl, directory: 'packages/client' };
    await writeFile(packagePath, JSON.stringify(manifest, null, 2) + '\n');
  }
  const output = 'version=' + plan.version + '\nnpm-tag=' + plan.npmTag + '\nimage-prefix=' + plan.imagePrefix + '\n';
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, output);
  process.stdout.write(output);
}
