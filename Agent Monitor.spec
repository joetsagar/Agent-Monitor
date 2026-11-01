# Build from the Agent Monitor folder: python -m PyInstaller --noconfirm "Agent Monitor.spec"
from pathlib import Path
from PyInstaller.utils.hooks import collect_all

root = Path(SPECPATH)
webview_datas, webview_binaries, webview_imports = collect_all("webview")
icon = root.parent / "Usage-Widget" / "usage_widget.ico"
a = Analysis(
    [str(root / "desktop" / "app.pyw")],
    pathex=[str(root / "desktop")],
    binaries=webview_binaries,
    datas=webview_datas + [(str(icon), ".")],
    hiddenimports=webview_imports + ["clr", "pythonnet", "clr_loader"],
    hookspath=[], hooksconfig={}, runtime_hooks=[],
    excludes=["PyQt5", "PyQt6", "PySide2", "PySide6", "cefpython3", "gi"],
    noarchive=False, optimize=0,
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, a.binaries, a.datas, [], name="Agent Monitor", debug=False,
          bootloader_ignore_signals=False, strip=False, upx=True,
          console=False, disable_windowed_traceback=False, icon=str(icon))
