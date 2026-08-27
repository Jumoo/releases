const mainEl = document.getElementById("activity-main");
const statusEl = document.getElementById("status");

const ENGAGEMENT_COLORS = { issuesOpened: "#5b9dff", issuesClosed: "#e8a94b", prsMerged: "#3ddc97", commits: "#9d7bff" };

async function fetchActivity() {
  const res = await fetch("activity.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function fetchEngagement() {
  try {
    const res = await fetch("engagement.json", { cache: "no-store" });
    if (!res.ok) return { packages: [] };
    return res.json();
  } catch {
    return { packages: [] };
  }
}

function monthKey(date) {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function lastNMonths(n) {
  const now = new Date();
  const months = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push(monthKey(d));
  }
  return months;
}

function formatMonth(monthStr) {
  return new Date(`${monthStr}-01T00:00:00Z`).toLocaleDateString(undefined, { year: "numeric", month: "long", timeZone: "UTC" });
}

// --- At a glance ----------------------------------------------------------

// Sums each package's monthly rows falling within `months` into one
// {month -> {issuesOpened, prsMerged, commits}} map, plus a grand total
// across all months. Shared by the trivia cards, the chart, and the table.
function sumEngagementByMonth(engagementPackages, months) {
  const byMonth = new Map(months.map((m) => [m, { issuesOpened: 0, issuesClosed: 0, prsMerged: 0, commits: 0 }]));
  const grand = { issuesOpened: 0, issuesClosed: 0, prsMerged: 0, commits: 0 };
  for (const pkg of engagementPackages) {
    for (const row of pkg.months) {
      const bucket = byMonth.get(row.month);
      if (!bucket) continue;
      bucket.issuesOpened += row.issuesOpened;
      bucket.issuesClosed += row.issuesClosed;
      bucket.prsMerged += row.prsMerged;
      bucket.commits += row.commits;
      grand.issuesOpened += row.issuesOpened;
      grand.issuesClosed += row.issuesClosed;
      grand.prsMerged += row.prsMerged;
      grand.commits += row.commits;
    }
  }
  return { byMonth, grand };
}

// Busiest single month, site-wide, across all activity types - just a fun
// number, not something to act on.
function busiestMonth(engagementPackages) {
  const monthTotals = new Map();
  for (const pkg of engagementPackages) {
    for (const row of pkg.months) {
      const total = row.issuesOpened + row.prsMerged + row.commits;
      monthTotals.set(row.month, (monthTotals.get(row.month) ?? 0) + total);
    }
  }
  const [month, total] = [...monthTotals.entries()].reduce(
    (best, entry) => (entry[1] > best[1] ? entry : best),
    [null, -1]
  );
  return { month, total };
}

function renderAtAGlance(engagement) {
  const { details, body: el } = section("At a glance", null, true);

  const { grand } = sumEngagementByMonth(engagement.packages, lastNMonths(12));
  const { month, total: busiestMonthTotal } = busiestMonth(engagement.packages);
  const allTimePrsMerged = engagement.packages.reduce(
    (sum, pkg) => sum + pkg.months.reduce((s, m) => s + m.prsMerged, 0),
    0
  );

  const counter = document.createElement("div");
  counter.className = "big-counter";
  counter.textContent = `${grand.commits.toLocaleString()} commits in the last 12 months`;
  el.appendChild(counter);

  const trivia = [
    { label: "Issues opened (12mo)", value: grand.issuesOpened },
    { label: "Issues closed (12mo)", value: grand.issuesClosed },
    { label: "PRs merged (12mo)", value: grand.prsMerged },
    { label: `${month ? formatMonth(month) : "Busiest month"}'s activity`, value: busiestMonthTotal >= 0 ? busiestMonthTotal : "—" },
    { label: "PRs merged (all-time)", value: allTimePrsMerged.toLocaleString() },
  ];

  const grid = document.createElement("div");
  grid.className = "trivia-grid";
  for (const item of trivia) {
    const card = document.createElement("div");
    card.className = "trivia-card";
    card.innerHTML = `<span class="trivia-value">${escapeHtml(String(item.value))}</span><span class="trivia-label">${escapeHtml(item.label)}</span>`;
    grid.appendChild(card);
  }
  el.appendChild(grid);

  return details;
}

// --- Engineering activity (issues/PRs/commits per month) ----------------

function renderEngagementChart(engagementPackages) {
  const months = lastNMonths(12);
  const { byMonth: totals } = sumEngagementByMonth(engagementPackages, months);

  const canvas = document.createElement("canvas");
  canvas.className = "cadence-chart";
  new Chart(canvas, {
    type: "bar",
    data: {
      labels: months,
      datasets: [
        { label: "Issues opened", data: months.map((m) => totals.get(m).issuesOpened), backgroundColor: ENGAGEMENT_COLORS.issuesOpened },
        { label: "Issues closed", data: months.map((m) => totals.get(m).issuesClosed), backgroundColor: ENGAGEMENT_COLORS.issuesClosed },
        { label: "PRs merged", data: months.map((m) => totals.get(m).prsMerged), backgroundColor: ENGAGEMENT_COLORS.prsMerged },
        { label: "Commits", data: months.map((m) => totals.get(m).commits), backgroundColor: ENGAGEMENT_COLORS.commits },
      ],
    },
    options: {
      plugins: { legend: { position: "bottom", labels: { color: "#7d8eb5", boxWidth: 12 } } },
      scales: {
        x: { ticks: { color: "#7d8eb5", maxRotation: 90, minRotation: 90 }, grid: { color: "#1c2740" } },
        y: { beginAtZero: true, ticks: { color: "#7d8eb5", precision: 0 }, grid: { color: "#1c2740" } },
      },
    },
  });

  return canvas;
}

function renderEngagementTable(engagementPackages, titleByPackage) {
  const months = new Set(lastNMonths(12));
  const rows = engagementPackages.map((pkg) => {
    const totals = { issuesOpened: 0, issuesClosed: 0, prsMerged: 0, commits: 0 };
    for (const row of pkg.months) {
      if (!months.has(row.month)) continue;
      totals.issuesOpened += row.issuesOpened;
      totals.issuesClosed += row.issuesClosed;
      totals.prsMerged += row.prsMerged;
      totals.commits += row.commits;
    }
    return { package: pkg.package, title: titleByPackage.get(pkg.package) ?? pkg.package, ...totals };
  });
  rows.sort((a, b) => (b.prsMerged + b.commits) - (a.prsMerged + a.commits));

  const table = document.createElement("table");
  table.className = "stats-table";
  table.innerHTML = `
    <thead>
      <tr>
        <th>Package</th>
        <th title="Issues opened in the last 12 months">Issues opened</th>
        <th title="Issues closed in the last 12 months">Issues closed</th>
        <th title="Pull requests merged in the last 12 months">PRs merged</th>
        <th title="Commits on the default branch in the last 12 months">Commits</th>
      </tr>
    </thead>
    <tbody>
      ${rows
        .map(
          (r) =>
            `<tr><td><a href="package.html?name=${encodeURIComponent(r.package)}">${escapeHtml(r.title)}</a></td><td>${r.issuesOpened}</td><td>${r.issuesClosed}</td><td>${r.prsMerged}</td><td>${r.commits}</td></tr>`
        )
        .join("")}
    </tbody>
  `;
  return table;
}

function renderEngagementSection(engagement, titleByPackage) {
  if (engagement.packages.length === 0) return document.createDocumentFragment();

  const { details, body: el } = section(
    "Engineering activity",
    "Issues, pull requests, and commits across tracked repos, per month. Commit counts only cover the trailing 12 months - GitHub doesn't expose commit history further back through this data source."
  );
  el.appendChild(renderEngagementChart(engagement.packages));
  el.appendChild(renderEngagementTable(engagement.packages, titleByPackage));
  return details;
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
    const [{ packages }, engagement, releases] = await Promise.all([fetchActivity(), fetchEngagement(), fetchReleases()]);

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

    // releases.json is the most complete source of package titles - activity.json
    // can be missing a package entirely if its GitHub repo-info fetch failed on
    // the last run.
    const titleByPackage = new Map(groupByPackage(releases).map((g) => [g.package, g.title]));

    mainEl.appendChild(renderAtAGlance(engagement));

    const { details, body } = section(
      "Commit activity",
      "How far each package's default branch has drifted since its last tagged release"
    );
    body.appendChild(renderUntaggedNote(untagged));
    body.appendChild(renderActivityTable([...tagged, ...untagged]));
    mainEl.appendChild(details);

    mainEl.appendChild(renderEngagementSection(engagement, titleByPackage));
  } catch (err) {
    statusEl.textContent = `Couldn't load activity: ${err.message}`;
    mainEl.innerHTML = "";
    mainEl.appendChild(statusEl);
  }
}

loadActivity();
