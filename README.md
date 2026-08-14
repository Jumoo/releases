# Jumoo Releases

Static feed of releases across Jumoo's NuGet packages, combining NuGet version/publish data with GitHub release notes (including from private repos). Published via GitHub Pages at `releases.jumoo.co.uk`.

## How it works

- `data/packages.json` lists the tracked packages (NuGet package ID + GitHub repo).
- `scripts/fetch-releases.mjs` fetches version data from the NuGet API and release notes from the GitHub Releases API, merges them, and writes `docs/releases.json`, `docs/feed.xml`, and `docs/compatibility.json`.
- `docs/` is a plain static site (no build step) that fetches those JSON files and renders them. This is also the GitHub Pages publish directory.
- `.github/workflows/update-releases.yml` runs the fetch script every 6 hours (and on manual trigger), committing the regenerated JSON/feed if anything changed. Since Pages serves straight from `docs/` on `main`, the commit itself triggers a redeploy.

## Compatibility matrix

`docs/compatibility.html` shows, per package, the earliest version known to support each Umbraco major. The data comes from each NuGet version's declared `Umbraco.Cms.*` dependency range (read from the NuGet registration API's `catalogEntry.dependencyGroups`, no repo checkouts needed).

An **open-ended dependency range** (e.g. a bare `13.0.0`, meaning "13.0.0 or later") is deliberately **not** treated as "compatible with every later major too" — Jumoo packages are almost always rewritten per Umbraco major, so an open range is attributed only to the major it was actually published against. A version only shows as supporting multiple majors when its range explicitly states an upper bound spanning them (or, for the rare package that genuinely works across majors, e.g. a CLI tool, when it publishes separate dependency entries per major).

## Adding a package

Add an entry to `data/packages.json`:

```json
{
  "nugetId": "Jumoo.SomePackage",
  "title": "Some Package",
  "category": "Integrations",
  "githubRepo": "Jumoo/SomePackage"
}
```

- `nugetId` — the NuGet package ID (used to query the NuGet API and build package links).
- `title` — display name shown on the site; falls back to `nugetId` if omitted.
- `category` — groups packages into sections on the homepage (e.g. "uSync", "Integrations"); omit it to leave a package uncategorized — uncategorized packages are listed first, with no heading.
- `githubRepo` — `owner/repo` for the matching GitHub releases.

No code changes needed — the next scheduled run (or a manual `workflow_dispatch`) will pick it up.

## Private repos

Release notes for private repos are fetched using a GitHub token and shown publicly on the site (repo code itself stays private — only release metadata/notes are surfaced).

Setup:

1. Create a fine-grained GitHub PAT scoped to `Contents: read` on the private repos listed in `data/packages.json`.
2. Add it as a repository secret named `RELEASES_GH_TOKEN` (Settings → Secrets and variables → Actions).

## Local development

```bash
npm install

# Fetch latest release data (requires a GH token env var for private repos)
GH_TOKEN=ghp_xxx npm run fetch

# Serve the site locally at http://localhost:4173
npm run dev
```

## GitHub Pages setup

1. Repo Settings → Pages → Source: `main` branch, `/docs` folder.
2. `docs/CNAME` already contains `releases.jumoo.co.uk` — add a DNS `CNAME` record at your DNS provider pointing `releases.jumoo.co.uk` to the org's `github.io` Pages domain.
