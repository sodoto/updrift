<img src="app/static/logo.svg" alt="" width="64" height="64">

# Updrift

*Formerly "Update Manager".*

One dashboard that shows which of your homelab apps need updates, without checking each one by hand. It is **read-only by default**: it looks, but never installs, restarts or changes anything. You can optionally allow it to run updates for you, through a separate, tightly restricted key.

- **LXC containers (Proxmox)**: every running LXC is checked for pending OS package updates (apt, apk, dnf/yum, pacman), including security updates and pending reboots. The Proxmox host itself is checked too.
- **Docker containers**: each container's image digest is compared with the registry (Docker Hub, ghcr.io, lscr.io, quay.io, private registries). If a newer image was published for the same tag, it shows **New image**. Apply it from Dockhand: when Dockhand runs inside an LXC, it is detected automatically and each container links to its own LXC's Dockhand.
- **Community scripts**: LXCs created with the [Proxmox VE community scripts](https://community-scripts.github.io/ProxmoxVE/) are recognized, and the app they installed is compared with its latest GitHub release (the same check their `update` command does). Apps those scripts update through the OS packages are covered by the package check.
- **Automatic detection**: new LXCs and containers are picked up on every check, including **Docker running inside an LXC**. Checks run on a schedule, or whenever you click **Check now**.
- **Everything is configured in the web UI** (Settings page), with a *Test* button for each connection.
- **Notifications** (optional): ntfy, Discord or a generic webhook, sent only for *new* updates.

## How read-only is guaranteed

The app's limits are enforced by the systems it connects to, not just by the app's own code:

| Where | Enforcement |
|---|---|
| Proxmox | The app's SSH key is locked in `authorized_keys` with `command="/usr/local/bin/update-manager-ro",restrict`. Whatever the app sends, Proxmox only runs that gateway script. The script accepts a fixed list of read commands (list LXCs, check packages, `docker ps`/`inspect`), validates every argument, and refuses everything else. The key gets no shell, no port forwarding and no file transfer. |
| Docker hosts | Use a docker-socket-proxy with `POST=0`. It blocks every request that changes something (start, stop, pull, delete…). The app itself only sends GET requests. |

The only thing a check writes is the **package list cache** (`apt-get update` / `apk update`), so it knows which versions exist. It never installs anything. You can turn this off in Settings: *Refresh package lists before checking*.

The gateway script is [app/gateway/update-manager-ro.sh](app/gateway/update-manager-ro.sh); read it before installing.

## Optional: run updates from the app

Off by default. When enabled (**Settings → Run updates from the app**), rows with updates get an **Update** button that shows the live output and re-checks the row when done.

- It uses a **second SSH key**, installed with its own setup block. It is locked to [app/gateway/update-manager-apply.sh](app/gateway/update-manager-apply.sh), which allows only these actions:
  - install package updates inside an LXC (non-interactive, your config files are kept);
  - restart an LXC;
  - update one Docker Compose service inside an LXC (`docker compose pull` + `up -d`). The folder and service are read from the container's own labels on the node, never taken from the app.
  - update a whole Docker Compose stack inside an LXC (same, for every service of the project).
  - run a community-script LXC's own `update` command, unattended (only if the container has a community-scripts `update`).
- The Proxmox host itself is never updated by the app, and containers not started with Docker Compose are left to Dockhand.
- Checks keep using the read-only key.
- It requires a dashboard login, so nobody on your network can install updates without the password.
- To go back to read-only, uncheck the setting and run the revoke command shown under it on each node.

## Install in an LXC (Proxmox)

1. Create a Debian 12 LXC (unprivileged, 1 core, 512 MB RAM, 4 GB disk) and open its console.
2. Run:
   ```bash
   apt-get update && apt-get install -y curl
   bash -c "$(curl -fsSL https://raw.githubusercontent.com/sodoto/updrift/main/install-lxc.sh)"
   ```
3. Open `http://<lxc-ip>:8080` and go to **Settings**.

**Updating Updrift:** when a new version is published, the dashboard shows a banner. Click **Update now** and the page reloads on the new version a minute later. Your settings are kept. Or run this in the LXC:
```bash
update-manager-update
```
The installed version is shown at the top of the dashboard. **Update now** only updates this app: the dashboard drops a request file, and a separate systemd unit (`update-manager-selfupdate.path`) runs `update-manager-update`. You can turn it off in Settings.

## Install with Docker

```bash
git clone https://github.com/sodoto/updrift.git && cd updrift
docker compose up -d --build
```
Open `http://<host>:8080` and go to **Settings**. To also watch the Docker host this runs on, add a Docker host with URL `tcp://docker-socket-proxy:2375`. The proxy is already in the compose file, with `POST=0`.

To update: `git pull && docker compose up -d --build`.

## Connect a Proxmox node

1. In **Settings → Proxmox nodes**, open *Read-only setup* and click **Copy**.
2. In Proxmox, open **your node → Shell**, paste, and press Enter. This installs the gateway and authorizes the app's key for it only. Repeat on each node of a cluster.
3. Back in Settings, click **+ Add Proxmox node**, enter its IP, then click **Test connection**. The node's SSH host key is trusted automatically.
4. Click **Save settings**. A check starts right away.

**To revoke access:** remove the line containing `update-manager` from `/root/.ssh/authorized_keys` on the node.

## Notes

- **Ignore a container:** add the Docker label `update-manager.ignore=true`.
- **Ignore an LXC:** list its ID under *Skip these LXC IDs*.
- **Pinned and local images:** containers pinned to a digest, and locally built images, are shown as *Skipped*.
- **Where things are stored:** settings live in `config.yaml` in the data folder (`/var/lib/update-manager` in an LXC, `./data` with Docker), next to the app's SSH key. Keep that folder private.
- **Set a dashboard login** under **Settings → Dashboard login**. Without one, anyone on your network can open the dashboard and its settings. With one, the app shows its own sign-in page; the password is stored hashed and you stay signed in for 30 days. Forgot it? Delete the `ui_username` and `ui_password` lines from `config.yaml` in the data folder and restart the app.
