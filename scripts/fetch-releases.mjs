// Fetches NuGet version history + GitHub release notes for each package
// listed in data/packages.json, merges them, and writes docs/releases.json
// and docs/feed.xml. Run via `node scripts/fetch-releases.mjs`.
//
// Env:
//   GH_TOKEN - GitHub token with read access to the configured repos
//              (required for private repos, optional for public-only).

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const GH_TOKEN = process.env.GH_TOKEN || process.env.RELEASES_GH_TOKEN || "";

async function readPackages() {
  const raw = await readFile(path.join(ROOT, "data", "packages.json"), "utf8");
  return JSON.parse(raw);
}

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} fetching ${url}`);
  }
  return res.json();
}

// A package may have shipped under more than one NuGet ID over its
// lifetime (e.g. renamed/rebranded packages). `nugetId` is the current
// (primary) ID used for display/URLs; `aliasNugetIds` lists any prior IDs
// whose version history and download counts should still be counted.
function allNugetIds(pkg) {
  return [pkg.nugetId, ...(pkg.aliasNugetIds ?? [])];
}

// NuGet registration index can be "inline" (small package) or "paged"
// (large package, items split across catalog pages fetched via @id).
async function fetchNugetVersionsForId(nugetId) {
  const id = nugetId.toLowerCase();
  // registration5-semver1 is the legacy endpoint and 404s ("BlobNotFound")
  // for some packages that are only indexed under semver2 (NuGet's own
  // service index lists registration5-gz-semver2 as the current default).
  const url = `https://api.nuget.org/v3/registration5-gz-semver2/${id}/index.json`;
  let index;
  try {
    index = await fetchJson(url);
  } catch (err) {
    console.warn(`  NuGet fetch failed for ${nugetId}: ${err.message}`);
    return [];
  }

  const entries = [];
  for (const page of index.items ?? []) {
    const items = page.items ?? (await fetchJson(page["@id"])).items ?? [];
    for (const item of items) {
      const catalogEntry = item.catalogEntry;
      if (!catalogEntry || catalogEntry.listed === false) continue;
      entries.push({
        version: catalogEntry.version,
        published: catalogEntry.published,
        nugetUrl: `https://www.nuget.org/packages/${nugetId}/${catalogEntry.version}`,
        dependencies: flattenDependencies(catalogEntry.dependencyGroups),
      });
    }
  }
  return entries;
}

// Fetches version history across all NuGet IDs a package has used, merged
// into a single list (order doesn't matter - buildReleases re-sorts/keys
// by version).
async function fetchNugetVersions(pkg) {
  const results = await Promise.all(allNugetIds(pkg).map(fetchNugetVersionsForId));
  return results.flat();
}

// NuGet's registration payload already includes each version's dependency
// groups (one per target framework) inline in catalogEntry - no extra API
// call needed. Flatten to a de-duped {id, range} list across frameworks.
function flattenDependencies(dependencyGroups) {
  const byId = new Map();
  for (const group of dependencyGroups ?? []) {
    for (const dep of group.dependencies ?? []) {
      if (!dep.id || byId.has(dep.id.toLowerCase())) continue;
      byId.set(dep.id.toLowerCase(), { id: dep.id, range: dep.range });
    }
  }
  return [...byId.values()];
}

// NuGet's search API (unlike the registration API) exposes download
// counts: a package-level total plus a per-version breakdown. Both are
// cumulative-to-date, not a live install count.
async function fetchNugetDownloadsForId(nugetId) {
  const url = `https://azuresearch-usnc.nuget.org/query?q=packageid:${encodeURIComponent(nugetId)}&prerelease=true`;
  try {
    const result = await fetchJson(url);
    const entry = result.data?.find((d) => d.id.toLowerCase() === nugetId.toLowerCase()) ?? result.data?.[0];
    if (!entry) return null;
    return {
      totalDownloads: entry.totalDownloads ?? 0,
      versions: (entry.versions ?? []).map((v) => ({ version: v.version, downloads: v.downloads ?? 0 })),
    };
  } catch (err) {
    console.warn(`  NuGet downloads fetch failed for ${nugetId}: ${err.message}`);
    return null;
  }
}

// Sums download counts across all NuGet IDs a package has used. Per-version
// counts are merged by version string (summed, in case the same version
// number was ever published under both an old and new ID).
async function fetchNugetDownloads(pkg) {
  const results = await Promise.all(allNugetIds(pkg).map(fetchNugetDownloadsForId));
  const present = results.filter(Boolean);
  if (present.length === 0) return null;

  let totalDownloads = 0;
  const versionsByKey = new Map();
  for (const r of present) {
    totalDownloads += r.totalDownloads;
    for (const v of r.versions) {
      versionsByKey.set(v.version, (versionsByKey.get(v.version) ?? 0) + v.downloads);
    }
  }
  return {
    totalDownloads,
    versions: [...versionsByKey.entries()].map(([version, downloads]) => ({ version, downloads })),
  };
}

async function fetchGithubReleases(repo) {
  const headers = { Accept: "application/vnd.github+json" };
  if (GH_TOKEN) headers.Authorization = `Bearer ${GH_TOKEN}`;

  try {
    const releases = await fetchJson(
      `https://api.github.com/repos/${repo}/releases?per_page=100`,
      headers
    );
    return releases.map((r) => ({
      tag: r.tag_name,
      name: r.name,
      body: r.body,
      publishedAt: r.published_at,
      htmlUrl: r.html_url,
      prerelease: r.prerelease,
    }));
  } catch (err) {
    console.warn(`  GitHub releases fetch failed for ${repo}: ${err.message}`);
    return [];
  }
}

// GitHub tags are commonly "v1.2.3", "1.2.3", or "{package}-1.2.3".
// Normalize to bare semver for matching against NuGet versions.
function normalizeVersion(tag) {
  const match = tag.match(/(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/);
  return match ? match[1] : tag;
}

async function buildReleases(pkg) {
  console.log(`Fetching ${pkg.nugetId} / ${pkg.githubRepo}...`);
  const [nugetVersions, githubReleases] = await Promise.all([
    fetchNugetVersions(pkg),
    fetchGithubReleases(pkg.githubRepo),
  ]);

  const releasesByVersion = new Map();
  for (const gh of githubReleases) {
    releasesByVersion.set(normalizeVersion(gh.tag), gh);
  }

  return nugetVersions.map((nv) => {
    const gh = releasesByVersion.get(nv.version);
    return {
      package: pkg.nugetId,
      title: pkg.title || pkg.nugetId,
      category: pkg.category || "",
      repo: pkg.githubRepo,
      version: nv.version,
      publishedAt: gh?.publishedAt ?? nv.published,
      nugetUrl: nv.nugetUrl,
      githubUrl: gh?.htmlUrl ?? `https://github.com/${pkg.githubRepo}/releases`,
      notes: gh?.body ?? null,
      prerelease: gh?.prerelease ?? nv.version.includes("-"),
      dependencies: nv.dependencies,
    };
  });
}

function majorOf(version) {
  return parseInt(version.split(".")[0], 10) || 0;
}

// Compares two semver-ish version strings, matching docs/common.js's rules.
function compareVersions(a, b) {
  const [aMain, aPre] = a.split("-");
  const [bMain, bPre] = b.split("-");
  const aParts = aMain.split(".").map(Number);
  const bParts = bMain.split(".").map(Number);

  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const diff = (aParts[i] || 0) - (bParts[i] || 0);
    if (diff !== 0) return diff;
  }
  if (aPre && !bPre) return -1;
  if (!aPre && bPre) return 1;
  if (aPre && bPre) return aPre.localeCompare(bPre);
  return 0;
}

// NuGet dependency ranges look like "[17.6.1, )", "[18.1.0]", or a bare
// "1.0.0" (meaning >= 1.0.0). Extract the lower-bound version.
function parseLowerBound(range) {
  if (!range) return null;
  const bracket = range.trim().match(/^[\[(]\s*([^,\])]*)/);
  const v = bracket ? bracket[1].trim() : range.trim();
  return v || null;
}

function findNearestVersion(releases, target) {
  if (!releases || releases.length === 0) return null;
  const sorted = [...releases].sort((a, b) => compareVersions(a.version, b.version));
  let best = null;
  for (const r of sorted) {
    if (compareVersions(r.version, target) <= 0) best = r;
  }
  return best ?? sorted[0];
}

// Determines the Umbraco major version each release actually targets.
// Package majors don't always track Umbraco's own numbering (e.g.
// uSync.Hangfire is versioned independently) - but the release's NuGet
// dependencies do reveal compatibility:
//   1. A direct dependency on an Umbraco.Cms.* package - use its version.
//   2. A dependency on another package we track (e.g. uSync.Complete ->
//      uSync) - resolve through that package's own release, recursively.
//   3. Otherwise, fall back to the release's own version major (the
//      existing behaviour, correct for packages like uSync that already
//      version themselves to match Umbraco).
function resolveUmbracoMajors(releases, packages) {
  const trackedIds = new Set(packages.map((p) => p.nugetId.toLowerCase()));
  const byPackageVersion = new Map();
  const byPackage = new Map();
  for (const r of releases) {
    const pkgKey = r.package.toLowerCase();
    byPackageVersion.set(`${pkgKey}@${r.version}`, r);
    if (!byPackage.has(pkgKey)) byPackage.set(pkgKey, []);
    byPackage.get(pkgKey).push(r);
  }

  const memo = new Map();

  function resolve(release, depth) {
    const key = `${release.package.toLowerCase()}@${release.version}`;
    if (memo.has(key)) return memo.get(key);
    const selfMajor = majorOf(release.version);
    if (depth > 6) return selfMajor;
    memo.set(key, selfMajor); // tentative, guards against dependency cycles

    let result = selfMajor;
    const deps = release.dependencies ?? [];
    const umbracoDep = deps.find((d) => /^umbraco\.cms/i.test(d.id));
    if (umbracoDep) {
      const lower = parseLowerBound(umbracoDep.range);
      if (lower) result = majorOf(lower);
    } else {
      const hopDep = deps.find(
        (d) => trackedIds.has(d.id.toLowerCase()) && d.id.toLowerCase() !== release.package.toLowerCase()
      );
      if (hopDep) {
        const lower = parseLowerBound(hopDep.range);
        if (lower) {
          const targetKey = `${hopDep.id.toLowerCase()}@${lower}`;
          const target =
            byPackageVersion.get(targetKey) ??
            findNearestVersion(byPackage.get(hopDep.id.toLowerCase()), lower);
          if (target) result = resolve(target, depth + 1);
        }
      }
    }

    memo.set(key, result);
    return result;
  }

  for (const r of releases) {
    r.umbracoMajor = resolve(r, 0);
    delete r.dependencies;
  }
}

function toRssItem(release) {
  const title = `${release.title} ${release.version}`;
  const link = release.githubUrl || release.nugetUrl;
  const pubDate = new Date(release.publishedAt).toUTCString();
  const description = (release.notes || "").replace(/]]>/g, "]]]]><![CDATA[>");
  return `    <item>
      <title>${escapeXml(title)}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="true">${escapeXml(link)}</guid>
      <pubDate>${pubDate}</pubDate>
      <description><![CDATA[${description}]]></description>
    </item>`;
}

function escapeXml(str) {
  return String(str).replace(/[<>&'"]/g, (c) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    '"': "&quot;",
  }[c]));
}

function buildFeedXml(releases) {
  const items = releases.slice(0, 50).map(toRssItem).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Jumoo Releases</title>
    <link>https://releases.jumoo.co.uk/</link>
    <description>Latest NuGet package releases from Jumoo</description>
${items}
  </channel>
</rss>
`;
}

async function buildDownloads(packages) {
  const packagesOut = [];
  for (const pkg of packages) {
    const downloads = await fetchNugetDownloads(pkg);
    if (!downloads) continue;
    packagesOut.push({
      package: pkg.nugetId,
      title: pkg.title || pkg.nugetId,
      totalDownloads: downloads.totalDownloads,
      versions: downloads.versions,
    });
  }
  return packagesOut;
}

// Appends one row per package to the history log, but only once per UTC
// day (the workflow runs every 6h; we don't want 4x redundant rows/day).
async function updateDownloadsHistory(packagesDownloads) {
  const historyPath = path.join(ROOT, "docs", "downloads-history.json");
  let history = [];
  try {
    history = JSON.parse(await readFile(historyPath, "utf8"));
  } catch {
    // No history file yet - start fresh.
  }

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const alreadyLogged = history.some((row) => row.date === today);
  if (alreadyLogged) {
    console.log(`Downloads history already has an entry for ${today}, skipping.`);
    return history;
  }

  for (const pkg of packagesDownloads) {
    history.push({ date: today, package: pkg.package, totalDownloads: pkg.totalDownloads });
  }
  await writeFile(historyPath, JSON.stringify(history, null, 2) + "\n", "utf8");
  console.log(`Appended ${packagesDownloads.length} rows to ${historyPath} for ${today}`);
  return history;
}

async function main() {
  const packages = await readPackages();
  const all = [];
  for (const pkg of packages) {
    const releases = await buildReleases(pkg);
    all.push(...releases);
  }

  resolveUmbracoMajors(all, packages);
  all.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  const outJson = path.join(ROOT, "docs", "releases.json");
  await writeFile(outJson, JSON.stringify(all, null, 2) + "\n", "utf8");
  console.log(`Wrote ${all.length} releases to ${outJson}`);

  const outXml = path.join(ROOT, "docs", "feed.xml");
  await writeFile(outXml, buildFeedXml(all), "utf8");
  console.log(`Wrote feed to ${outXml}`);

  const downloads = await buildDownloads(packages);
  const outDownloads = path.join(ROOT, "docs", "downloads.json");
  await writeFile(
    outDownloads,
    JSON.stringify({ generatedAt: new Date().toISOString(), packages: downloads }, null, 2) + "\n",
    "utf8"
  );
  console.log(`Wrote downloads for ${downloads.length} packages to ${outDownloads}`);

  await updateDownloadsHistory(downloads);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
