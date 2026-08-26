// Shared helpers used by both the homepage (app.js) and the
// per-package page (package.js).

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

// Minimal, safe markdown -> HTML for GitHub release notes.
// Handles headings, bold/italic, inline code, links, and lists —
// enough for typical release-note formatting without pulling in a library.
function renderMarkdown(md) {
  const escaped = escapeHtml(md);
  const lines = escaped.split("\n");
  const html = [];
  let inList = false;

  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.*)/);
    const listItem = line.match(/^[-*]\s+(.*)/);

    if (listItem) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${inlineMarkdown(listItem[1])}</li>`);
      continue;
    }
    if (inList) {
      html.push("</ul>");
      inList = false;
    }

    if (heading) {
      const level = Math.min(heading[1].length + 2, 6); // demote to h3+
      html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
    } else if (line.trim() === "") {
      html.push("");
    } else {
      html.push(`<p>${inlineMarkdown(line)}</p>`);
    }
  }
  if (inList) html.push("</ul>");
  return html.join("\n");
}

function inlineMarkdown(text) {
  return text
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function releaseAnchorId(version) {
  return `v${version}`;
}

function renderVersionChip(release, supported) {
  const el = document.createElement("a");
  el.className = "version-chip";
  if (!supported) el.className += " version-chip-eol";
  else if (release.prerelease) el.className += " version-chip-pre";
  el.href = `package.html?name=${encodeURIComponent(release.package)}#${releaseAnchorId(release.version)}`;
  el.title = `${release.version} — ${formatDate(release.publishedAt)}${supported ? "" : " (end of life)"}`;
  el.textContent = `v${release.version}`;
  return el;
}

function renderRelease(r) {
  const el = document.createElement("article");
  el.className = "release";
  el.id = releaseAnchorId(r.version);

  const prereleaseBadge = r.prerelease ? '<span class="badge">pre-release</span>' : "";

  el.innerHTML = `
    <div class="release-header">
      <span class="release-title">${escapeHtml(r.title || r.package)} v${escapeHtml(r.version)}${prereleaseBadge}</span>
      <span class="release-date">${formatDate(r.publishedAt)}</span>
    </div>
    <div class="release-links">
      <a href="${escapeHtml(r.githubUrl)}" target="_blank" rel="noopener">GitHub release</a>
      <a href="${escapeHtml(r.nugetUrl)}" target="_blank" rel="noopener">NuGet</a>
      <a href="https://github.com/${escapeHtml(r.repo)}" target="_blank" rel="noopener">Repo</a>
    </div>
    ${r.notes ? `<div class="release-notes">${renderMarkdown(r.notes)}</div>` : ""}
  `;
  return el;
}

async function fetchReleases() {
  const res = await fetch("releases.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

// Compares two semver-ish version strings ("18.1.0", "17.1.0-rc1").
// Returns >0 if a > b, <0 if a < b, 0 if equal. A prerelease always
// sorts below the same numeric version without one.
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

// Groups a flat, already-sorted (newest first) release list by package,
// returning one entry per package with its full release history and
// the latest release singled out. "Latest" is the highest version
// number, not simply the most recently published release — packages
// can publish an older maintenance branch after a newer major version.
function groupByPackage(releases) {
  const groups = new Map();
  for (const r of releases) {
    if (!groups.has(r.package)) {
      groups.set(r.package, {
        package: r.package,
        title: r.title || r.package,
        category: r.category || "",
        repo: r.repo,
        releases: [],
      });
    }
    groups.get(r.package).releases.push(r);
  }
  return [...groups.values()]
    .map((g) => ({
      ...g,
      latest: g.releases.reduce((best, r) =>
        compareVersions(r.version, best.version) > 0 ? r : best
      ),
    }))
    .sort((a, b) => new Date(b.latest.publishedAt) - new Date(a.latest.publishedAt));
}

// Extracts the major version number from a version string ("18.1.0" -> 18).
function majorOf(version) {
  return parseInt(version.split(".")[0], 10) || 0;
}

// The Umbraco major a release actually targets. Most packages version
// themselves to match Umbraco directly, but some (e.g. uSync.Hangfire)
// don't - for those, fetch-releases.mjs resolves the real Umbraco major
// from NuGet dependency data and stores it as `umbracoMajor`. Fall back
// to the release's own version major for data fetched before that existed.
function effectiveMajor(release) {
  return release.umbracoMajor ?? majorOf(release.version);
}

// Given one package's release list, returns the highest-versioned release
// for each (Umbraco-compatible) major version, sorted ascending by major
// (e.g. v13.4, v14.5, v16.5 for a package that skipped a major).
function highestPerMajor(releases) {
  const byMajor = new Map();
  for (const r of releases) {
    const m = effectiveMajor(r);
    const current = byMajor.get(m);
    if (!current || compareVersions(r.version, current.version) > 0) {
      byMajor.set(m, r);
    }
  }
  return [...byMajor.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, r]) => r);
}

async function fetchEol() {
  try {
    const res = await fetch("eol.json", { cache: "no-store" });
    if (!res.ok) return {};
    return res.json();
  } catch {
    return {};
  }
}

// Returns { details, body }: `details` is the collapsible <details> element
// to append to the page, `body` is where callers should append their
// section's content. `open` controls whether it starts expanded.
function section(title, subtitle, open) {
  const details = document.createElement("details");
  details.className = "stats-section";
  details.open = Boolean(open);

  const summary = document.createElement("summary");
  summary.className = "stats-section-title";
  summary.textContent = title;
  details.appendChild(summary);

  const body = document.createElement("div");
  body.className = "stats-section-body";
  details.appendChild(body);

  if (subtitle) {
    const p = document.createElement("p");
    p.className = "stats-section-subtitle";
    p.textContent = subtitle;
    body.appendChild(p);
  }

  return { details, body };
}

// Optional, hand-maintained list of categories in display order (see
// docs/categories.json). Categories not listed fall back to the default
// most-recently-released-first order, after all listed categories.

async function fetchCategoryOrder() {
  try {
    const res = await fetch("categories.json", { cache: "no-store" });
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

// A major version is supported unless eol.json has an entry for it with
// an "eol" date that has already passed. Majors with no entry (or a null
// eol) are treated as supported.
function isMajorSupported(major, eol) {
  const entry = eol[String(major)];
  if (!entry || !entry.eol) return true;
  return new Date(entry.eol).getTime() >= Date.now();
}

// Buckets package groups (from groupByPackage) by category. Order is:
// 1. the uncategorized bucket (empty category) always first, no heading;
// 2. categories listed in `order` (see fetchCategoryOrder), in that order;
// 3. any remaining categories, sorted by their most recently released
//    package (the pre-existing default when no order is configured).
function groupByCategory(packageGroups, order = []) {
  const categories = new Map();
  for (const g of packageGroups) {
    if (!categories.has(g.category)) {
      categories.set(g.category, { category: g.category, packages: [] });
    }
    categories.get(g.category).packages.push(g);
  }
  const rank = (category) => {
    const i = order.indexOf(category);
    return i === -1 ? order.length : i;
  };
  return [...categories.values()].sort((a, b) => {
    if (a.category === "" && b.category !== "") return -1;
    if (b.category === "" && a.category !== "") return 1;
    const rankDiff = rank(a.category) - rank(b.category);
    if (rankDiff !== 0) return rankDiff;
    return new Date(b.packages[0].latest.publishedAt) - new Date(a.packages[0].latest.publishedAt);
  });
}
