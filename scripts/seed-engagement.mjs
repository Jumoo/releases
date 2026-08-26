// One-off historical seed for docs/engagement.json (issues/PRs/commits per
// package per month). Paginates each repo's full issue+PR history and the
// last 52 weeks of commit activity, and writes a monthly-bucketed summary
// plus a `syncedThrough` cursor that scripts/fetch-engagement.mjs uses for
// cheap incremental updates afterwards.
//
// Run once, manually: node scripts/seed-engagement.mjs
//
// Env:
//   GH_TOKEN - GitHub token with read access to the configured repos.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const GH_TOKEN = process.env.GH_TOKEN || process.env.RELEASES_GH_TOKEN || "";

if (!GH_TOKEN) {
  console.error("GH_TOKEN (or RELEASES_GH_TOKEN) is required - unauthenticated rate limits are too low for a full history seed.");
  process.exit(1);
}

function githubHeaders() {
  return { Accept: "application/vnd.github+json", Authorization: `Bearer ${GH_TOKEN}` };
}

async function readPackages() {
  const raw = await readFile(path.join(ROOT, "data", "packages.json"), "utf8");
  return JSON.parse(raw);
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: githubHeaders() });
  const remaining = res.headers.get("x-ratelimit-remaining");
  if (remaining && Number(remaining) < 20) {
    const resetAt = Number(res.headers.get("x-ratelimit-reset")) * 1000;
    const waitMs = Math.max(0, resetAt - Date.now()) + 1000;
    console.warn(`  Rate limit low (${remaining} left) - waiting ${Math.round(waitMs / 1000)}s for reset...`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} fetching ${url}`);
  }
  return { json: await res.json(), res };
}

function monthKey(iso) {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function emptyBucket() {
  return { issuesOpened: 0, issuesClosed: 0, prsOpened: 0, prsMerged: 0, commits: 0 };
}

// Paginates GET /repos/{repo}/issues?state=all, which returns both issues
// and PRs (a PR has a `pull_request` key). Buckets each into the month it
// was opened, and separately the month it was closed/merged - an issue
// opened in June and closed in July contributes to both months.
async function fetchIssuesAndPrs(repo, buckets) {
  let page = 1;
  let latestUpdatedAt = null;

  for (;;) {
    const url = `https://api.github.com/repos/${repo}/issues?state=all&per_page=100&page=${page}&sort=updated&direction=asc`;
    const { json: items } = await fetchJson(url);
    if (items.length === 0) break;

    for (const item of items) {
      const isPr = Boolean(item.pull_request);
      const openedMonth = monthKey(item.created_at);
      buckets.get(openedMonth)[isPr ? "prsOpened" : "issuesOpened"]++;

      if (isPr && item.pull_request.merged_at) {
        buckets.get(monthKey(item.pull_request.merged_at)).prsMerged++;
      } else if (!isPr && item.closed_at) {
        buckets.get(monthKey(item.closed_at)).issuesClosed++;
      }

      if (!latestUpdatedAt || item.updated_at > latestUpdatedAt) latestUpdatedAt = item.updated_at;
    }

    if (items.length < 100) break;
    page++;
  }

  return latestUpdatedAt;
}

// Weekly commit counts for the last 52 weeks - GitHub computes this
// server-side and can return 202 (still generating) on a cold cache, so
// retry a few times.
async function fetchCommitActivity(repo, buckets) {
  const url = `https://api.github.com/repos/${repo}/stats/commit_activity`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const { json: weeks, res } = await fetchJson(url);
    if (res.status === 202) {
      console.log(`  Commit stats warming up for ${repo}, retrying in 3s...`);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    for (const week of weeks ?? []) {
      const month = monthKey(new Date(week.week * 1000).toISOString());
      if (buckets.has(month)) buckets.get(month).commits += week.total;
    }
    return;
  }
  console.warn(`  Gave up waiting on commit stats for ${repo}`);
}

// Ensures a contiguous run of month buckets exists between the earliest
// and latest months touched, so a quiet month shows as zero rather than
// being absent from the chart.
function fillGaps(buckets) {
  const keys = [...buckets.keys()].sort();
  if (keys.length === 0) return;
  const [startY, startM] = keys[0].split("-").map(Number);
  const [endY, endM] = keys.at(-1).split("-").map(Number);
  let y = startY, m = startM;
  while (y < endY || (y === endY && m <= endM)) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    if (!buckets.has(key)) buckets.set(key, emptyBucket());
    m++;
    if (m > 12) { m = 1; y++; }
  }
}

async function seedPackage(pkg) {
  console.log(`Seeding ${pkg.nugetId} / ${pkg.githubRepo}...`);
  const buckets = new Map();
  const get = (month) => {
    if (!buckets.has(month)) buckets.set(month, emptyBucket());
    return buckets.get(month);
  };
  // Proxy so callers can do buckets.get(month) without pre-creating it.
  const bucketsProxy = { get, has: () => true };

  const latestUpdatedAt = await fetchIssuesAndPrs(pkg.githubRepo, bucketsProxy);
  await fetchCommitActivity(pkg.githubRepo, bucketsProxy);
  fillGaps(buckets);

  return {
    package: pkg.nugetId,
    syncedThrough: latestUpdatedAt ?? new Date(0).toISOString(),
    months: [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, counts]) => ({ month, ...counts })),
  };
}

async function main() {
  const packages = await readPackages();
  const out = [];
  for (const pkg of packages) {
    try {
      out.push(await seedPackage(pkg));
    } catch (err) {
      console.warn(`  Failed to seed ${pkg.githubRepo}: ${err.message}`);
    }
  }

  const outPath = path.join(ROOT, "docs", "engagement.json");
  await writeFile(
    outPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), packages: out }, null, 2) + "\n",
    "utf8"
  );
  console.log(`Wrote engagement history for ${out.length} packages to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
