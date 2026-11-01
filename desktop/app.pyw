"""Native Windows host for the local Agent Monitor dashboard.

The EXE stays beside server/, web/, config/ and data/. Node 24+ and the
Microsoft Edge WebView2 runtime must be installed. Closing the window leaves
the backend running; stop-monitor.bat explicitly stops it.
"""
from __future__ import annotations

import ctypes
import ctypes.wintypes
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

APP_NAME = "Agent Monitor"
INSTANCE_PORT = 47822
BACKGROUND_FLAGS = getattr(subprocess, "CREATE_NO_WINDOW", 0)
DETACHED_FLAGS = (getattr(subprocess, "DETACHED_PROCESS", 0)
                  | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0))


def app_root() -> Path:
    if getattr(sys, "frozen", False):
        executable_dir = Path(sys.executable).resolve().parent
        # The build is copied to the project root, but dist/ also works.
        return executable_dir if (executable_dir / "server").is_dir() else executable_dir.parent
    return Path(__file__).resolve().parent.parent


ROOT = app_root()
DATA = ROOT / "data"


def configure_logging() -> None:
    DATA.mkdir(exist_ok=True)
    handler = RotatingFileHandler(DATA / "desktop.log", maxBytes=512_000, backupCount=2, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logging.getLogger().addHandler(handler)
    logging.getLogger().setLevel(logging.INFO)


def configured_port() -> int:
    config_path = Path(os.environ.get("AGENT_MONITOR_CONFIG", ROOT / "config" / "agent-monitor.json"))
    config = json.loads(config_path.read_text(encoding="utf-8-sig")) if config_path.exists() else {}
    port = int(os.environ.get("AGENT_MONITOR_PORT", config.get("port", 4317)))
    if not 1 <= port <= 65535:
        raise RuntimeError("Agent Monitor's configured port must be between 1 and 65535.")
    return port


def healthy(url: str) -> bool:
    try:
        # Never use workstation HTTP proxy settings for this loopback check.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(url + "/api/health", timeout=1) as response:
            return response.status == 200 and json.load(response).get("ok") is True
    except (OSError, ValueError, urllib.error.URLError):
        return False


def find_node() -> str:
    candidates = [shutil.which("node")]
    for folder in (os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)")):
        if folder:
            candidates.append(str(Path(folder) / "nodejs" / "node.exe"))
    for candidate in candidates:
        if not candidate or not Path(candidate).is_file():
            continue
        version = subprocess.check_output([candidate, "--version"], creationflags=BACKGROUND_FLAGS,
                                          text=True, timeout=5).strip()
        if int(version.lstrip("v").split(".")[0]) >= 24:
            return candidate
    raise RuntimeError("Install Node.js 24 or newer, then open Agent Monitor again.")


def ensure_backend(url: str) -> bool:
    """Return True only when this launch starts the backend."""
    if not (ROOT / "server" / "index.ts").is_file():
        raise RuntimeError("Keep Agent Monitor.exe inside the Agent Monitor folder beside server and web.")
    if not (ROOT / "web" / "dist" / "index.html").is_file():
        raise RuntimeError("The interface has not been built. Run npm.cmd run build in the Agent Monitor folder.")
    if healthy(url):
        logging.info("Reusing the running backend")
        return False
    node = find_node()
    child_env = os.environ.copy()
    for name in ("CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET",
                 "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_ENTRYPOINT"):
        child_env.pop(name, None)
    # Regular file handles and detached process flags avoid a child retaining
    # the launching terminal's stdout/stderr pipes.
    with (DATA / "server.log").open("ab") as stdout, (DATA / "server.err.log").open("ab") as stderr:
        child = subprocess.Popen([node, "server/index.ts"], cwd=ROOT, env=child_env,
                                 stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                                 creationflags=DETACHED_FLAGS, close_fds=True)
    for _ in range(100):
        if healthy(url):
            logging.info("Started the backend")
            return True
        if child.poll() is not None:
            raise RuntimeError("The backend could not start. See data/server.err.log in the Agent Monitor folder.")
        time.sleep(0.15)
    raise RuntimeError("The backend is taking too long to start. See data/server.err.log, then try again.")


def acquire_instance() -> socket.socket | None:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    try:
        listener.bind(("127.0.0.1", INSTANCE_PORT))
        listener.listen(4)
        listener.settimeout(1)
        return listener
    except OSError:
        listener.close()
        try:
            with socket.create_connection(("127.0.0.1", INSTANCE_PORT), timeout=2) as client:
                client.sendall(b"focus\n")
                if client.recv(32) == b"agent-monitor\n":
                    return None
        except OSError:
            pass
        raise RuntimeError("Agent Monitor's desktop port is busy. Close its previous window and try again.")


def read_preferences() -> dict:
    try:
        prefs = json.loads((DATA / "desktop-window.json").read_text(encoding="utf-8"))
        if not isinstance(prefs, dict):
            return {}
        return {"width": max(800, min(2400, int(prefs.get("width", 1240)))),
                "height": max(500, min(1600, int(prefs.get("height", 820)))),
                "on_top": bool(prefs.get("on_top", False))}
    except (OSError, ValueError, TypeError):
        return {}


def asset_icon() -> str | None:
    if getattr(sys, "frozen", False):
        bundled = Path(sys._MEIPASS) / "usage_widget.ico"
        if bundled.is_file():
            return str(bundled)
    sibling = ROOT.parent / "Usage-Widget" / "usage_widget.ico"
    return str(sibling) if sibling.is_file() else None


def show_error(message: str) -> None:
    if sys.platform == "win32":
        ctypes.windll.user32.MessageBoxW(None, message, APP_NAME, 0x10)
    elif sys.stderr:
        print(message, file=sys.stderr)


def main() -> int:
    configure_logging()
    listener = None
    stopped = threading.Event()
    try:
        if sys.platform == "win32":
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("Joet.AgentMonitor")
        port = configured_port()
        url = f"http://127.0.0.1:{port}"
        if "--check" in sys.argv:
            result = {"root": str(ROOT), "uiBuilt": (ROOT / "web/dist/index.html").is_file(),
                      "backendHealthy": healthy(url), "port": port, "node": find_node()}
            output = json.dumps(result, indent=2)
            (DATA / "desktop-check.json").write_text(output, encoding="utf-8")
            if sys.stdout:
                print(output)
            return 0 if result["uiBuilt"] and result["backendHealthy"] else 1
        listener = acquire_instance()
        if listener is None:
            return 0
        ensure_backend(url)
        import webview
        from webview.menu import Menu, MenuAction, MenuSeparator
        # The local dashboard owns its HTTP authorization. No Python API is
        # exposed to pages, and off-site links open in the system browser.
        webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True
        prefs = read_preferences()
        window = webview.create_window(APP_NAME, url + "/?desktop=1", width=prefs.get("width", 1240),
                                       height=prefs.get("height", 820), min_size=(800, 500),
                                       on_top=prefs.get("on_top", False), background_color="#16171a",
                                       text_select=True, zoomable=True)

        def toggle_pin():
            window.on_top = not window.on_top

        def refresh():
            # WebView2 can treat same-URL load_url calls as no navigation and
            # reuse its cached document. Give this explicit refresh a unique
            # local query so it loads the rebuilt index and hashed assets.
            window.load_url(url + f"/?desktop=1&reload={time.time_ns()}")

        def persist_window():
            try:
                (DATA / "desktop-window.json").write_text(json.dumps({"width": window.width,
                    "height": window.height, "on_top": window.on_top}, indent=2), encoding="utf-8")
            except (OSError, TypeError):
                logging.warning("Could not save window preferences")
            stopped.set()

        def focus_requests():
            while not stopped.is_set():
                try:
                    client, _ = listener.accept()
                    with client:
                        client.settimeout(2)
                        if client.recv(64).strip() == b"focus":
                            client.sendall(b"agent-monitor\n")
                            window.restore()
                            window.show()
                except socket.timeout:
                    continue
                except OSError:
                    break

        window.events.closing += persist_window
        threading.Thread(target=focus_requests, daemon=True).start()
        menu = [Menu("Window", [MenuAction("Always on top: toggle", toggle_pin),
                                MenuAction("Refresh", refresh), MenuSeparator(),
                                MenuAction("Close window (keep monitor running)", window.destroy)])]
        logging.info("Opening desktop window")
        webview.start(gui="edgechromium", debug=False, private_mode=False,
                      storage_path=str(DATA / "desktop-profile"), menu=menu, icon=asset_icon())
        logging.info("Desktop window closed; backend remains running")
        return 0
    except Exception:
        logging.exception("Desktop startup failed")
        show_error("Agent Monitor could not open.\n\n" + str(sys.exc_info()[1])
                   + "\n\nDetails: " + str(DATA / "desktop.log"))
        return 1
    finally:
        stopped.set()
        if listener is not None:
            listener.close()


if __name__ == "__main__":
    raise SystemExit(main())
