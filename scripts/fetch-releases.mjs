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

// NuGet registration index can be "inline" (small package) or "paged"
// (large package, items split across catalog pages fetched via @id).
async function fetchNugetVersions(nugetId) {
  const id = nugetId.toLowerCase();
  const url = `https://api.nuget.org/v3/registration5-semver1/${id}/index.json`;
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
      });
    }
  }
  return entries;
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
  for (const pkg of packages) {
    const releases = await buildReleases(pkg);
    all.push(...releases);
  }

  all.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  const outJson = path.join(ROOT, "docs", "releases.json");
  await writeFile(outJson, JSON.stringify(all, null, 2) + "\n", "utf8");
  console.log(`Wrote ${all.length} releases to ${outJson}`);

  const outXml = path.join(ROOT, "docs", "feed.xml");
  await writeFile(outXml, buildFeedXml(all), "utf8");
  console.log(`Wrote feed to ${outXml}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
