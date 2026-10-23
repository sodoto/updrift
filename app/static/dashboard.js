const Dashboard = (() => {
  const KIND = { docker: "Docker", lxc: "LXC", host: "Host" };
  const STATUS = { update_available: "Update available", up_to_date: "Up to date", error: "Error", skipped: "Skipped" };
  const ORDER = { update_available: 0, error: 1, up_to_date: 2, skipped: 3 };
  let state = null;
  let filter = "all";
  let timer;
  const open = new Set();
  const rechecking = new Set();
  const recheckError = {};  // item id -> message from the last failed re-check
  const collapsed = new Set(loadCollapsed());

  function loadCollapsed() {
    try { return JSON.parse(localStorage.getItem("um.collapsed") || "[]"); } catch { return []; }
  }
  function saveCollapsed() {
    try { localStorage.setItem("um.collapsed", JSON.stringify([...collapsed])); } catch { /* storage unavailable */ }
  }

  async function load() {
    clearTimeout(timer);
    try {
      state = await api("api/state");
      AppUpdate.render(state.app);
      render();
    } catch (e) {
      $("meta").textContent = `Cannot reach server (${e.message})`;
    }
    const active = state && (state.running || (state.jobs || []).some(j => !j.done));
    timer = setTimeout(load, active ? 3000 : 30000);
  }

  function render() {
    const items = state.items;
    const count = (fn) => items.filter(fn).length;
    $("logoutBtn").hidden = !state.login_enabled;
    const pill = $("modePill");
    pill.textContent = state.allow_updates ? "Updates enabled" : "Read-only";
    pill.classList.toggle("rw", !!state.allow_updates);
    pill.title = state.allow_updates
      ? "Updrift can install updates in your LXCs and Docker Compose containers when you click Update. Turn this off in Settings."
      : "Updrift only reads and checks. It never changes your Proxmox host, containers or Docker.";
    const btn = $("checkBtn");
    btn.disabled = state.running;
    btn.innerHTML = state.running ? '<span class="spin"></span> Checking…' : "Check now";
    $("meta").textContent = state.running ? "Check in progress…"
      : `Last check ${ago(state.last_check_finished)}` + (state.next_check ? ` · next ${ago(state.next_check)}` : "");

    const cards = [
      ["all", "", items.length, "Monitored"],
      ["updates", "upd", count(i => i.status === "update_available"), "Need updates"],
      ["ok", "ok", count(i => i.status === "up_to_date"), "Up to date"],
      ["errors", "err", count(i => i.status === "error"), "Errors"],
    ];
    $("cards").innerHTML = cards.map(([key, cls, n, label]) =>
      `<div class="card ${cls} ${filter === key ? "active" : ""}" data-filter="${key}"><div class="n">${n}</div><div class="l">${label}</div></div>`).join("");

    const banner = (list, cls) => list && list.length
      ? `<div class="banner ${cls}">${list.map(e => `<div><b>${esc(e.source)}:</b> ${esc(e.message)}</div>`).join("")}</div>` : "";
    $("banner").innerHTML = banner(state.errors, "") + banner(state.warnings, "warn-banner");

    if (!state.configured) {
      $("list").innerHTML = `<div class="empty"><b>Nothing configured yet.</b><br>Go to <a href="#settings">Settings</a> to add your Proxmox nodes and Docker hosts.</div>`;
      return;
    }
    if (!items.length) {
      $("list").innerHTML = `<div class="empty">${state.running ? "First check running…" : "No results yet. Click <b>Check now</b>."}</div>`;
      return;
    }

    const q = $("search").value.trim().toLowerCase();
    const kind = $("kind").value;
    const shown = items.filter(i =>
      (filter === "all" || (filter === "updates" && i.status === "update_available")
        || (filter === "ok" && i.status === "up_to_date") || (filter === "errors" && i.status === "error"))
      && (!kind || i.kind === kind)
      && (!q || [i.name, i.detail, i.source, i.note].join(" ").toLowerCase().includes(q)));
    if (!shown.length) { $("list").innerHTML = `<div class="empty">Nothing matches this filter.</div>`; return; }

    const groups = {};
    for (const i of shown) (groups[i.source] ??= []).push(i);
    const names = Object.keys(groups).sort();
    $("collapseAll").textContent = names.every(n => collapsed.has(n)) ? "Expand all" : "Collapse all";
    $("list").innerHTML = names.map(src => {
      const list = groups[src].sort((a, b) => (ORDER[a.status] - ORDER[b.status])
        || (a.kind === b.kind ? 0 : a.kind === "host" ? -1 : b.kind === "host" ? 1 : a.kind.localeCompare(b.kind))
        || a.name.localeCompare(b.name));
      const upd = list.filter(i => i.status === "update_available").length;
      const folded = collapsed.has(src);
      return `<section class="group ${folded ? "collapsed" : ""}">
        <h2 data-group="${esc(src)}" role="button" tabindex="0" aria-expanded="${!folded}"><span class="chev">▾</span>${esc(src)}
          <span class="count">· ${list.length} item${list.length === 1 ? "" : "s"}${upd ? ` · ${upd} to update` : ""}</span></h2>
        ${folded ? "" : rows(list)}</section>`;
    }).join("");
  }

  const jobFor = (id) => (state.jobs || []).find(j => (j.item_ids || [j.item_id]).includes(id) && !j.done);

  // Docker containers of the same Compose project in the same place (all of them, not only the filtered ones).
  function stack(i) {
    if (i.kind !== "docker" || !i.compose_project) return [i];
    return state.items.filter(o => o.kind === "docker" && o.group === i.group && o.source === i.source
      && o.vmid === i.vmid && o.compose_project === i.compose_project);
  }

  // Rows of a group: stand-alone items first, then each Compose stack (2+ containers) under its own header.
  function rows(list) {
    const stacks = {};
    const single = [];
    for (const i of list) {
      if (i.kind === "docker" && i.compose_project && stack(i).length > 1) (stacks[i.compose_project] ??= []).push(i);
      else single.push(i);
    }
    const order = Object.keys(stacks).sort((a, b) =>
      (stack(stacks[b][0]).some(i => i.status === "update_available") - stack(stacks[a][0]).some(i => i.status === "update_available"))
      || a.localeCompare(b));
    return single.map(row).join("") + order.map(name => stackHeader(stacks[name][0]) +
      `<div class="stack">${stacks[name].map(row).join("")}</div>`).join("");
  }

  function stackHeader(first) {
    const members = stack(first);
    const upd = members.filter(i => i.status === "update_available").length;
    const busy = members.map(i => jobFor(i.id)).find(Boolean);
    let action = "";
    if (busy) action = `<button class="small" data-job-view="${esc(busy.id)}"><span class="spin"></span> Updating…</button>`;
    else if (state.allow_updates && upd && Jobs.canApply(first, "compose-update-stack"))
      action = `<button class="primary small" data-apply-stack="${esc(first.id)}">Update stack</button>`;
    return `<div class="stack-head"><span class="stack-name">${esc(first.compose_project)}</span>
      <span class="count">stack · ${members.length} containers${upd ? ` · ${upd} to update` : ""}</span>
      <span class="spacer"></span>${action}</div>`;
  }

  function row(i) {
    const badges = [`<span class="badge kind">${KIND[i.kind]}</span>`];
    const apps = (i.app_updates || []).filter(a => a.update);
    if (i.community_script) badges.push(`<span class="badge" title="Created with the Proxmox VE community script ct/${esc(i.community_script)}.sh">Helper script</span>`);
    if (apps.length) badges.push(`<span class="badge update_available" title="${esc(apps.map(a => `${a.name} ${a.current} → ${a.latest}`).join(", "))}">App update</span>`);
    if (i.status === "update_available" && (i.kind === "docker" || i.update_count)) {
      const rebuilt = i.kind === "docker" && dockerUpdateLabel(i) === "Rebuilt image";
      badges.push(`<span class="badge update_available"${rebuilt ? ' title="Same version number, new build (often security fixes in the base image)"' : ""}>${
        i.kind === "docker" ? esc(dockerUpdateLabel(i)) : `${i.update_count} package${i.update_count === 1 ? "" : "s"}`}</span>`);
      if (i.security_count) badges.push(`<span class="badge sec">${i.security_count} security</span>`);
    } else if (i.status !== "update_available") {
      badges.push(`<span class="badge ${i.status}">${STATUS[i.status]}</span>`);
    }
    if (i.reboot_required) badges.push(`<span class="badge update_available">Reboot required</span>`);
    if (i.stale) badges.push(`<span class="badge">Stale</span>`);

    const buttons = [];
    const busy = rechecking.has(i.id) || (state.busy || []).includes(i.id);
    buttons.push(`<button class="icon-btn" data-recheck="${esc(i.id)}" ${busy || state.running ? "disabled" : ""}
      title="${i.kind === "lxc" ? "Check this container again (and its Docker containers)" : "Check this again"}"
      aria-label="Check ${esc(i.name)} again">${busy ? '<span class="spin"></span>' : "↻"}</button>`);
    const job = jobFor(i.id);
    if (job) buttons.push(`<button class="small" data-job-view="${esc(job.id)}"><span class="spin"></span> Updating…</button>`);
    else if (state.allow_updates && i.status === "update_available" && Jobs.canApply(i))
      buttons.push(`<button class="primary" data-apply="${esc(i.id)}">Update</button>`);
    if (!job && state.allow_updates && (i.app_updates || []).some(a => a.update) && Jobs.canApply(i, "community-update"))
      buttons.push(`<button class="primary" data-apply-app="${esc(i.id)}">Update app</button>`);
    if (i.kind === "docker" && i.status === "update_available" && i.release_url)
      buttons.push(`<a class="btn" href="${esc(i.release_url)}" target="_blank" rel="noopener">Release notes ↗</a>`);
    if (i.status === "update_available")
      buttons.push(`<button class="icon-btn" data-howto="${esc(i.id)}" title="How to update" aria-label="How to update ${esc(i.name)}">i</button>`);
    if (i.packages.length || i.kind === "docker" || i.note || i.community_script)
      buttons.push(`<button data-toggle="${esc(i.id)}">${open.has(i.id) ? "Hide" : "Details"}</button>`);
    if (i.link) buttons.push(`<a class="btn" href="${esc(i.link)}" target="_blank" rel="noopener">Dockhand ↗</a>`);

    const detail = i.kind === "docker" ? `<code>${esc(i.detail)}</code>` : esc(i.detail);
    return `<div class="row">
      <span class="dot ${i.status}" title="${STATUS[i.status]}"></span>
      <div><div class="name" title="${esc(i.name)}">${esc(i.name)}</div>${i.kind === "docker" && i.state ? `<div class="sub">${esc(i.state)}</div>` : ""}</div>
      <div class="detail" title="${esc(i.note || i.detail)}">${detail}${i.note && i.status !== "update_available" ? ` — ${esc(i.note)}` : ""}${
        recheckError[i.id] ? `<div class="recheck-error">⚠ ${esc(recheckError[i.id])}</div>` : ""}</div>
      <div class="actions">${badges.join("")}${buttons.join("")}</div>
      ${open.has(i.id) ? `<div class="expand">${expand(i)}</div>` : ""}
    </div>`;
  }

  function expand(i) {
    if (i.kind === "docker") {
      return `<table>
        <tr><th>Image</th><td><code>${esc(i.detail)}</code></td></tr>
        <tr><th>Running version</th><td>${esc(i.current_version || "not published by this image")}</td></tr>
        ${i.status === "update_available" ? `<tr><th>New version</th><td>${esc(i.new_version || "not published by this image")}${
          dockerUpdateLabel(i) === "Rebuilt image" ? " (same version, new build)" : ""}</td></tr>` : ""}
        ${i.release_url ? `<tr><th>Release notes</th><td><a href="${esc(i.release_url)}" target="_blank" rel="noopener">${esc(i.release_url.replace("https://", ""))}</a></td></tr>` : ""}
        ${i.source_url && i.source_url !== i.release_url ? `<tr><th>Source code</th><td><a href="${esc(i.source_url)}" target="_blank" rel="noopener">${esc(i.source_url.replace("https://", ""))}</a></td></tr>` : ""}
        ${i.image_page ? `<tr><th>Image page</th><td><a href="${esc(i.image_page)}" target="_blank" rel="noopener">${esc(i.image_page.replace("https://", ""))}</a></td></tr>` : ""}
        <tr><th>Running digest</th><td><code>${esc(i.local_digest || "—")}</code></td></tr>
        <tr><th>Registry digest</th><td><code>${esc(i.remote_digest || "—")}</code></td></tr>
        ${i.note ? `<tr><th>Note</th><td>${esc(i.note)}</td></tr>` : ""}
        <tr><th>Checked</th><td>${ago(i.checked_at)}</td></tr></table>`
        + (i.status === "update_available" ? `<p>Pull the new image and recreate the container (e.g. from Dockhand) to apply.</p>` : "");
    }
    let html = i.note ? `<p>${esc(i.note)}</p>` : "";
    if (i.community_script) {
      html += `<p><b>App</b> (community script <a href="https://github.com/community-scripts/ProxmoxVE/blob/main/ct/${esc(i.community_script)}.sh" target="_blank" rel="noopener">ct/${esc(i.community_script)}.sh</a>)</p>`;
      html += (i.app_updates || []).length
        ? `<table><tr><th>Component</th><th>Installed</th><th>Latest</th><th></th></tr>${i.app_updates.map(a =>
            `<tr><td><a href="https://github.com/${esc(a.repo)}/releases" target="_blank" rel="noopener">${esc(a.name)}</a></td>
             <td>${esc(a.current)}</td><td>${esc(a.latest)}${a.pinned ? ' <span class="hint" title="Version tested by the script maintainers">(tested)</span>' : ""}</td>
             <td>${a.update ? '<span class="badge update_available">update</span>' : '<span class="badge up_to_date">up to date</span>'}</td></tr>`).join("")}</table>`
        : (i.app_self || []).length
          ? i.app_self.map(a => `<p><b>${esc(a.name)}</b> updates itself: the community script's <code>update</code> only updates the OS packages.
              Check for updates in ${esc(a.name)}'s own web interface.${a.latest ? ` Latest release:
              <a href="https://github.com/${esc(a.repo)}/releases" target="_blank" rel="noopener">${esc(a.latest)}</a>.` : ""}</p>`).join("")
          : `<p class="hint">${esc(i.app_note || "No app version recorded in this container.")}</p>`;
      if ((i.app_updates || []).length && i.app_note) html += `<p class="hint">${esc(i.app_note)}</p>`;
      if (i.packages.length) html += `<p style="margin-top:10px"><b>OS packages</b></p>`;
    }
    if (i.packages.length) {
      html += `<div class="pkg-scroll"><table><tr><th>Package</th><th>Installed</th><th>Available</th></tr>${
        i.packages.map(p => `<tr><td>${esc(p.name)}${p.security ? ' <span class="badge sec">security</span>' : ""}</td><td>${esc(p.current || "—")}</td><td>${esc(p.new)}</td></tr>`).join("")
      }</table></div>`;
    }
    return html;
  }

  async function recheck(id) {
    rechecking.add(id);
    delete recheckError[id];
    render();
    try {
      await api("api/check-item", "POST", { id });
    } catch (e) {
      recheckError[id] = e.message;
    }
    rechecking.delete(id);
    await load();
  }

  async function checkNow() {
    await api("api/check", "POST", {});
    if (state) { state.running = true; render(); }
    setTimeout(load, 800);
  }

  document.addEventListener("click", (e) => {
    const card = e.target.closest("[data-filter]");
    if (card) { filter = card.dataset.filter; render(); return; }
    const t = e.target.closest("[data-toggle]");
    if (t) { const id = t.dataset.toggle; open.has(id) ? open.delete(id) : open.add(id); render(); return; }
    const rc = e.target.closest("[data-recheck]");
    if (rc) { recheck(rc.dataset.recheck); return; }
    const h = e.target.closest("[data-howto]");
    if (h) { HowTo.open(state.items.find(i => i.id === h.dataset.howto), state.allow_updates); return; }
    const g = e.target.closest("[data-group]");
    if (g) {
      const name = g.dataset.group;
      collapsed.has(name) ? collapsed.delete(name) : collapsed.add(name);
      saveCollapsed(); render();
    }
  });
  document.addEventListener("keydown", (e) => {
    const g = e.target.closest?.("[data-group]");
    if (g && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); g.click(); }
  });
  $("collapseAll").addEventListener("click", () => {
    if (!state) return;
    const names = [...new Set(state.items.map(i => i.source))];
    const expand = names.every(n => collapsed.has(n));
    names.forEach(n => expand ? collapsed.delete(n) : collapsed.add(n));
    saveCollapsed(); render();
  });
  $("search").addEventListener("input", () => state && render());
  $("kind").addEventListener("change", () => state && render());
  $("checkBtn").addEventListener("click", checkNow);

  return { load, item: (id) => state && state.items.find(i => i.id === id), stack };
})();
