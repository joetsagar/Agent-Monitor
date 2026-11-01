# Agent Monitor desktop

Double-click **Agent Monitor.exe** in the project folder, or **launch-app.bat**.
It opens a normal resizable Windows app with the live dashboard and usage sidebar.
Launching it again brings the existing app forward. The **Window** menu toggles
always-on-top mode or refreshes the view. Window size, pin state and cleared
session choices are remembered.

The app starts the local backend hidden if necessary and reuses it when already
running. Closing its window leaves monitoring and agent work running. Use the
existing **stop-monitor.bat** to stop the backend explicitly.

This build bundles Python, pywebview and the original Usage-Widget icon. Keep
the EXE beside `server`, `web`, `config` and `data`; it is a workspace app rather
than a standalone copy-anywhere package. It needs **Node.js 24+**, installed
project dependencies, and **Microsoft Edge WebView2 Runtime**. The usage bridge
also uses the Python installation and sibling Usage-Widget source described in
the main project README. No API credentials are bundled or copied by the app.

Build again with **build-desktop.bat**. For a source launch, install
`desktop/requirements.txt` and run `pythonw desktop/app.pyw`.

Startup diagnostics go to `data/desktop.log`. Run
`python desktop/app.pyw --check` for a non-GUI health check; results are also
saved in `data/desktop-check.json`. The executable accepts `--check` too.

The small native host uses [pywebview's EdgeChromium renderer](https://pywebview.flowrl.com/guide/web_engine)
and [window/menu API](https://pywebview.flowrl.com/api/).
