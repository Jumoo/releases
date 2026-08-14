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

// Extracts the major version number from a version string ("13.0.0-rc1" -> 13).
function extractMajor(version) {
  const m = /^(\d+)\./.exec(version.trim());
  return m ? Number(m[1]) : null;
}

// Parses a NuGet dependency version range into { minMajor, maxExclusiveMajor }.
// maxExclusiveMajor is null when the range has no stated upper bound - callers
// must NOT treat that as "compatible with every later major too" (Jumoo
// packages are almost always rewritten per Umbraco major; an open lower
// bound just means "this version was published against Umbraco N").
// Handles: "13.0.0" (bare, open-ended), "[13.0.0, 14.0.0)" (bounded),
// "[13.0.0,)" (bounded below only), "[13.0.0]" (exact pin).
function parseUmbracoRange(range) {
  if (!range) return null;
  const trimmed = range.trim();

  const bracketed = trimmed.match(/^[\[(]([^,\])]*)(,([^\])]*))?[\])]$/);
  if (bracketed) {
    const [, lowRaw, hasComma, highRaw] = bracketed;
    const minMajor = extractMajor(lowRaw || "");
    if (minMajor == null) return null;
    if (!hasComma) {
      // Exact pin, e.g. "[13.0.0]" - only that one major.
      return { minMajor, maxExclusiveMajor: minMajor + 1 };
    }
    const high = (highRaw || "").trim();
    if (!high) return { minMajor, maxExclusiveMajor: null };
    const highMajor = extractMajor(high);
    if (highMajor == null) return { minMajor, maxExclusiveMajor: null };
    const closeExclusive = trimmed.endsWith(")");
    return { minMajor, maxExclusiveMajor: closeExclusive ? highMajor : highMajor + 1 };
  }

  // Bare version, e.g. "13.0.0" -> minimum inclusive, no stated upper bound.
  const minMajor = extractMajor(trimmed);
  return minMajor == null ? null : { minMajor, maxExclusiveMajor: null };
}

// Finds the Umbraco.Cms.* dependency range declared directly within one
// dependency group (Jumoo packages depend on one of Umbraco.Cms.Core/
// Web.Common/etc, which are released in lockstep, so the first match within
// the group is sufficient). A single package version can multi-target
// several TFMs, each pinned to a *different* Umbraco major (e.g. a net472
// build against Umbraco 10 alongside a net8.0 build against Umbraco 16) -
// callers must check every group, not just the first, to catch all of them.
function directUmbracoRangeInGroup(group) {
  for (const dep of group.dependencies ?? []) {
    if (/^Umbraco\.Cms/i.test(dep.id ?? "")) {
      const parsed = parseUmbracoRange(dep.range);
      if (parsed) return parsed;
    }
  }
  return null;
}

// Extracts the lower-bound version string from a NuGet range, for looking
// up the matching version of a dependency package ("[18.1.0, )" -> "18.1.0").
function rangeMinVersion(range) {
  if (!range) return null;
  const trimmed = range.trim();
  const bracketed = trimmed.match(/^[\[(]([^,\])]*)/);
  const low = bracketed ? bracketed[1].trim() : trimmed;
  return low || null;
}

// The Umbraco majors a single range covers, per parseUmbracoRange's rule:
// an open-ended range covers only its minimum major, never an inferred set
// of future majors.
function majorsForRange(range) {
  if (!range || range.minMajor == null) return [];
  if (range.maxExclusiveMajor == null) return [range.minMajor];
  const majors = [];
  for (let m = range.minMajor; m < range.maxExclusiveMajor; m++) majors.push(m);
  return majors;
}

// The union of Umbraco majors covered by a set of ranges (one version can
// multi-target several majors at once - see directUmbracoRangeInGroup).
function majorsForRanges(ranges) {
  const majors = new Set();
  for (const range of ranges ?? []) {
    for (const major of majorsForRange(range)) majors.add(major);
  }
  return [...majors];
}

// Registration index -> Map<version, catalogEntry> for a NuGet package.
// Cached per package ID since the same "engine" package (e.g. uSync.BackOffice)
// is depended on by many wrapper packages.
const catalogEntryCache = new Map();

// NuGet registration index can be "inline" (small package) or "paged"
// (large package, items split across catalog pages fetched via @id).
async function fetchCatalogEntries(nugetId) {
  const key = nugetId.toLowerCase();
  if (catalogEntryCache.has(key)) return catalogEntryCache.get(key);

  const promise = (async () => {
    // registration5-semver1 is the legacy endpoint and 404s ("BlobNotFound")
    // for some packages that are only indexed under semver2 (NuGet's own
    // service index lists registration5-gz-semver2 as the current default).
    const url = `https://api.nuget.org/v3/registration5-gz-semver2/${key}/index.json`;
    let index;
    try {
      index = await fetchJson(url);
    } catch (err) {
      console.warn(`  NuGet fetch failed for ${nugetId}: ${err.message}`);
      return new Map();
    }

    const map = new Map();
    for (const page of index.items ?? []) {
      const items = page.items ?? (await fetchJson(page["@id"])).items ?? [];
      for (const item of items) {
        const catalogEntry = item.catalogEntry;
        if (!catalogEntry || catalogEntry.listed === false) continue;
        map.set(catalogEntry.version, catalogEntry);
      }
    }
    return map;
  })();

  catalogEntryCache.set(key, promise);
  return promise;
}

// Many Jumoo packages are thin meta-packages that only reference their real
// "engine" package (e.g. uSync -> uSync.BackOffice, Jumoo.TranslationManager
// -> Jumoo.TranslationManager.Base), which is where the actual Umbraco.Cms.*
// dependency is declared. Resolves every Umbraco range a package version
// covers by checking each of its dependency groups directly, then following
// any group without a direct Umbraco dependency down its dependency tree
// (matching each dependency's declared minimum version) up to a bounded
// depth - returning one range per distinct group/branch that resolves to one,
// so a multi-targeted version pinned to several Umbraco majors at once
// (see directUmbracoRangeInGroup) reports all of them, not just the first.
async function resolveUmbracoRanges(nugetId, version, depth = 0, visited = new Set()) {
  if (depth > 4) return [];
  const key = `${nugetId.toLowerCase()}@${version}`;
  if (visited.has(key)) return [];
  visited.add(key);

  const entries = await fetchCatalogEntries(nugetId);
  const catalogEntry = entries.get(version);
  if (!catalogEntry) return [];

  const ranges = [];
  for (const group of catalogEntry.dependencyGroups ?? []) {
    const direct = directUmbracoRangeInGroup(group);
    if (direct) {
      ranges.push(direct);
      continue;
    }
    for (const dep of group.dependencies ?? []) {
      const depVersion = rangeMinVersion(dep.range);
      if (!dep.id || !depVersion) continue;
      ranges.push(...(await resolveUmbracoRanges(dep.id, depVersion, depth + 1, visited)));
    }
  }
  return ranges;
}

async function fetchNugetVersions(nugetId) {
  const entries = await fetchCatalogEntries(nugetId);
  const versions = [];
  for (const [version, catalogEntry] of entries) {
    versions.push({
      version,
      published: catalogEntry.published,
      nugetUrl: `https://www.nuget.org/packages/${nugetId}/${version}`,
      umbracoRanges: await resolveUmbracoRanges(nugetId, version),
    });
  }
  return versions;
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
    fetchNugetVersions(pkg.nugetId),
    fetchGithubReleases(pkg.githubRepo),
  ]);

  const releasesByVersion = new Map();
  for (const gh of githubReleases) {
    releasesByVersion.set(normalizeVersion(gh.tag), gh);
  }

  const releases = nugetVersions.map((nv) => {
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
    };
  });

  return { releases, nugetVersions };
}

// Compares two semver-ish version strings ("18.1.0", "17.1.0-rc1").
// Returns >0 if a > b, <0 if a < b, 0 if equal. A prerelease always
// sorts below the same numeric version without one. Mirrors
// docs/common.js's compareVersions (kept separate: this script runs in
// Node against plain JSON, the docs copy runs in the browser).
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

// Builds the compatibility matrix: for each package, the earliest version
// known to support each Umbraco major (per majorsForRange's rule - an
// open-ended dependency range covers only its minimum major, not an
// inferred set of future ones).
function buildCompatibility(packagesWithVersions) {
  return packagesWithVersions.map(({ pkg, nugetVersions }) => {
    const support = {};
    for (const nv of nugetVersions) {
      for (const major of majorsForRanges(nv.umbracoRanges)) {
        const current = support[major];
        if (!current || compareVersions(nv.version, current) < 0) {
          support[major] = nv.version;
        }
      }
    }
    return {
      package: pkg.nugetId,
      title: pkg.title || pkg.nugetId,
      category: pkg.category || "",
      repo: pkg.githubRepo,
      support,
    };
  });
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

async function main() {
  const packages = await readPackages();
  const all = [];
  const compatSource = [];
  for (const pkg of packages) {
    const { releases, nugetVersions } = await buildReleases(pkg);
    all.push(...releases);
    compatSource.push({ pkg, nugetVersions });
  }

  all.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  const outJson = path.join(ROOT, "docs", "releases.json");
  await writeFile(outJson, JSON.stringify(all, null, 2) + "\n", "utf8");
  console.log(`Wrote ${all.length} releases to ${outJson}`);

  const outXml = path.join(ROOT, "docs", "feed.xml");
  await writeFile(outXml, buildFeedXml(all), "utf8");
  console.log(`Wrote feed to ${outXml}`);

  const compatibility = buildCompatibility(compatSource);
  const outCompat = path.join(ROOT, "docs", "compatibility.json");
  await writeFile(outCompat, JSON.stringify(compatibility, null, 2) + "\n", "utf8");
  console.log(`Wrote compatibility matrix for ${compatibility.length} packages to ${outCompat}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
