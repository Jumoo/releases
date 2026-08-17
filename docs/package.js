const feedEl = document.getElementById("feed");
const statusEl = document.getElementById("status");
const titleEl = document.getElementById("package-title");
const subtitleEl = document.getElementById("package-subtitle");

const params = new URLSearchParams(location.search);
const packageId = params.get("name") || "";

async function loadPackage() {
  if (!packageId) {
    statusEl.textContent = "No package specified.";
    return;
  }

  try {
    const releases = await fetchReleases();
    const packageReleases = releases.filter((r) => r.package === packageId);

    if (packageReleases.length === 0) {
      titleEl.textContent = packageId;
      statusEl.textContent = "No releases found for this package.";
      return;
    }

    const displayTitle = packageReleases[0].title || packageId;
    titleEl.textContent = displayTitle;
    const repo = packageReleases[0].repo;
    subtitleEl.innerHTML = `<a href="https://github.com/${escapeHtml(repo)}" target="_blank" rel="noopener">${escapeHtml(repo)}</a> on GitHub &middot; <a href="https://www.nuget.org/packages/${escapeHtml(packageId)}" target="_blank" rel="noopener">${escapeHtml(packageId)}</a> on NuGet`;
    document.title = `${displayTitle} — Jumoo Releases`;

    feedEl.innerHTML = "";
    for (const r of packageReleases) {
      feedEl.appendChild(renderRelease(r));
    }

    if (location.hash) {
      const target = document.getElementById(location.hash.slice(1));
      if (target) target.scrollIntoView();
    }
  } catch (err) {
    statusEl.textContent = `Couldn't load releases: ${err.message}`;
    feedEl.innerHTML = "";
    feedEl.appendChild(statusEl);
  }
}

loadPackage();
