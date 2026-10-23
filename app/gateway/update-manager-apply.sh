#!/bin/bash
# Updrift update gateway - installed on the Proxmox host as /usr/local/bin/update-manager-apply.
#
# OPTIONAL. Only installed if you allow Updrift to run updates. It uses its own SSH key, locked to
# this script in /root/.ssh/authorized_keys:
#   command="/usr/local/bin/update-manager-apply",restrict ssh-ed25519 AAAA... update-manager-apply
# The read-only checks keep using update-manager-ro with the other key.
#
# Allowed actions (anything else is refused and logged):
#   upgrade-lxc <vmid>                 install package updates inside an LXC
#   reboot-lxc <vmid>                  restart an LXC
#   compose-update <vmid> <container>  pull + recreate one Docker Compose service inside an LXC; the folder and
#                                      service come from the container's own labels, never from the caller
#   compose-update-stack <vmid> <container>
#                                      same, for every service of that container's Compose project (the stack)
#   community-update <vmid>            run the LXC's own community-scripts `update` unattended (PHS_SILENT=1),
#                                      only if /usr/bin/update is a community-scripts one
set -u
VERSION=5

read -r -d '' UPGRADE <<'EOF'
# um-upgrade
export LC_ALL=C DEBIAN_FRONTEND=noninteractive
# Programs buffer their output when it goes to a pipe; stdbuf (coreutils) makes it line by line, so it shows live.
lb=""; command -v stdbuf >/dev/null 2>&1 && lb="stdbuf -oL -eL"
run() { echo "+ $*"; $lb "$@"; }
if command -v apt-get >/dev/null 2>&1; then
  run apt-get update && run apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold dist-upgrade
elif command -v apk >/dev/null 2>&1; then
  run apk update && run apk upgrade
elif command -v dnf >/dev/null 2>&1; then
  run dnf -y upgrade
elif command -v yum >/dev/null 2>&1; then
  run yum -y update
elif command -v pacman >/dev/null 2>&1; then
  run pacman -Syu --noconfirm
else
  echo "No supported package manager found."; exit 3
fi
EOF

read -r -d '' COMPOSE <<'EOF'
# um-compose-update
set -f
cid="$1"
mode="${2:-service}"  # service: only this container's service | stack: the whole Compose project
label() {
  v=$(docker inspect -f "{{ index .Config.Labels \"$1\" }}" "$cid" 2>/dev/null) || return 1
  [ "$v" = "<no value>" ] && v=""
  printf '%s' "$v"
}
docker inspect "$cid" >/dev/null 2>&1 || { echo "Container $cid not found."; exit 3; }
dir=$(label com.docker.compose.project.working_dir)
svc=$(label com.docker.compose.service)
proj=$(label com.docker.compose.project)
files=$(label com.docker.compose.project.config_files)
if [ -z "$dir" ] || [ -z "$svc" ]; then
  echo "This container was not started with Docker Compose. Update it from Dockhand."; exit 3
fi
if [ ! -d "$dir" ]; then
  echo "The Compose folder $dir does not exist in this container (the stack may be managed by Dockhand)."
  echo "Update it from Dockhand."; exit 3
fi
if docker compose version >/dev/null 2>&1; then dc="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then dc="docker-compose"
else echo "Docker Compose is not installed."; exit 3; fi
cd "$dir" || exit 3
set -- -p "$proj"
old_ifs=$IFS; IFS=,
for f in $files; do [ -f "$f" ] && set -- "$@" -f "$f"; done
IFS=$old_ifs
if [ "$mode" = stack ]; then svc=""; fi  # no service name: the whole project
echo "+ cd $dir"
echo "+ $dc $* pull $svc"
$dc "$@" pull $svc || exit $?
echo "+ $dc $* up -d $svc"
$dc "$@" up -d $svc
EOF

read -r -d '' CSUPDATE <<'EOF'
# um-community-update
if [ ! -f /usr/bin/update ] || ! grep -q "community-scripts/ProxmoxVE" /usr/bin/update 2>/dev/null; then
  echo "This container was not created with a community script (no community-scripts /usr/bin/update)."; exit 3
fi
# PHS_SILENT=1 is the scripts' own unattended mode (no menu). No input is given: a script that asks a
# question stops instead of waiting forever. stdbuf makes the output show up live.
# TERM=xterm: the scripts run `clear`, which fails (and stops the update) when TERM is unset or "dumb";
# with xterm it only prints a few escape codes, which Updrift strips from the output.
export PHS_SILENT=1 TERM=xterm
lb=""; command -v stdbuf >/dev/null 2>&1 && lb="stdbuf -oL -eL"
to=""; command -v timeout >/dev/null 2>&1 && to="timeout 45m"
echo "+ PHS_SILENT=1 update"
exec $to $lb bash /usr/bin/update </dev/null
EOF

CMD="${SSH_ORIGINAL_COMMAND:-}"

deny() {
  logger -t update-manager-apply "refused: $CMD" 2>/dev/null
  echo "update-manager-apply: refused: $CMD" >&2
  exit 126
}

[[ "$CMD" == *$'\n'* ]] && deny
read -r -a ARGS <<< "$CMD"
N=${#ARGS[@]}

need_vmid() { [[ "${ARGS[1]:-}" =~ ^[0-9]{1,9}$ ]] || deny; VMID=${ARGS[1]}; }

case "${ARGS[0]:-}" in
  version)
    [ "$N" -eq 1 ] || deny
    echo "update-manager-apply $VERSION" ;;
  upgrade-lxc)
    [ "$N" -eq 2 ] || deny
    need_vmid
    logger -t update-manager-apply "upgrade-lxc $VMID" 2>/dev/null
    exec pct exec "$VMID" -- sh -c "$UPGRADE" ;;
  reboot-lxc)
    [ "$N" -eq 2 ] || deny
    need_vmid
    logger -t update-manager-apply "reboot-lxc $VMID" 2>/dev/null
    echo "+ pct reboot $VMID"
    exec pct reboot "$VMID" ;;
  compose-update)
    [ "$N" -eq 3 ] || deny
    need_vmid
    [[ "${ARGS[2]}" =~ ^[0-9a-f]{12,64}$ ]] || deny
    logger -t update-manager-apply "compose-update $VMID ${ARGS[2]}" 2>/dev/null
    exec pct exec "$VMID" -- sh -c "$COMPOSE" sh "${ARGS[2]}" service ;;
  compose-update-stack)
    [ "$N" -eq 3 ] || deny
    need_vmid
    [[ "${ARGS[2]}" =~ ^[0-9a-f]{12,64}$ ]] || deny
    logger -t update-manager-apply "compose-update-stack $VMID ${ARGS[2]}" 2>/dev/null
    exec pct exec "$VMID" -- sh -c "$COMPOSE" sh "${ARGS[2]}" stack ;;
  community-update)
    [ "$N" -eq 2 ] || deny
    need_vmid
    logger -t update-manager-apply "community-update $VMID" 2>/dev/null
    exec pct exec "$VMID" -- sh -c "$CSUPDATE" ;;
  *)
    deny ;;
esac
