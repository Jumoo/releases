// Incremental refresh for docs/engagement.json (issues/PRs/commits per
// package per month), run every 6h alongside scripts/fetch-releases.mjs.
//
// Unlike a naive "since last sync, add the delta" approach, this recomputes
// a full rolling window (trailing WINDOW_MONTHS) from scratch each run and
// *replaces* those months wholesale, leaving older, seeded months untouched.
// A pure delta-add would double-count: an issue opened 2 years ago that gets
// closed today shows up again in a `since`-filtered fetch (its `updated_at`
// changed), and naively adding its "opened" count a second time would be
// wrong. Recompute-and-replace sidesteps that - each event (opened/closed/
// merged) is only ever counted from its own month's window pass, and a
// window pass reflects the current state of the API, not an accumulation.
//
// Run via `node scripts/fetch-engagement.mjs`. Requires docs/engagement.json
// to already exist - run scripts/seed-engagement.mjs once first.
//
// Env:
//   GH_TOKEN - GitHub token with read access to the configured repos.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const GH_TOKEN = process.env.GH_TOKEN || process.env.RELEASES_GH_TOKEN || "";

// 12 months of display range plus a buffer month, so the chart's oldest
// visible month is never a partially-recomputed edge case.
const WINDOW_MONTHS = 13;

function githubHeaders() {
  const headers = { Accept: "application/vnd.github+json" };
  if (GH_TOKEN) headers.Authorization = `Bearer ${GH_TOKEN}`;
  return headers;
}

async function readPackages() {
  const raw = await readFile(path.join(ROOT, "data", "packages.json"), "utf8");
  return JSON.parse(raw);
}

async function readEngagement() {
  const enginePath = path.join(ROOT, "docs", "engagement.json");
  try {
    return JSON.parse(await readFile(enginePath, "utf8"));
  } catch {
    console.error(`docs/engagement.json not found - run scripts/seed-engagement.mjs once first.`);
    process.exit(1);
  }
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

function windowMonthKeys() {
  const now = new Date();
  const months = [];
  for (let i = WINDOW_MONTHS - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push(monthKey(d.toISOString()));
  }
  return months;
}

// Only items updated since the window's start are worth paging through -
// GitHub's `since` filters by `updated_at`, so this also naturally picks up
// old issues that were just closed/commented on.
async function fetchIssuesAndPrs(repo, windowStart, buckets) {
  let page = 1;
  for (;;) {
    const url = `https://api.github.com/repos/${repo}/issues?state=all&since=${windowStart}&per_page=100&page=${page}`;
    const { json: items } = await fetchJson(url);
    if (items.length === 0) break;

    for (const item of items) {
      const isPr = Boolean(item.pull_request);
      const openedMonth = monthKey(item.created_at);
      if (buckets.has(openedMonth)) buckets.get(openedMonth)[isPr ? "prsOpened" : "issuesOpened"]++;

      if (isPr && item.pull_request.merged_at) {
        const mergedMonth = monthKey(item.pull_request.merged_at);
        if (buckets.has(mergedMonth)) buckets.get(mergedMonth).prsMerged++;
      } else if (!isPr && item.closed_at) {
        const closedMonth = monthKey(item.closed_at);
        if (buckets.has(closedMonth)) buckets.get(closedMonth).issuesClosed++;
      }
    }

    if (items.length < 100) break;
    page++;
  }
}

// Weekly commit counts for the last 52 weeks - naturally covers (and
// exceeds) WINDOW_MONTHS, so this is always a full replace of the window's
// commit counts, never a partial one.
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

async function refreshPackage(pkg, months) {
  console.log(`Refreshing ${pkg.nugetId} / ${pkg.githubRepo}...`);
  const buckets = new Map(months.map((m) => [m, emptyBucket()]));
  const windowStart = `${months[0]}-01T00:00:00Z`;

  try {
    await fetchIssuesAndPrs(pkg.githubRepo, windowStart, buckets);
    await fetchCommitActivity(pkg.githubRepo, buckets);
  } catch (err) {
    console.warn(`  Failed to refresh ${pkg.githubRepo}: ${err.message}`);
    return null;
  }

  return buckets;
}

async function main() {
  const [packages, engagement] = await Promise.all([readPackages(), readEngagement()]);
  const months = windowMonthKeys();
  const byPackage = new Map(engagement.packages.map((p) => [p.package, p]));

  for (const pkg of packages) {
    const freshBuckets = await refreshPackage(pkg, months);
    if (!freshBuckets) continue;

    const existing = byPackage.get(pkg.nugetId);
    const olderMonths = (existing?.months ?? []).filter((m) => !months.includes(m.month));
    const refreshedMonths = months.map((month) => ({ month, ...freshBuckets.get(month) }));
    const merged = [...olderMonths, ...refreshedMonths].sort((a, b) => a.month.localeCompare(b.month));

    byPackage.set(pkg.nugetId, {
      package: pkg.nugetId,
      syncedThrough: new Date().toISOString(),
      months: merged,
    });
  }

  const outPath = path.join(ROOT, "docs", "engagement.json");
  await writeFile(
    outPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), packages: [...byPackage.values()] }, null, 2) + "\n",
    "utf8"
  );
  console.log(`Wrote refreshed engagement data for ${byPackage.size} packages to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
