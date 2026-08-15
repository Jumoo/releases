const mainEl = document.getElementById("stats-main");
const statusEl = document.getElementById("status");

const CHART_COLORS = ["#5b9dff", "#e8a94b", "#5bd9a4", "#e05b8f", "#9d7bff", "#7d8eb5"];
const LEGACY_COLORS = { supported: "#5bd9a4", eol: "#e05b8f" };

async function fetchDownloads() {
  try {
    const res = await fetch("downloads.json", { cache: "no-store" });
    if (!res.ok) return { packages: [] };
    return res.json();
  } catch {
    return { packages: [] };
  }
}

async function fetchDownloadsHistory() {
  try {
    const res = await fetch("downloads-history.json", { cache: "no-store" });
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
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

// --- Trivia + big counter ---------------------------------------------

function weekdayName(dayIndex) {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][dayIndex];
}

function renderTrivia(releases, downloads) {
  const { details, body: el } = section("At a glance", null, true);

  const totalDownloads = downloads.packages.reduce((sum, p) => sum + p.totalDownloads, 0);

  const counter = document.createElement("div");
  counter.className = "big-counter";
  counter.textContent = totalDownloads > 0
    ? `${totalDownloads.toLocaleString()} downloads`
    : "Download counts not yet available";
  el.appendChild(counter);

  const packageCount = new Set(releases.map((r) => r.package)).size;
  const firstRelease = releases.reduce(
    (earliest, r) => (!earliest || new Date(r.publishedAt) < new Date(earliest.publishedAt) ? r : earliest),
    null
  );

  const weekdayCounts = new Array(7).fill(0);
  for (const r of releases) {
    const d = new Date(r.publishedAt);
    if (!Number.isNaN(d.getTime())) weekdayCounts[d.getDay()]++;
  }
  const busiestDay = weekdayCounts.indexOf(Math.max(...weekdayCounts));

  const trivia = [
    { label: "Packages tracked", value: packageCount },
    { label: "Releases all-time", value: releases.length },
    { label: "First release", value: firstRelease ? formatDate(firstRelease.publishedAt) : "—" },
    { label: "Most common release day", value: weekdayName(busiestDay) },
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

// --- Release cadence -----------------------------------------------------

function monthKey(date) {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function renderReleaseCadence(releases) {
  const { details, body: el } = section("Release cadence", "Releases per month, and how long since each package last shipped");

  // Releases per month, last 24 months.
  const now = new Date();
  const months = [];
  for (let i = 23; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push(monthKey(d));
  }
  const counts = new Map(months.map((m) => [m, 0]));
  for (const r of releases) {
    const key = monthKey(r.publishedAt);
    if (counts.has(key)) counts.set(key, counts.get(key) + 1);
  }

  const canvas = document.createElement("canvas");
  canvas.className = "cadence-chart";
  el.appendChild(canvas);
  new Chart(canvas, {
    type: "bar",
    data: {
      labels: months,
      datasets: [{
        label: "Releases",
        data: months.map((m) => counts.get(m)),
        backgroundColor: CHART_COLORS[0],
      }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "#7d8eb5", maxRotation: 90, minRotation: 90 }, grid: { color: "#1c2740" } },
        y: { beginAtZero: true, ticks: { color: "#7d8eb5", precision: 0 }, grid: { color: "#1c2740" } },
      },
    },
  });

  // Per-package: total releases, days since last release, average gap.
  const byPackage = groupByPackage(releases);
  const rows = byPackage.map((g) => {
    const sorted = [...g.releases].sort((a, b) => new Date(a.publishedAt) - new Date(b.publishedAt));
    const lastDate = new Date(sorted[sorted.length - 1].publishedAt);
    const daysSince = Math.floor((Date.now() - lastDate.getTime()) / 86400000);

    let totalGap = 0;
    for (let i = 1; i < sorted.length; i++) {
      totalGap += (new Date(sorted[i].publishedAt) - new Date(sorted[i - 1].publishedAt)) / 86400000;
    }
    const averageGap = sorted.length > 1 ? Math.round(totalGap / (sorted.length - 1)) : 0;

    return { title: g.title, totalReleases: sorted.length, daysSince, averageGap };
  });
  rows.sort((a, b) => a.daysSince - b.daysSince);

  // Headers are kept short (with title tooltips for the full meaning) so
  // four columns still fit comfortably at the site's narrow max-width.
  const table = document.createElement("table");
  table.className = "stats-table";
  table.innerHTML = `
    <thead>
      <tr>
        <th>Package</th>
        <th title="Total releases all-time">Releases</th>
        <th title="Days since last release">Since last</th>
        <th title="Average gap between releases, in days">Avg gap</th>
      </tr>
    </thead>
    <tbody>
      ${rows.map((r) => `<tr><td>${escapeHtml(r.title)}</td><td>${r.totalReleases}</td><td>${r.daysSince}</td><td>${r.averageGap}</td></tr>`).join("")}
    </tbody>
  `;
  el.appendChild(table);

  return details;
}

// --- Downloads per package -------------------------------------------------

function renderSparkline(container, packageId, history) {
  const rows = history
    .filter((h) => h.package === packageId)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  if (rows.length < 2) {
    const since = rows[0] ? formatDate(rows[0].date) : "today";
    const note = document.createElement("span");
    note.className = "sparkline-placeholder";
    note.textContent = `Collecting data since ${since}`;
    container.appendChild(note);
    return;
  }

  const canvas = document.createElement("canvas");
  canvas.className = "sparkline";
  canvas.width = 140;
  canvas.height = 32;
  container.appendChild(canvas);
  new Chart(canvas, {
    type: "line",
    data: {
      labels: rows.map((r) => r.date),
      datasets: [{
        data: rows.map((r) => r.totalDownloads),
        borderColor: CHART_COLORS[0],
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.2,
      }],
    },
    options: {
      responsive: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: { x: { display: false }, y: { display: false } },
    },
  });
}

function renderDownloadsTable(downloads, history) {
  const { details, body: el } = section("Downloads per package", "All-time cumulative NuGet downloads, not a live install count");

  if (downloads.packages.length === 0) {
    const p = document.createElement("p");
    p.className = "stats-section-subtitle";
    p.textContent = "Download data isn't available yet.";
    el.appendChild(p);
    return details;
  }

  const sorted = [...downloads.packages].sort((a, b) => b.totalDownloads - a.totalDownloads);

  const table = document.createElement("table");
  table.className = "stats-table downloads-table";
  const tbody = document.createElement("tbody");
  table.innerHTML = `<thead><tr><th>Package</th><th>Total downloads</th><th>Trend</th></tr></thead>`;
  table.appendChild(tbody);

  for (const pkg of sorted) {
    const tr = document.createElement("tr");
    const trendTd = document.createElement("td");
    trendTd.className = "sparkline-cell";
    tr.innerHTML = `<td>${escapeHtml(pkg.title)}</td><td>${pkg.totalDownloads.toLocaleString()}</td>`;
    tr.appendChild(trendTd);
    tbody.appendChild(tr);
    renderSparkline(trendTd, pkg.package, history);
  }

  el.appendChild(table);
  return details;
}

// --- Version adoption / legacy debt shared helpers ----------------------

// package@version -> resolved Umbraco major, from the releases feed.
function buildMajorByPackageVersion(releases) {
  const map = new Map();
  for (const r of releases) {
    map.set(`${r.package.toLowerCase()}@${r.version}`, r.umbracoMajor ?? majorOf(r.version));
  }
  return map;
}

// Given one package's per-version download counts, buckets them by
// resolved Umbraco major -> total downloads.
function computeMajorDownloads(pkg, majorByPackageVersion) {
  const byMajor = new Map();
  for (const v of pkg.versions) {
    const major = majorByPackageVersion.get(`${pkg.package.toLowerCase()}@${v.version}`) ?? majorOf(v.version);
    byMajor.set(major, (byMajor.get(major) || 0) + v.downloads);
  }
  return byMajor;
}

// --- Legacy debt ---------------------------------------------------------

function renderLegacyDebt(downloads, majorByPackageVersion, eol) {
  const { details, body: el } = section(
    "Legacy debt",
    "Share of cumulative downloads sitting on Umbraco major versions that are already end-of-life"
  );

  const perPackage = downloads.packages
    .map((pkg) => {
      const byMajor = computeMajorDownloads(pkg, majorByPackageVersion);
      let total = 0;
      let eolDownloads = 0;
      for (const [major, count] of byMajor) {
        total += count;
        if (!isMajorSupported(major, eol)) eolDownloads += count;
      }
      return { title: pkg.title, total, eolPct: total > 0 ? (eolDownloads / total) * 100 : 0 };
    })
    .filter((p) => p.total > 0);

  if (perPackage.length === 0) {
    const p = document.createElement("p");
    p.className = "stats-section-subtitle";
    p.textContent = "Download data isn't available yet.";
    el.appendChild(p);
    return details;
  }

  const overallTotal = downloads.packages.reduce((sum, pkg) => sum + pkg.totalDownloads, 0);
  const overallEol = perPackage.reduce((sum, p) => sum + (p.eolPct / 100) * p.total, 0);
  const overallPct = overallTotal > 0 ? Math.round((overallEol / overallTotal) * 1000) / 10 : 0;

  const gaugeWrap = document.createElement("div");
  gaugeWrap.className = "gauge-wrap";
  const gaugeChartWrap = document.createElement("div");
  gaugeChartWrap.className = "gauge-chart-wrap";
  const gaugeCanvas = document.createElement("canvas");
  gaugeChartWrap.appendChild(gaugeCanvas);
  gaugeWrap.appendChild(gaugeChartWrap);
  gaugeWrap.innerHTML += `
    <div class="gauge-label">
      <span class="gauge-pct">${overallPct}%</span>
      <span class="gauge-caption">of all downloads are on EOL Umbraco versions</span>
    </div>
  `;
  el.appendChild(gaugeWrap);

  new Chart(gaugeCanvas, {
    type: "doughnut",
    data: {
      labels: ["On EOL versions", "Supported versions"],
      datasets: [{
        data: [overallEol, overallTotal - overallEol],
        backgroundColor: [LEGACY_COLORS.eol, LEGACY_COLORS.supported],
        borderWidth: 0,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      circumference: 180,
      rotation: 270,
      cutout: "72%",
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${Math.round(ctx.raw).toLocaleString()} downloads` } },
      },
    },
  });

  // Per-package breakdown, worst offenders (highest EOL share) first.
  perPackage.sort((a, b) => b.eolPct - a.eolPct);

  const chartWrap = document.createElement("div");
  chartWrap.className = "adoption-chart-wrap";
  chartWrap.style.height = `${Math.max(160, perPackage.length * 32)}px`;
  const canvas = document.createElement("canvas");
  canvas.className = "adoption-chart";
  chartWrap.appendChild(canvas);
  el.appendChild(chartWrap);

  new Chart(canvas, {
    type: "bar",
    data: {
      labels: perPackage.map((p) => p.title),
      datasets: [
        {
          label: "On EOL versions",
          data: perPackage.map((p) => Math.round(p.eolPct * 10) / 10),
          backgroundColor: LEGACY_COLORS.eol,
        },
        {
          label: "Supported versions",
          data: perPackage.map((p) => Math.round((100 - p.eolPct) * 10) / 10),
          backgroundColor: LEGACY_COLORS.supported,
        },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom", labels: { color: "#7d8eb5", boxWidth: 12 } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.raw}%` } },
      },
      scales: {
        x: { stacked: true, beginAtZero: true, max: 100, ticks: { color: "#7d8eb5", callback: (v) => `${v}%` }, grid: { color: "#1c2740" } },
        y: { stacked: true, ticks: { color: "#7d8eb5" }, grid: { display: false } },
      },
    },
  });

  return details;
}

// --- Version adoption ----------------------------------------------------

function renderVersionAdoption(downloads, majorByPackageVersion) {
  const { details, body: el } = section(
    "Version adoption",
    "Share of each package's cumulative downloads by Umbraco major version — a proxy for upgrade speed, not current active installs"
  );

  let anyRendered = false;
  for (const pkg of downloads.packages) {
    const byMajor = computeMajorDownloads(pkg, majorByPackageVersion);
    const majors = [...byMajor.keys()].sort((a, b) => a - b);
    if (majors.length < 2) continue; // Not interesting for single-major packages.

    anyRendered = true;
    const total = [...byMajor.values()].reduce((a, b) => a + b, 0);

    const wrap = document.createElement("div");
    wrap.className = "adoption-package";
    const heading = document.createElement("h3");
    heading.className = "adoption-package-title";
    heading.textContent = pkg.title;
    wrap.appendChild(heading);

    const chartWrap = document.createElement("div");
    chartWrap.className = "adoption-chart-wrap";
    // Give each bar room to breathe rather than squashing them into a
    // fixed-height chart - more majors means a taller chart.
    chartWrap.style.height = `${Math.max(160, majors.length * 42)}px`;
    const canvas = document.createElement("canvas");
    canvas.className = "adoption-chart";
    chartWrap.appendChild(canvas);
    wrap.appendChild(chartWrap);
    new Chart(canvas, {
      type: "bar",
      data: {
        labels: majors.map((m) => `v${m}`),
        datasets: [{
          data: majors.map((m) => Math.round((byMajor.get(m) / total) * 1000) / 10),
          backgroundColor: majors.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]),
        }],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => `${ctx.raw}% of downloads` } },
        },
        scales: {
          x: { beginAtZero: true, max: 100, ticks: { color: "#7d8eb5", callback: (v) => `${v}%` }, grid: { color: "#1c2740" } },
          y: { ticks: { color: "#7d8eb5" }, grid: { display: false } },
        },
      },
    });

    el.appendChild(wrap);
  }

  if (!anyRendered) {
    const p = document.createElement("p");
    p.className = "stats-section-subtitle";
    p.textContent = "No package currently spans more than one Umbraco major version.";
    el.appendChild(p);
  }

  return details;
}

// --- Boot ------------------------------------------------------------

async function loadStats() {
  try {
    const [releases, downloads, history, eol] = await Promise.all([
      fetchReleases(),
      fetchDownloads(),
      fetchDownloadsHistory(),
      fetchEol(),
    ]);

    mainEl.innerHTML = "";
    if (releases.length === 0) {
      statusEl.textContent = "No release data yet.";
      mainEl.appendChild(statusEl);
      return;
    }

    const majorByPackageVersion = buildMajorByPackageVersion(releases);

    mainEl.appendChild(renderTrivia(releases, downloads));
    mainEl.appendChild(renderReleaseCadence(releases));
    mainEl.appendChild(renderDownloadsTable(downloads, history));
    mainEl.appendChild(renderLegacyDebt(downloads, majorByPackageVersion, eol));
    mainEl.appendChild(renderVersionAdoption(downloads, majorByPackageVersion));
  } catch (err) {
    statusEl.textContent = `Couldn't load stats: ${err.message}`;
    mainEl.innerHTML = "";
    mainEl.appendChild(statusEl);
  }
}

loadStats();
