import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

function parseTag(tag) {
  const stable = /^v(\d+\.\d+\.\d+)$/.exec(tag);
  if (stable) return stable[1];
  const preview = /^(alpha|beta|rc)-(\d+\.\d+\.\d+)$/.exec(tag);
  return preview ? `${preview[2]}-${preview[1]}` : null;
}

function compareCore(a, b) {
  const left = a.split('-')[0].split('.').map(Number);
  const right = b.split('-')[0].split('.').map(Number);
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

export function resolveVersion({ refType, refName, baseVersion, tags, headTags }) {
  if (refType === 'tag') {
    const version = parseTag(refName);
    if (!version) throw new Error(`Tag '${refName}' fora do padrão (alpha-X.Y.Z, beta-X.Y.Z, rc-X.Y.Z, vX.Y.Z)`);
    return { version, tag: refName, release: true };
  }
  if (refName !== 'main') return { version: baseVersion, tag: '', release: false };

  const publishedTag = headTags.filter(tag => /^v\d+\.\d+\.\d+$/.test(tag))
    .sort((a, b) => compareCore(parseTag(b), parseTag(a)))[0];
  if (publishedTag) return { version: parseTag(publishedTag), tag: publishedTag, release: true };

  const latest = [baseVersion, ...tags.map(parseTag).filter(Boolean)].sort(compareCore).at(-1);
  const [major, minor, patch] = latest.split('-')[0].split('.').map(Number);
  const version = `${major}.${minor}.${patch + 1}`;
  return { version, tag: `v${version}`, release: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Refresh after acquiring the workflow concurrency lock, including on reruns.
  execFileSync('git', ['fetch', '--tags', 'origin'], { stdio: 'inherit' });
  const gitLines = args => execFileSync('git', args, { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
  const { version: baseVersion } = JSON.parse(readFileSync('desktop/src-tauri/tauri.conf.json', 'utf8'));
  const result = resolveVersion({
    refType: process.env.GITHUB_REF_TYPE,
    refName: process.env.GITHUB_REF_NAME,
    baseVersion,
    tags: gitLines(['tag', '--list']),
    headTags: gitLines(['tag', '--points-at', process.env.GITHUB_SHA]),
  });
  for (const [key, value] of Object.entries(result)) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
  console.log(`Versão: ${result.version}; tag: ${result.tag}; release: ${result.release}`);
}
