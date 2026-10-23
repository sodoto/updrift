"""SSH access to a Proxmox VE node through the read-only gateway (see gateway/update-manager-ro.sh).

The app never sends shell code: only the gateway's fixed verbs, which the node validates.
"""
import asyncio
import json
import re
from typing import Callable

import asyncssh

from .config import ProxmoxNode
from .keys import ensure_app_key, ensure_update_key

GATEWAY_VERSION = 4  # version of gateway/update-manager-ro.sh this app ships
APPLY_VERSION = 4  # version of gateway/update-manager-apply.sh this app ships


class ProxmoxSession:
    not_authorized = "SSH key not authorized on this node - run the setup snippet from Settings"

    @staticmethod
    def _key() -> str:
        return str(ensure_app_key())

    def __init__(self, node: ProxmoxNode, verify_host_key: bool = True):
        self.node = node
        self.verify_host_key = verify_host_key
        self.conn: asyncssh.SSHClientConnection | None = None
        self.gateway = 0

    async def __aenter__(self) -> "ProxmoxSession":
        known_hosts = None  # no verification unless a host key is trusted in the settings
        if self.verify_host_key and self.node.host_key:
            known_hosts = ([asyncssh.import_public_key(self.node.host_key)], [], [])
        try:
            self.conn = await asyncssh.connect(
                self.node.host, port=self.node.port, username=self.node.username,
                client_keys=[self._key()], agent_path=None, known_hosts=known_hosts,
                preferred_auth="publickey", connect_timeout=15,
            )
        except asyncssh.HostKeyNotVerifiable:
            raise RuntimeError("SSH host key does not match the trusted key in Settings") from None
        except asyncssh.PermissionDenied:
            raise RuntimeError(self.not_authorized) from None
        return self

    async def __aexit__(self, *exc):
        if self.conn:
            self.conn.close()
            await self.conn.wait_closed()

    def host_key(self) -> str | None:
        key = self.conn.get_server_host_key() if self.conn else None
        return key.export_public_key().decode().strip() if key else None

    async def call(self, *args, timeout: int = 300) -> tuple[int, str, str]:
        result = await self.conn.run(" ".join(str(a) for a in args), check=False, timeout=timeout)
        code, out, err = result.exit_status or 0, str(result.stdout or ""), str(result.stderr or "")
        if code == 126 and "update-manager-ro: refused" in err:
            raise RuntimeError(f"read-only gateway refused: {args[0]}")
        return code, out, err

    async def gateway_version(self) -> int | None:
        _, out, _ = await self.call("version", timeout=30)
        match = re.match(r"update-manager-ro (\d+)", out.strip())
        return int(match.group(1)) if match else None

    async def require_gateway(self) -> int:
        version = await self.gateway_version()
        if version is None:
            raise RuntimeError("read-only gateway not installed on this node - run the setup snippet from Settings")
        self.gateway = version
        return version

    async def list_lxc(self) -> list[dict]:
        code, out, err = await self.call("list-lxc")
        if code != 0:
            raise RuntimeError(f"listing LXCs failed: {err.strip() or out.strip()}")
        return sorted((c for c in json.loads(out) if not c.get("template")), key=lambda c: int(c["vmid"]))

    async def lxc_ip(self, vmid: int) -> str | None:
        """First IPv4 address of a running LXC (needs gateway v2)."""
        if self.gateway < 2:
            return None
        try:
            code, out, _ = await self.call("lxc-interfaces", int(vmid), timeout=30)
            if code != 0:
                return None
            for iface in json.loads(out):
                inet = iface.get("inet") or ""
                if iface.get("name") != "lo" and inet and not inet.startswith("127."):
                    return inet.split("/")[0]
        except Exception:
            return None
        return None

    async def check_host(self, refresh: bool) -> tuple[int, str, str]:
        return await self.call("check-host", "refresh" if refresh else "no-refresh")

    async def check_lxc(self, vmid: int, refresh: bool) -> tuple[int, str, str]:
        return await self.call("check-lxc", int(vmid), "refresh" if refresh else "no-refresh")

    def docker_runner(self, vmid: int):
        async def run(action: str, ids: list[str]):
            return await self.call(f"docker-{action}", int(vmid), *ids, timeout=120)
        return run


class UpdateSession(ProxmoxSession):
    """Connection with the optional update key, locked on the node to gateway/update-manager-apply.sh."""
    not_authorized = ("update access is not installed on this node - paste the update setup block "
                      "from Settings > Run updates on this node")

    @staticmethod
    def _key() -> str:
        return str(ensure_update_key())

    async def apply_version(self) -> int | None:
        result = await self.conn.run("version", check=False, timeout=30)
        match = re.match(r"update-manager-apply (\d+)", str(result.stdout or "").strip())
        return int(match.group(1)) if match else None

    async def stream(self, *args, on_line: Callable[[str], None], timeout: int = 3600) -> int:
        """Runs a gateway action, passing each output line (stdout and stderr) to on_line as it arrives."""
        process = await self.conn.create_process(" ".join(str(a) for a in args), stderr=asyncssh.STDOUT)

        async def pump():
            async for line in process.stdout:
                on_line(line.rstrip())
            await process.wait()

        try:
            await asyncio.wait_for(pump(), timeout)
        except asyncio.TimeoutError:
            process.kill()
            raise RuntimeError(f"timed out after {timeout // 60} minutes") from None
        return process.exit_status if process.exit_status is not None else -1
