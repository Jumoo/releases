const feedEl = document.getElementById("feed");
const statusEl = document.getElementById("status");

function renderPackageCard(group) {
  const r = group.latest;
  const prereleaseBadge = r.prerelease ? '<span class="badge">pre-release</span>' : "";
  const packageHref = `package.html?name=${encodeURIComponent(group.package)}`;

  const el = document.createElement("a");
  el.className = "package-card";
  el.href = packageHref;

  el.innerHTML = `
    <span class="package-card-name">${escapeHtml(group.title)}</span>
    <span class="package-card-meta">
      <span class="package-card-version">v${escapeHtml(r.version)}${prereleaseBadge}</span>
      <span class="package-card-date">${formatDate(r.publishedAt)}</span>
    </span>
  `;
  return el;
}

function renderCategorySection(categoryGroup) {
  const wrapper = document.createDocumentFragment();

  if (categoryGroup.category !== "") {
    const heading = document.createElement("h2");
    heading.className = "category-heading";
    heading.textContent = categoryGroup.category;
    wrapper.appendChild(heading);
  }

  for (const group of categoryGroup.packages) {
    wrapper.appendChild(renderPackageCard(group));
  }
  return wrapper;
}

async function loadReleases() {
  try {
    const [releases, categoryOrder] = await Promise.all([fetchReleases(), fetchCategoryOrder()]);

    feedEl.innerHTML = "";
    if (releases.length === 0) {
      statusEl.textContent = "No releases yet.";
      feedEl.appendChild(statusEl);
      return;
    }

    const packageGroups = groupByPackage(releases);
    for (const categoryGroup of groupByCategory(packageGroups, categoryOrder)) {
      feedEl.appendChild(renderCategorySection(categoryGroup));
    }
  } catch (err) {
    statusEl.textContent = `Couldn't load releases: ${err.message}`;
    feedEl.innerHTML = "";
    feedEl.appendChild(statusEl);
  }
}

loadReleases();
