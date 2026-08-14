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

function renderRelease(r) {
  const el = document.createElement("article");
  el.className = "release";

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

// Buckets package groups (from groupByPackage) by category, each bucket
// sorted by its most recently released package; categories sorted the
// same way, except the uncategorized bucket (empty category) always
// comes first and renders without a heading.
function groupByCategory(packageGroups) {
  const categories = new Map();
  for (const g of packageGroups) {
    if (!categories.has(g.category)) {
      categories.set(g.category, { category: g.category, packages: [] });
    }
    categories.get(g.category).packages.push(g);
  }
  return [...categories.values()].sort((a, b) => {
    if (a.category === "" && b.category !== "") return -1;
    if (b.category === "" && a.category !== "") return 1;
    return new Date(b.packages[0].latest.publishedAt) - new Date(a.packages[0].latest.publishedAt);
  });
}
