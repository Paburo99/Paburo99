import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = ['assets/activity.svg', 'assets/activity-mobile.svg'];
const query = 'query { user(login: "Paburo99") { contributionsCollection { contributionCalendar { totalContributions } totalCommitContributions totalIssueContributions totalPullRequestContributions totalPullRequestReviewContributions } } }';
const colors = ['#B7ACC9', '#DDA66B', '#8499BE', '#AEC66F'];

export function normalize(collection) {
  const total = collection?.contributionCalendar?.totalContributions;
  const values = [['commits', collection?.totalCommitContributions], ['pull requests', collection?.totalPullRequestContributions], ['issues', collection?.totalIssueContributions], ['reviews', collection?.totalPullRequestReviewContributions]];
  if (!Number.isInteger(total) || total < 0 || values.some(([, n]) => !Number.isInteger(n) || n < 0)) throw Error('Incomplete GitHub contribution data; existing graphics were not changed.');
  const sum = values.reduce((n, [, v]) => n + v, 0);
  const parts = values.filter(([, n]) => n > 0).map(([label, n]) => ({ label, percent: Math.floor(n * 100 / sum), remainder: n * 100 / sum % 1 }));
  let remaining = 100 - parts.reduce((n, p) => n + p.percent, 0);
  for (const part of [...parts].sort((a, b) => b.remainder - a.remainder)) if (remaining-- > 0) part.percent++;
  return { total, breakdown: parts.map(({ label, percent }) => ({ label, percent })) };
}

export function renderActivity(template, data) {
  const glyphs = new Map([...template.matchAll(/id="([pb]-\d+)" data-advance="([\d.]+)"/g)].map(m => [m[1], Number(m[2])]));
  if (!glyphs.size || !template.includes('<!-- activity:start -->')) throw Error('The activity graphic is missing its embedded lettering.');
  const width = Number(template.match(/<svg\b[^>]*\bwidth="(\d+)"/)?.[1]);
  if (![640, 1000].includes(width)) throw Error('Unexpected activity graphic width.');
  const measure = (value, font, size) => [...value].reduce((x, char) => {
    const advance = glyphs.get(`${font}-${char.codePointAt(0)}`);
    if (advance === undefined) throw Error(`Missing embedded glyph: ${char}`);
    return x + advance * size / 100;
  }, 0);
  const lettering = (value, font, size, x, y, color) => {
    let result = `<g fill="${color}">`;
    for (const char of value) {
      const id = `${font}-${char.codePointAt(0)}`;
      result += `<use href="#${id}" transform="translate(${x.toFixed(3)} ${(y - size).toFixed(3)}) scale(${size / 100})"/>`;
      x += measure(char, font, size);
    }
    return result + '</g>';
  };
  const count = data.total.toLocaleString('en-US');
  let content = lettering(count, 'p', 46, 24, 126, '#DDA66B');
  content += lettering('contributions · past year', 'b', 25, 38 + measure(count, 'p', 46), 124, '#EBDAC7');
  const size = width === 640 ? 21 : 22;
  let line = '', y = 163;
  for (const part of data.breakdown.filter(p => p.percent > 0)) {
    const segment = `${part.percent}% ${part.label}`;
    const next = line ? line + ' · ' + segment : segment;
    if (line && measure(next, 'b', size) > width - 48) {
      content += lettering(line, 'b', size, 24, y, colors[0]); y += 30; line = segment;
    } else line = next;
  }
  if (line) content += lettering(line, 'b', size, 24, y, colors[0]);
  const barY = y + 20;
  if (data.breakdown.length) {
    content += `<rect x="24" y="${barY}" width="${width - 48}" height="15" fill="#161426" stroke="#80718E"/>`;
    let x = 28;
    for (const [i, part] of data.breakdown.entries()) {
      const w = (width - 56) * part.percent / 100;
      content += `<rect x="${x.toFixed(3)}" y="${barY + 4}" width="${w.toFixed(3)}" height="7" fill="${colors[i]}"/>`; x += w;
    }
  }
  const height = barY + 35;
  return template.replace(/<!-- activity:start -->[\s\S]*?<!-- activity:end -->/, `<!-- activity:start -->${content}<!-- activity:end -->`)
    .replace(/<title>[\s\S]*?<\/title>/, `<title>GitHub: ${data.total} contributions in the past year</title>`)
    .replace(/<svg\b[^>]*>/, tag => tag.replace(/\bheight="[^"]+"/, `height="${height}"`).replace(/\bviewBox="[^"]+"/, `viewBox="0 0 ${width} ${height}"`));
}

export async function checkAssets() {
  const readme = await readFile(root + 'README.md', 'utf8');
  for (const match of readme.matchAll(/(?:src|srcset|href)="(assets\/[^"#]+)"/g)) await readFile(root + match[1]);
  for (const file of files) {
    const svg = await readFile(root + file, 'utf8');
    if (/Updated|\d{4}-\d{2}-\d{2}|<script\b|<text\b|<foreignObject\b/.test(svg)) throw Error(`Unexpected content in ${file}`);
    renderActivity(svg, { total: 0, breakdown: [] });
  }
}

export async function refresh() {
  let response;
  if (process.env.GITHUB_TOKEN) {
    const r = await fetch('https://api.github.com/graphql', { method: 'POST', headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw Error(`GitHub returned ${r.status}; keeping the existing graphics.`);
    response = await r.json();
  } else response = JSON.parse(execFileSync('gh', ['api', 'graphql', '-f', `query=${query}`], { encoding: 'utf8', timeout: 30000, windowsHide: true }));
  if (response.errors) throw Error('GitHub rejected the activity query; keeping the existing graphics.');
  const data = normalize(response.data?.user?.contributionsCollection);
  const updates = await Promise.all(files.map(async file => [file, renderActivity(await readFile(root + file, 'utf8'), data)]));
  for (const [file, svg] of updates) await writeFile(root + file, svg);
  await checkAssets();
  console.log(`Refreshed ${data.total} contributions.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) { await checkAssets(); console.log('Profile assets verified.'); }
  else await refresh();
}
