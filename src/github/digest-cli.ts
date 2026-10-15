/**
 * Writes a draft overview of one module of the codebase, for a person to review.
 *
 *   npm run digest -- list app_2/src/modules            modules (sub-folders) and their file counts
 *   npm run digest -- plan Shipments app_2/src/modules/shipments
 *                                                       the files that would be read; no AI call
 *   npm run digest -- generate Shipments app_2/src/modules/shipments --allow-code-to-ai
 *
 * Options: --repo owner/name (default: the first of GITHUB_REPOS)  --ref develop
 *          --out knowledge/codebase  --max-files 40
 *
 * The draft is written with "reviewed: false" and is not used until a person has checked it.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AIError } from '../ai/errors.js';
import { createProvider } from '../ai/index.js';
import { ConfigError, loadConfig } from '../config/env.js';
import { GitHubClient } from './client.js';
import { generateDigest, selectDigestFiles } from './digest.js';
import { GitHubError } from './errors.js';

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(arg.slice(2), next);
      i++;
    } else {
      flags.set(arg.slice(2), true);
    }
  }
  return { positional, flags };
}

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, first, second] = positional;

  const usage =
    'Usage: npm run digest -- list <folder>\n' +
    '       npm run digest -- plan <Module name> <folder>\n' +
    '       npm run digest -- generate <Module name> <folder> --allow-code-to-ai';
  const folder = command === 'list' ? first : second;
  if (!command || !['list', 'plan', 'generate'].includes(command) || !folder) {
    console.error(usage);
    process.exitCode = 1;
    return;
  }
  if (command !== 'list' && !first) {
    console.error(usage);
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  if (!config.github) {
    console.error(
      'Set GITHUB_TOKEN in .env first (a read-only token for the ShipNest repositories).',
    );
    process.exitCode = 1;
    return;
  }
  const repoFlag = flags.get('repo');
  const repo = typeof repoFlag === 'string' ? repoFlag : config.github.repos[0];
  if (!repo) {
    console.error('Set GITHUB_REPOS in .env (owner/name, comma-separated) or pass --repo.');
    process.exitCode = 1;
    return;
  }
  const ref = typeof flags.get('ref') === 'string' ? (flags.get('ref') as string) : 'develop';
  const maxFiles =
    typeof flags.get('max-files') === 'string' ? Number(flags.get('max-files')) : undefined;

  const client = new GitHubClient({ token: config.github.token });
  const tree = await client.listFiles(repo, ref);
  if (tree.truncated) {
    console.log('! GitHub cut the file list of this repository, so some files may be missing.');
  }

  if (command === 'list') {
    const prefix = folder.replace(/^\/+|\/+$/g, '');
    const counts = new Map<string, number>();
    for (const entry of tree.entries) {
      if (!entry.path.startsWith(`${prefix}/`)) continue;
      const [child] = entry.path.slice(prefix.length + 1).split('/');
      if (child) counts.set(child, (counts.get(child) ?? 0) + 1);
    }
    console.log(`${repo}@${ref} ${prefix}: ${counts.size} sub-folder(s)`);
    for (const [name, count] of [...counts].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(5)} files  ${prefix}/${name}`);
    }
    return;
  }

  const name = first as string;
  const choice = selectDigestFiles(tree.entries, {
    path: folder,
    ...(maxFiles !== undefined && { maxFiles }),
  });

  if (command === 'plan') {
    console.log(`${name}: ${choice.selected.length} file(s) would be read from ${repo}@${ref}`);
    for (const file of choice.selected) console.log(`  ${file.path} (${file.size} bytes)`);
    console.log(`${choice.skipped.length} file(s) left out:`);
    for (const file of choice.skipped.slice(0, 30)) console.log(`  ${file.path} (${file.reason})`);
    if (choice.skipped.length > 30) console.log(`  ... and ${choice.skipped.length - 30} more`);
    return;
  }

  if (!flags.has('allow-code-to-ai')) {
    console.error(
      'This would send ShipNest source code to the AI provider.\n' +
        'On a free tier the provider may use that content to improve its products and ' +
        'reviewers may read it.\nGet approval or use the paid tier, then add --allow-code-to-ai.\n' +
        'To see which files would be sent first, run: npm run digest -- plan ...',
    );
    process.exitCode = 1;
    return;
  }

  const provider = createProvider(config.ai);
  if (provider.name === 'fake') {
    console.error('AI_PROVIDER is "fake", which gives no real answers. Set AI_PROVIDER=gemini.');
    process.exitCode = 1;
    return;
  }

  const result = await generateDigest(provider, client, {
    repo,
    ref,
    path: folder,
    name,
    ...(maxFiles !== undefined && { maxFiles }),
  });

  const outDir =
    typeof flags.get('out') === 'string' ? (flags.get('out') as string) : 'knowledge/codebase';
  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `${slug(name)}.md`);
  await writeFile(file, result.markdown);

  console.log(
    `Wrote ${file}\n` +
      `  files read: ${result.included.length} | left out: ${result.skipped.length} | ` +
      `secrets replaced: ${result.secretsRedacted} | model: ${result.model} | ` +
      `tokens: ${result.usage.totalTokens}\n` +
      'It is a DRAFT and is not used until a person has checked it against the code and set\n' +
      '"reviewed: true" in its header.',
  );
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError || error instanceof GitHubError || error instanceof AIError) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
