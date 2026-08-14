const mainEl = document.getElementById("matrix-main");
const statusEl = document.getElementById("status");

async function fetchCompatibility() {
  const res = await fetch("compatibility.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

// Groups packages by category, preserving packages.json's order within
// each category. The uncategorized bucket (empty category) always comes
// first and renders without a heading, matching common.js's groupByCategory.
function groupByCategory(packages) {
  const categories = new Map();
  for (const pkg of packages) {
    const key = pkg.category || "";
    if (!categories.has(key)) categories.set(key, { category: key, packages: [] });
    categories.get(key).packages.push(pkg);
  }
  return [...categories.values()].sort((a, b) => {
    if (a.category === "" && b.category !== "") return -1;
    if (b.category === "" && a.category !== "") return 1;
    return 0;
  });
}

function nugetUrl(nugetId, version) {
  return `https://www.nuget.org/packages/${encodeURIComponent(nugetId)}/${encodeURIComponent(version)}`;
}

function buildTable(packages, majors) {
  const wrap = document.createElement("div");
  wrap.className = "compat-table-wrap";

  const table = document.createElement("table");
  table.className = "compat-table";

  const thead = document.createElement("thead");
  thead.innerHTML = `
    <tr>
      <th class="compat-package-col">Package</th>
      ${majors.map((m) => `<th>v${m}</th>`).join("")}
    </tr>
  `;
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const pkg of packages) {
    const row = document.createElement("tr");
    const cells = majors
      .map((m) => {
        const version = pkg.support[m];
        if (!version) return `<td class="compat-none">—</td>`;
        return `<td><a href="${nugetUrl(pkg.package, version)}" target="_blank" rel="noopener">${escapeHtml(version)}</a></td>`;
      })
      .join("");
    row.innerHTML = `<td class="compat-package-col">${escapeHtml(pkg.title)}</td>${cells}`;
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

async function loadCompatibility() {
  try {
    const packages = await fetchCompatibility();

    mainEl.innerHTML = "";
    if (packages.length === 0) {
      statusEl.textContent = "No compatibility data yet.";
      mainEl.appendChild(statusEl);
      return;
    }

    const majorsSet = new Set();
    for (const pkg of packages) {
      for (const major of Object.keys(pkg.support)) majorsSet.add(Number(major));
    }
    const majors = [...majorsSet].sort((a, b) => a - b);

    for (const categoryGroup of groupByCategory(packages)) {
      if (categoryGroup.category !== "") {
        const heading = document.createElement("h2");
        heading.className = "category-heading";
        heading.textContent = categoryGroup.category;
        mainEl.appendChild(heading);
      }
      mainEl.appendChild(buildTable(categoryGroup.packages, majors));
    }
  } catch (err) {
    statusEl.textContent = `Couldn't load compatibility data: ${err.message}`;
    mainEl.innerHTML = "";
    mainEl.appendChild(statusEl);
  }
}

loadCompatibility();
