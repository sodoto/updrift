// Running updates from the app (optional feature) and showing their live output.
const Jobs = (() => {
  const MANAGERS = ["apt", "apk", "dnf", "pacman"];
  let current = null;  // job id shown in the modal
  let timer;

  function canApply(i, action = i.kind === "docker" ? "compose-update" : "upgrade") {
    if (action === "upgrade") return i.kind === "lxc" && i.vmid != null && MANAGERS.includes(i.manager) && i.update_count > 0;
    if (action === "reboot") return i.kind === "lxc" && i.vmid != null;
    if (action === "compose-update") return i.kind === "docker" && i.vmid != null && !!i.compose_dir && !!i.container_id;
    if (action === "community-update") return i.kind === "lxc" && i.vmid != null && !!i.community_script;
    if (action === "compose-update-stack")
      return i.kind === "docker" && i.vmid != null && !!i.compose_dir && !!i.container_id && !!i.compose_project;
    return false;
  }

  // What will run, mirroring gateway/update-manager-apply.sh (keep in sync).
  const UPGRADE = {
    apt: ["apt-get update",
          "apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold dist-upgrade"],
    apk: ["apk update", "apk upgrade"],
    dnf: ["dnf -y upgrade"],
    pacman: ["pacman -Syu --noconfirm"],
  };

  function commands(i, action) {
    if (action === "community-update") return [
      { label: "Updrift asks Proxmox:", cmd: `community-update ${i.vmid}` },
      { label: `Proxmox runs inside CT ${i.vmid} (${i.name}):`, cmd: "PHS_SILENT=1 update" },
    ];
    if (action === "reboot") return [
      { label: "Updrift asks Proxmox:", cmd: `reboot-lxc ${i.vmid}` },
      { label: "Proxmox runs:", cmd: `pct reboot ${i.vmid}` },
    ];
    if (action === "community-update") return i.kind === "lxc" && i.vmid != null && !!i.community_script;
    if (action === "compose-update-stack") {
      const p = ` -p ${i.compose_project}`;
      return [
        { label: "Updrift asks Proxmox:", cmd: `compose-update-stack ${i.vmid} ${i.container_id.slice(0, 12)}` },
        { label: `Proxmox runs inside ${i.lxc_name || `CT ${i.vmid}`}:`,
          cmd: `cd ${i.compose_dir}\ndocker compose${p} pull\ndocker compose${p} up -d` },
      ];
    }
    if (action === "compose-update") {
      const p = i.compose_project ? ` -p ${i.compose_project}` : "";
      const svc = i.compose_service || "";
      return [
        { label: "Updrift asks Proxmox:", cmd: `compose-update ${i.vmid} ${i.container_id.slice(0, 12)}` },
        { label: `Proxmox runs inside ${i.lxc_name || `CT ${i.vmid}`}:`,
          cmd: `cd ${i.compose_dir}\ndocker compose${p} pull ${svc}\ndocker compose${p} up -d ${svc}` },
      ];
    }
    return [
      { label: "Updrift asks Proxmox:", cmd: `upgrade-lxc ${i.vmid}` },
      { label: `Proxmox runs inside CT ${i.vmid} (${i.name}):`, cmd: (UPGRADE[i.manager] || []).join("\n") },
    ];
  }

  function confirmation(i, action) {
    if (action === "community-update") {
      const apps = (i.app_updates || []).filter(a => a.update);
      return {
        title: `Update the app on ${i.name}?`, ok: "Update app",
        message: (apps.length ? apps.map(a => `• ${a.name}: ${a.current} → ${a.latest}`).join("\n") + "\n\n" : "")
          + `Runs the container's own community-script update (downloaded from GitHub), unattended, `
          + `exactly like typing update in its console. It may restart the app and update its data.`
          + `\n\nA few scripts ask questions during an update: those stop with an error, then run update in the console instead.`,
      };
    }
    if (action === "reboot") return {
      title: `Restart ${i.name}?`, ok: "Restart", danger: true,
      message: `CT ${i.vmid} will restart now. Its services will be unavailable for a moment.`,
    };
    if (action === "community-update") return i.kind === "lxc" && i.vmid != null && !!i.community_script;
    if (action === "compose-update-stack") {
      const members = Dashboard.stack(i);
      const state = (m) => m.status === "update_available" ? dockerUpdateLabel(m)
        : m.status === "skipped" ? `skipped${m.note ? ` (${m.note})` : ""}` : m.status === "error" ? "error" : "up to date";
      return {
        title: `Update the ${i.compose_project} stack?`, ok: "Update stack",
        message: `Pulls the images of all ${members.length} containers of the stack and recreates the ones that changed:\n`
          + members.map(m => `• ${m.name}: ${state(m)}`).join("\n")
          + `\n\nData in volumes is kept. Check the app's release notes for breaking changes first.`,
      };
    }
    if (action === "compose-update") return {
      title: `Update ${i.name}?`, ok: "Update",
      message: `${i.new_version ? `${dockerUpdateLabel(i)}.\n\n` : ""}Pulls the new image for ${i.detail} and recreates the container `
        + `(docker compose pull + up -d in ${i.compose_dir}).\n\nData in volumes is kept.`,
    };
    return {
      title: `Update ${i.name}?`, ok: "Install updates",
      message: `Installs ${i.update_count} package update${i.update_count === 1 ? "" : "s"} inside CT ${i.vmid}.`
        + `\n\nRuns a non-interactive upgrade. Your configuration files are kept.`,
    };
  }

  async function start(item, action) {
    action = action || (item.kind === "docker" ? "compose-update" : "upgrade");
    if (!(await UI.confirm({ ...confirmation(item, action), commands: commands(item, action) }))) return;
    try {
      const job = await api("api/jobs", "POST", { id: item.id, action });
      view(job.id);
      Dashboard.load();
    } catch (e) {
      UI.alert("Could not start the update", e.message);
    }
  }

  function view(jobId) {
    current = jobId;
    HowTo.show(`<h3 id="modalTitle">…</h3>
      <p class="lead" id="jobStatus"><span class="spin"></span> Starting…</p>
      <div class="cmd"><pre id="jobOutput" class="job-output"></pre></div>
      <div id="jobActions"></div>`);
    poll();
  }

  async function poll() {
    clearTimeout(timer);
    if (current === null || $("modal").hidden || !$("jobOutput")) { current = null; return; }
    let job;
    try { job = await api(`api/jobs/${current}`); } catch (e) {
      $("jobStatus").textContent = `Lost track of this job: ${e.message}`;
      return;
    }
    $("modalTitle").textContent = job.title;
    const out = $("jobOutput");
    const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 30;
    out.textContent = job.output || "";
    if (atBottom) out.scrollTop = out.scrollHeight;

    if (job.status === "running") {
      const secs = Math.max(0, Math.round((Date.now() - new Date(job.started)) / 1000));
      const elapsed = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
      $("jobStatus").innerHTML = `<span class="spin"></span> Running for ${elapsed}… you can close this window, it keeps going.`;
      timer = setTimeout(poll, 1000);
      return;
    }
    if (!job.done) {
      $("jobStatus").innerHTML = `<span class="spin"></span> Done, checking the result…`;
      timer = setTimeout(poll, 1500);
      return;
    }
    $("jobStatus").innerHTML = job.status === "succeeded"
      ? `<span class="ok-text">✓ Done.</span> The dashboard has been refreshed.`
      : `<span class="bad-text">✗ Failed${job.exit_code != null ? ` (exit code ${job.exit_code})` : ""}.</span> See the output above.`;
    await Dashboard.load();
    const item = Dashboard.item(job.item_id);
    if (job.status === "succeeded" && job.action === "upgrade" && item && item.reboot_required) {
      $("jobActions").innerHTML = `<p>The container says a restart is needed to finish the update.</p>
        <button class="primary" data-job-reboot="${esc(item.id)}">Restart ${esc(item.name)} now</button>`;
    }
  }

  document.addEventListener("click", (e) => {
    const r = e.target.closest("[data-job-reboot]");
    if (r) { const item = Dashboard.item(r.dataset.jobReboot); if (item) start(item, "reboot"); return; }
    const v = e.target.closest("[data-job-view]");
    if (v) { view(v.dataset.jobView); return; }
    const ap = e.target.closest("[data-apply-app]");
    if (ap) { const item = Dashboard.item(ap.dataset.applyApp); if (item) start(item, "community-update"); return; }
    const st = e.target.closest("[data-apply-stack]");
    if (st) { const item = Dashboard.item(st.dataset.applyStack); if (item) start(item, "compose-update-stack"); return; }
    const a = e.target.closest("[data-apply]");
    if (a) { const item = Dashboard.item(a.dataset.apply); if (item) start(item); }
  });

  return { canApply, start, view };
})();
