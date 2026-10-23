# Changelog

## 1.13.0 (2026-10-22)
- **Update app** for community-script LXCs: runs the container's own community-scripts `update` unattended
  (their built-in silent mode), with live output, then re-checks the row. Shown when an app update is found.
  The confirmation lists the versions and the exact command.
- Scripts that ask questions during an update stop with an error instead of waiting (13 of 633 scripts do).
- Job output is cleaned of colors and redrawn progress lines.
- Update gateway v4: paste the update setup block from Settings on each node again.

## 1.12.0 (2026-10-16)
- Docker updates show versions: "v3.3.2 → v3.3.3" instead of "New image", read from the running image and
  the new one (the standard org.opencontainers.image.version label). "Rebuilt image" when the version is
  the same but the image changed (usually base-image security fixes).
- **Release notes ↗** link on Docker updates: the exact GitHub release when it exists, otherwise the
  project's releases page. Details also link to the source code and, for Docker Hub, the image's tags page.
- Versions also appear in the ⓘ window, the update confirmations and notifications.

## 1.11.1 (2026-10-16)
- The GitHub repository is now github.com/sodoto/updrift (the old address redirects). Updrift and its
  installer now use the new address, and updating an existing install switches it over automatically.

## 1.11.0 (2026-10-16)
- New name and icon: Update Manager is now **Updrift**, with a radar logo (in the header, the sign-in page and
  the browser tab). Nothing to reconfigure: the service, folders and Proxmox gateway scripts keep their names.

## 1.10.0 (2026-10-15)
- Docker Compose stacks: containers of the same Compose project are grouped under a stack header
  ("immich · 4 containers · 2 to update").
- **Update stack** button: `docker compose pull` + `up -d` for the whole project at once, which apps like
  Immich need so all their parts stay on the same version. The confirmation lists every container.
  Needs update gateway v3: paste the update setup block from Settings on each node again.
- The ⓘ window also shows the command to update a whole stack by hand.
- Registry logins: if a saved login is rejected, public images are still checked anonymously, and the
  error now says which login in Settings was rejected.

## 1.9.2 (2026-10-15)
- Community scripts: recently installed LXCs (e.g. Paperless-ngx) were not detected. Their new
  `/usr/bin/update` names the script through UPDATE_SCRIPT_NAME instead of a ct/<app>.sh address.
  Both formats are now recognized. With the older gateway, the container name is used as a fallback.
- Read-only gateway v4: sends the relevant lines of /usr/bin/update so future format changes can be
  handled in the app. Paste the read-only setup block again on each node (the app reminds you).

## 1.9.1 (2026-10-15)
- Community scripts: apps that update themselves (e.g. AdGuard Home) were wrongly described as "updated
  through the OS packages". Their script's `update` only updates the OS; the app is now shown as updating
  itself (from its own web interface), with the latest release for comparison.

## 1.9.0 (2026-10-15)
- Community scripts: LXCs created with the Proxmox VE community scripts are detected ("Helper script" badge),
  and their app version is compared with the latest GitHub release, like the script's own `update` does
  (including versions pinned by the script maintainers). "App update" badge, details table, notifications,
  and instructions to run `update` in the container's console.
- Optional GitHub token in Settings (GitHub allows 60 version lookups per hour without one; results are cached 6 hours).
- Read-only gateway v3: paste the read-only setup block from Settings on each node again to enable this.

## 1.8.0 (2026-10-15)
- The confirmation before an update shows exactly what will run: the action Update Manager asks Proxmox
  for, and the commands Proxmox runs inside the container.
- Update output is now really live. apt/dpkg held their output back when writing to a pipe; the update
  gateway now runs them line-buffered (stdbuf) and prints each command (`+ apt-get update`) before running it.
- Elapsed time is shown while an update runs.
- Update gateway v2: paste the update setup block from Settings on each node again (the app reminds you).

## 1.7.0 (2026-10-15)
- Built-in sign-in page instead of the browser's login pop-up, with a Log out button.
  You stay signed in for 30 days; changing the password signs out every other browser.
- The dashboard password is now stored hashed (existing passwords are converted automatically).
- Repeated wrong passwords lock sign-in for 60 seconds.
- Confirmations and messages use the app's own windows instead of the browser's pop-ups.

## 1.6.0 (2026-10-15)
- Optional: run updates from the app. An **Update** button installs package updates in an LXC or updates a
  Docker Compose container, with live output, then re-checks the row. Offers to restart the LXC when needed.
- Uses a second SSH key locked to a new gateway (`update-manager-apply`) that only allows those actions.
  Off by default, requires a dashboard login. Paste the update setup block from Settings on each node.
- The browser always loads the current scripts after an update (no more stale cached pages).

## 1.5.0 (2026-10-15)
- ↻ button on every row to check just that item again: an LXC (with the Docker containers inside it),
  a single Docker container, or the Proxmox host. Handy right after updating something.

## 1.4.1 (2026-10-15)
- Update instructions only mention the Proxmox Console to open a container's shell (no SSH).

## 1.4.0 (2026-10-15)
- Click the version number in the header to check GitHub for a new version right away.
- Update instructions now run inside the container (its console or SSH, with its IP address)
  instead of through the Proxmox Shell. Snapshots are taken from the Proxmox web UI.

## 1.3.0 (2026-10-15)
- Update Manager tells you when a new version is out: a banner on the dashboard with "What's new".
- "Update now" button updates Update Manager itself from the dashboard (LXC installs). It only updates
  this app, never your containers or Proxmox. Can be turned off in Settings.

## 1.2.0 (2026-10-15)
- "How to update" button (i) on every item with updates: step-by-step instructions with copyable commands
  for LXCs (snapshot, upgrade, restart), the Proxmox host, and Docker containers (Dockhand or docker compose).
- Dashboard groups can be collapsed; the app remembers which ones. "Collapse all / Expand all" button.

## 1.1.0 (2026-10-15)
- Dockhand running inside each LXC is detected automatically; containers link to their own LXC's Dockhand.
- Read-only gateway v2 (adds `lxc-interfaces` to find an LXC's IP). Paste the setup block from Settings again on each node.
- The dashboard shows a real version number.

## 1.0.0 (2026-10-15)
- First release: read-only update dashboard for Proxmox LXCs (packages) and Docker containers (new images).
- Read-only SSH gateway on Proxmox, settings page, scheduled checks, ntfy / Discord / webhook notifications.
