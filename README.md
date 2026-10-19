# Law Firm Launcher

A small desktop app for the office host machine. It starts, stops, and updates
the **Law Firm Case Management** server — no command line needed.

## What it does

- **Start / Stop Server** — one big button. That's it.
- **Open in Browser** — opens the app at http://localhost:5000
- **Status display** — green dot = running, red dot = stopped, plus the server version
- **Auto-update check** — checks GitHub every 6 hours. When a new server version
  is out, a gold banner appears with an **Update Now** button. The update backs
  up nothing (it doesn't need to) — the server installer never touches the
  `instance/` folder where the database, keys, documents, and backups live.
- **System tray** — close the window and the launcher keeps running in the tray.
  Right-click for Start / Stop / Open / Quit.
- **Start with Windows** — optional checkboxes in Settings: launch the launcher
  on boot, and optionally start the server too.
- **Server log** — expandable view of the last 50 lines of server output, for
  troubleshooting.

## Install

Download `LawFirmLauncherSetup.exe` from the
[Releases page](https://github.com/needhamgarrett95-ux/farhollow-lawfirm-launcher/releases)
and run it. On first launch, it looks for the server in
`C:\Program Files\Law Firm Case Management\LawFirmServer.exe`. If your server
is somewhere else, use **Settings → Browse** to point at it.

## For developers

```bash
npm install
npm start        # run the launcher in dev
npm run dist     # build the Windows installer (needs Windows or the GH Action)
```

Cutting a release: `git tag v1.0.0 && git push origin v1.0.0` — the
`Build launcher` workflow builds the installer and attaches it to the release.

## Notes

- The launcher does **not** bundle the server. It finds and manages an existing
  `LawFirmServer.exe` install (from the
  [farhollow-lawfirm](https://github.com/needhamgarrett95-ux/farhollow-lawfirm)
  releases).
- Quitting the launcher does **not** stop the server — the server is the
  office's data host. Stopping it is always an explicit button press.
- The launcher itself is not auto-updated (it's a tiny utility); the server it
  manages is.
