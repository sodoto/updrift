"""Runs updates (optional feature) through the update gateway and keeps their live output.

Only three actions exist, matching gateway/update-manager-apply.sh:
  upgrade         install package updates in an LXC
  reboot          restart an LXC
  compose-update  pull + recreate one Docker Compose service inside an LXC
  compose-update-stack  same for every service of that container's Compose project
  community-update  run a community-script LXC's own `update`, unattended
"""
import asyncio
import itertools
import logging
import re
from datetime import datetime, timezone

from .proxmox import APPLY_VERSION, UpdateSession

log = logging.getLogger("update-manager")

MAX_LINES = 4000
KEEP_JOBS = 30
MANAGERS = {"apt", "apk", "dnf", "pacman"}
ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
# Minimum update-gateway version per action (older nodes get a clear message instead of a refusal).
NEEDS_GATEWAY = {"compose-update-stack": 3, "community-update": 4}


class JobBusy(Exception):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def can_apply(item: dict, action: str) -> bool:
    if action == "community-update":
        return item["kind"] == "lxc" and item.get("vmid") is not None and bool(item.get("community_script"))
    if action in ("upgrade", "reboot"):
        return item["kind"] == "lxc" and item.get("vmid") is not None and (
            action == "reboot" or (item.get("manager") in MANAGERS and item.get("update_count", 0) > 0))
    if action in ("compose-update", "compose-update-stack"):
        return (item["kind"] == "docker" and item.get("vmid") is not None
                and bool(item.get("compose_dir")) and bool(item.get("container_id"))
                and (action == "compose-update" or bool(item.get("compose_project"))))
    return False


def stack_members(items: list[dict], item: dict) -> list[dict]:
    """The Docker containers of the same Compose project, in the same LXC."""
    return [i for i in items if i["kind"] == "docker" and i.get("vmid") == item.get("vmid")
            and i.get("group") == item.get("group") and i.get("compose_project") == item.get("compose_project")]


class Job:
    _ids = itertools.count(1)

    def __init__(self, item: dict, action: str, item_ids: list[str] | None = None):
        self.id = str(next(self._ids))
        self.item_id = item["id"]
        self.item_ids = item_ids or [item["id"]]  # every row this job changes (all containers of a stack)
        self.action = action
        verb = {"upgrade": "Installing updates on", "reboot": "Restarting", "compose-update": "Updating",
                "compose-update-stack": "Updating stack", "community-update": "Updating the app on"}[action]
        name = item.get("compose_project") if action == "compose-update-stack" else item["name"]
        where = f"CT {item['vmid']}" if item["kind"] == "lxc" else item.get("lxc_name") or f"CT {item['vmid']}"
        self.title = f"{verb} {name} ({where})"
        self.status = "running"  # running | succeeded | failed
        self.exit_code: int | None = None
        self.started = _now()
        self.finished: str | None = None
        self.rechecked = False
        self.done = False  # True once the job and the re-check after it are both over
        self.lines: list[str] = []

    def add(self, line: str) -> None:
        # Scripts draw progress with colors and carriage returns: keep the final text of each line.
        line = ANSI_RE.sub("", line)
        if "\r" in line:
            parts = [p for p in line.split("\r") if p.strip()]
            line = parts[-1] if parts else ""
        self.lines.append(line.rstrip())
        if len(self.lines) > MAX_LINES:
            del self.lines[: len(self.lines) - MAX_LINES]

    def summary(self) -> dict:
        return {"id": self.id, "item_id": self.item_id, "item_ids": self.item_ids, "action": self.action, "title": self.title,
                "status": self.status, "exit_code": self.exit_code, "started": self.started,
                "finished": self.finished, "rechecked": self.rechecked, "done": self.done}

    def detail(self) -> dict:
        return {**self.summary(), "output": "\n".join(self.lines)}


class JobRunner:
    def __init__(self, checker):
        self.checker = checker
        self.jobs: dict[str, Job] = {}
        self._tasks: set[asyncio.Task] = set()

    def running_for(self, item_id: str) -> Job | None:
        return next((j for j in self.jobs.values() if item_id in j.item_ids and j.status == "running"), None)

    def summaries(self) -> list[dict]:
        return [j.summary() for j in self.jobs.values()]

    def start(self, item: dict, action: str) -> Job:
        if not can_apply(item, action):
            raise ValueError("this action is not available for this item")
        members = stack_members(self.checker.state["items"], item) if action == "compose-update-stack" else [item]
        if any(self.running_for(m["id"]) for m in members):
            raise JobBusy("an update is already running for this item")
        if self.checker.running:
            raise JobBusy("a full check is running, try again when it finishes")
        node = next((n for n in self.checker.settings.proxmox if n.name == item.get("node")
                     or f"pve:{n.name}" == item.get("group")), None)
        if not node:
            raise ValueError("this Proxmox node is no longer configured")

        job = Job(item, action, [m["id"] for m in members])
        self.jobs[job.id] = job
        for old in list(self.jobs)[:-KEEP_JOBS]:
            if self.jobs[old].status != "running":
                del self.jobs[old]

        vmid = int(item["vmid"])
        if action == "upgrade":
            args = ("upgrade-lxc", vmid)
        elif action == "reboot":
            args = ("reboot-lxc", vmid)
        elif action == "compose-update-stack":
            args = ("compose-update-stack", vmid, item["container_id"])
        elif action == "community-update":
            args = ("community-update", vmid)
        else:
            args = ("compose-update", vmid, item["container_id"])
        recheck = job.item_ids
        task = asyncio.create_task(self._run(job, node, args, recheck))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        log.info("Job %s started: %s", job.id, job.title)
        return job

    async def _run(self, job: Job, node, args: tuple, recheck_ids: list[str]) -> None:
        try:
            async with UpdateSession(node) as session:
                version = await session.apply_version()
                if version is None:
                    raise RuntimeError(UpdateSession.not_authorized)
                needed = NEEDS_GATEWAY.get(args[0], 1)
                if version < needed:
                    raise RuntimeError(f"This action needs update gateway v{needed} (this node has v{version}): "
                                       "paste the update setup block from Settings on this node again")
                if version < APPLY_VERSION:
                    job.add(f"Note: this node has update gateway v{version}; output may only appear at the end. "
                            "Paste the update setup block from Settings on this node again for live output.")
                job.add(f"Updrift asks Proxmox: {' '.join(str(a) for a in args)}")
                code = await session.stream(*args, on_line=job.add)
            job.exit_code = code
            job.status = "succeeded" if code == 0 else "failed"
            if code != 0:
                job.add(f"Exited with code {code}.")
        except Exception as exc:
            job.add(f"ERROR: {str(exc) or exc.__class__.__name__}")
            job.status = "failed"
        job.finished = _now()
        log.info("Job %s %s: %s", job.id, job.status, job.title)

        # Refresh the rows so the dashboard reflects the result.
        if job.action == "reboot":
            await asyncio.sleep(15)  # let the container boot
        ok = True
        for item_id in recheck_ids:
            try:
                await self.checker.check_item(item_id)
            except Exception as exc:
                ok = False
                log.warning("Re-check of %s after job %s failed: %s", item_id, job.id, exc)
        job.rechecked = ok
        job.done = True
