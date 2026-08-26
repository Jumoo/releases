const feedEl = document.getElementById("feed");
const statusEl = document.getElementById("status");

function renderVersionGroup(group, eol) {
  const majors = highestPerMajor(group.releases);
  if (majors.length === 0) return null;

  const el = document.createElement("div");
  el.className = "version-group";

  const nameEl = document.createElement("a");
  nameEl.className = "version-group-name";
  nameEl.href = `package.html?name=${encodeURIComponent(group.package)}`;
  nameEl.textContent = group.title;
  el.appendChild(nameEl);

  const chips = document.createElement("div");
  chips.className = "version-chips";
  for (const r of majors) {
    const supported = isMajorSupported(effectiveMajor(r), eol);
    chips.appendChild(renderVersionChip(r, supported));
  }
  el.appendChild(chips);

  return el;
}

function renderCategorySection(categoryGroup, eol) {
  const groupEls = categoryGroup.packages
    .map((g) => renderVersionGroup(g, eol))
    .filter(Boolean);

  if (groupEls.length === 0) return document.createDocumentFragment();

  if (categoryGroup.category === "") {
    const wrapper = document.createDocumentFragment();
    for (const groupEl of groupEls) {
      wrapper.appendChild(groupEl);
    }
    return wrapper;
  }

  const details = document.createElement("details");
  details.className = "category-group";
  details.open = false;

  const summary = document.createElement("summary");
  summary.className = "category-heading";
  summary.textContent = categoryGroup.category;
  details.appendChild(summary);

  for (const groupEl of groupEls) {
    details.appendChild(groupEl);
  }
  return details;
}

async function loadVersions() {
  try {
    const [releases, eol, categoryOrder] = await Promise.all([fetchReleases(), fetchEol(), fetchCategoryOrder()]);

    feedEl.innerHTML = "";
    if (releases.length === 0) {
      statusEl.textContent = "No releases yet.";
      feedEl.appendChild(statusEl);
      return;
    }

    const packageGroups = groupByPackage(releases);
    for (const categoryGroup of groupByCategory(packageGroups, categoryOrder)) {
      feedEl.appendChild(renderCategorySection(categoryGroup, eol));
    }
  } catch (err) {
    statusEl.textContent = `Couldn't load versions: ${err.message}`;
    feedEl.innerHTML = "";
    feedEl.appendChild(statusEl);
  }
}

loadVersions();
