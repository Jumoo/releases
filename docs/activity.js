const mainEl = document.getElementById("activity-main");
const statusEl = document.getElementById("status");

async function fetchActivity() {
  const res = await fetch("activity.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

function renderUntaggedNote(untagged) {
  if (untagged.length === 0) return document.createDocumentFragment();

  const wrap = document.createElement("div");
  wrap.className = "stats-section-subtitle";
  wrap.innerHTML = `<span class="badge badge-untagged">no tagged releases</span> ${untagged
    .map((p) => escapeHtml(p.title))
    .join(", ")} — auto-release/tagging isn't set up for these, so commits-since-release can't be measured.`;
  return wrap;
}

function renderActivityTable(rows) {
  const table = document.createElement("table");
  table.className = "stats-table activity-table";
  const tbody = document.createElement("tbody");
  table.innerHTML = `
    <thead>
      <tr>
        <th>Package</th>
        <th>Last release</th>
        <th>Release date</th>
        <th title="Commits on the default branch since the last tagged release">Commits since</th>
        <th>Last commit</th>
      </tr>
    </thead>
  `;
  table.appendChild(tbody);

  for (const p of rows) {
    const tr = document.createElement("tr");
    const releaseCell = p.lastReleaseTag
      ? `<a href="${escapeHtml(p.lastReleaseUrl)}" target="_blank" rel="noopener">${escapeHtml(p.lastReleaseTag)}</a>`
      : '<span class="badge badge-untagged">untagged</span>';

    // Flag when the release was cut from a branch other than the repo's
    // current default (e.g. a v18.0.1 release cut from v18/main on a repo
    // whose default is the v17/main LTS branch) - the commit count below is
    // against that release branch, not the default one.
    const branchNote =
      p.releaseBranch && p.releaseBranch !== p.defaultBranch
        ? ` <span class="branch-note" title="Released from ${escapeHtml(p.releaseBranch)} - the repo's default branch is ${escapeHtml(p.defaultBranch)}">on ${escapeHtml(p.releaseBranch)}</span>`
        : "";

    const commitsCell =
      p.commitsSince === null
        ? "—"
        : `<span title="${escapeHtml(String(p.commitsSince))} commit(s) on ${escapeHtml(p.releaseBranch ?? "")} since ${escapeHtml(p.lastReleaseTag ?? "")}">${p.commitsSince}</span>`;

    tr.innerHTML = `
      <td><a href="package.html?name=${encodeURIComponent(p.package)}">${escapeHtml(p.title)}</a></td>
      <td>${releaseCell}${branchNote}</td>
      <td>${formatDate(p.lastReleaseDate)}</td>
      <td>${commitsCell}</td>
      <td>${formatDate(p.lastCommitDate)}</td>
    `;
    tbody.appendChild(tr);
  }

  return table;
}

async function loadActivity() {
  try {
    const { packages } = await fetchActivity();

    mainEl.innerHTML = "";
    if (packages.length === 0) {
      statusEl.textContent = "No activity data yet.";
      mainEl.appendChild(statusEl);
      return;
    }

    const untagged = packages.filter((p) => !p.lastReleaseTag);
    const tagged = packages
      .filter((p) => p.lastReleaseTag)
      .sort((a, b) => (b.commitsSince ?? -1) - (a.commitsSince ?? -1));

    mainEl.appendChild(renderUntaggedNote(untagged));
    mainEl.appendChild(renderActivityTable([...tagged, ...untagged]));
  } catch (err) {
    statusEl.textContent = `Couldn't load activity: ${err.message}`;
    mainEl.innerHTML = "";
    mainEl.appendChild(statusEl);
  }
}

loadActivity();
