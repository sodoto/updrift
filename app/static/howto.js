// "How to update" instructions shown in a modal. Updrift is read-only:
// it only shows the commands, the user runs them.
const HowTo = (() => {
  const UPGRADE = {
    apt: "apt update && apt full-upgrade -y",
    apk: "apk update && apk upgrade",
    dnf: "dnf upgrade -y",
    pacman: "pacman -Syu --noconfirm",
  };
  const KERNEL = /^(proxmox-kernel|pve-kernel|linux-image)/;

  const where = (label) => `<span class="where">${esc(label)}</span>`;
  const cmd = (text) => `<div class="cmd"><pre>${esc(text)}</pre><button data-copy>Copy</button></div>`;
  const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;  // shell single-quote
  const arg = (s) => /^[\w@%+=:,./-]+$/.test(s) ? s : shq(s);  // quote only when needed
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  // How to get a shell inside an LXC.
  function access(id) {
    return `<p>In Proxmox, open <b>CT ${id} → Console</b> and log in as <code>root</code>.</p>`;
  }

  function lxc(i) {
    const id = i.vmid;
    const up = UPGRADE[i.manager];
    const kernel = i.packages.some(p => KERNEL.test(p.name));
    const apps = (i.app_updates || []).filter(a => a.update);
    const what = [i.update_count ? `${plural(i.update_count, "package")} to update${i.security_count ? `, including ${i.security_count} security` : ""}` : "",
                  apps.length ? `app update: ${apps.map(a => `${a.name} ${a.current} → ${a.latest}`).join(", ")}` : ""].filter(Boolean);
    let html = `<h3 id="modalTitle">Update ${esc(i.name)} (CT ${id})</h3>
      <p class="lead">${esc(what.join(" · ") || "No updates pending.")}</p>

      <h4>1. Optional: take a snapshot first</h4>
      <p>In Proxmox: <b>CT ${id} → Snapshots → Take Snapshot</b>, name it <code>before-update</code>.
        If something breaks, select it there and click <b>Rollback</b>.</p>
      <p class="hint">Needs storage with snapshot support (ZFS, LVM-thin, Ceph). Otherwise use CT ${id} → Backup → Backup now.</p>

      <h4>2. Open the container's shell</h4>
      ${access(id)}

      <h4>3. Install the updates</h4>`;
    const selfUpdating = i.app_self || [];
    if (i.community_script && selfUpdating.length) {
      html += `<p>${where(`Inside ${i.name}`)} This container was created with a community script. Its <code>update</code> command
        only updates the OS packages:</p>${cmd(up || "update")}
        <div class="note">${selfUpdating.map(a => `<b>${esc(a.name)}</b> is not updated by the script: it updates itself.
          Open its web interface to check for and install new versions${a.latest ? ` (latest release: ${esc(a.latest)})` : ""}.`).join("<br>")}</div>`;
    } else if (i.community_script) {
      html += `<p>${where(`Inside ${i.name}`)} This container was created with a community script. Its <code>update</code> command
        updates the app${apps.length ? ` (${esc(apps.map(a => a.latest).join(", "))})` : ""} and the OS packages:</p>${cmd("update")}
        <p class="hint">It may ask questions: answer them in the console.</p>`;
      if (i.update_count && up) html += `<p class="hint">To update only the OS packages instead: <code>${esc(up)}</code></p>`;
    } else {
      html += up ? `<p>${where(`Inside ${i.name}`)}</p>${cmd(up)}`
                 : `<p>Use the container's package manager to upgrade.</p>`;
    }
    if (i.reboot_required || kernel) {
      html += `<h4>4. Restart the container</h4>
        <p>${where(`Inside ${i.name}`)} ${i.reboot_required ? "The container reports that a restart is required." : "Some updated services only reload after a restart."}</p>
        ${cmd("reboot")}`;
    }
    return html;
  }

  function host(i) {
    const kernel = i.packages.some(p => KERNEL.test(p.name));
    return `<h3 id="modalTitle">Update Proxmox host ${esc(i.name)}</h3>
      <p class="lead">${plural(i.update_count, "package")} to update${i.security_count ? `, including ${i.security_count} security` : ""}${kernel ? ", including a new kernel" : ""}.</p>

      <h4>Option A: from the web UI</h4>
      <p>Datacenter → ${esc(i.name)} → <b>Updates</b> → <b>Refresh</b>, then <b>Upgrade</b>. A window opens and runs the upgrade; answer <code>Y</code> when asked.</p>

      <h4>Option B: from the shell</h4>
      <p>${where("Proxmox Shell")}</p>
      ${cmd("apt update && apt full-upgrade -y")}
      <p class="hint">On Proxmox, always use <code>full-upgrade</code> (or <code>dist-upgrade</code>), never plain <code>apt upgrade</code>.</p>
      ${kernel || i.reboot_required ? `<h4>Then reboot the node</h4>
        <p>A new kernel is only used after a reboot. Shut down or migrate VMs and containers first, then:</p>
        ${cmd("reboot")}` : ""}`;
  }

  function docker(i) {
    const inLxc = i.vmid != null;
    const lxcName = i.lxc_name || `CT ${i.vmid}`;
    const place = inLxc ? where(`Inside ${lxcName}`) : where(`On ${i.source}`);
    let html = `<h3 id="modalTitle">Update container ${esc(i.name)}</h3>
      <p class="lead">${i.new_version && dockerUpdateLabel(i) !== "Rebuilt image"
          ? `Version ${esc(i.new_version)} is available${i.current_version ? ` (you run ${esc(i.current_version)})` : ""}.`
          : dockerUpdateLabel(i) === "Rebuilt image"
            ? `A rebuilt image of the same version (${esc(i.new_version)}) was published, usually with security fixes.`
            : `A newer image was published for <code>${esc(i.detail)}</code>.`}
        Updating means pulling the new image and recreating the container. Data in volumes and bind mounts is kept.
        ${i.release_url ? `<a href="${esc(i.release_url)}" target="_blank" rel="noopener">Read the release notes ↗</a>` : ""}</p>

      <h4>Option A: Dockhand (easiest)</h4>
      <p>${i.link ? `<a class="btn" href="${esc(i.link)}" target="_blank" rel="noopener">Open Dockhand ↗</a>` : "Open the Dockhand that manages this container."}</p>
      <p class="hint">Find the container (or its stack) and use its update / redeploy action, which pulls the new image and recreates it.</p>

      <h4>Option B: command line</h4>
      ${inLxc ? access(i.vmid) : `<p>Open a shell on <b>${esc(i.source)}</b>.</p>`}`;
    if (i.compose_dir) {
      const svc = i.compose_service ? ` ${i.compose_service}` : "";
      const members = Dashboard.stack(i);
      html += `<p>${place} This container belongs to the Compose project in <code>${esc(i.compose_dir)}</code>:</p>
        ${cmd(`cd ${arg(i.compose_dir)} && docker compose pull${svc} && docker compose up -d${svc}`)}`;
      if (members.length > 1) {
        html += `<p>To update the <b>whole ${esc(i.compose_project)} stack</b> (${members.length} containers) at once,
          which apps like Immich need so all their parts stay on the same version:</p>
          ${cmd(`cd ${arg(i.compose_dir)} && docker compose pull && docker compose up -d`)}`;
      }
      html += `
        <p class="hint">If Dockhand created this stack, the folder may only exist inside Dockhand. If the command says
          "no such file or directory", use option A.</p>`;
    } else {
      html += `<p>This container wasn't started with Docker Compose, so it has to be recreated with the same settings.
        Use option A, or recreate it the way you created it. To download the new image first:</p>
        <p>${place}</p>${cmd(`docker pull ${i.detail}`)}`;
    }
    html += `<h4>Optional: clean up old images</h4>
      <p>${place} Frees disk space taken by images no container uses anymore.</p>
      ${cmd("docker image prune -f")}`;
    return html;
  }

  function show(html) {
    $("modalBody").innerHTML = html;
    $("modal").hidden = false;
    $("modalClose").focus();
  }

  function open(item, allowUpdates) {
    if (!item) return;
    let body = item.kind === "lxc" ? lxc(item) : item.kind === "host" ? host(item) : docker(item);
    if (allowUpdates && (item.app_updates || []).some(a => a.update) && Jobs.canApply(item, "community-update")) {
      body = body.replace("</h3>", `</h3><div class="note run-note"><span>Updrift can update the app for you.</span>
        <button class="primary" data-apply-app="${esc(item.id)}">Update app</button></div>`);
    }
    if (allowUpdates && Jobs.canApply(item)) {
      // Offer to run it from the app, right under the title.
      body = body.replace("</h3>", `</h3><div class="note run-note"><span>Updrift can do this for you.</span>
        <button class="primary" data-apply="${esc(item.id)}">Update now</button></div>`);
    }
    show(body + `<p class="hint" style="margin-top:16px">When you're done, click <b>Check now</b> to refresh the dashboard.</p>`);
  }

  function close() { $("modal").hidden = true; }

  $("modalClose").addEventListener("click", close);
  $("modal").addEventListener("click", async (e) => {
    if (e.target === $("modal")) return close();
    const b = e.target.closest("[data-copy]");
    if (b) {
      const ok = await copyText(b.previousElementSibling.textContent);
      b.textContent = ok ? "Copied!" : "Select & copy";
      setTimeout(() => { b.textContent = "Copy"; }, 2000);
    }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("modal").hidden) close(); });

  return { open, show, close };
})();
