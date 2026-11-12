import {
  app,
  BrowserWindow,
  Menu,
  protocol,
  session,
  systemPreferences,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { loadSettings, registerIpc, restoreOutputDevice } from "./ipc";
import { serveMedia } from "./media";
import { ensureMultiOutput } from "./audio";
import { audioEnsure, captureMode } from "./audiosetup";
import { startMeetingReminders, testReminder } from "./reminders";
import { createTray } from "./tray";

// keep userData at ~/Library/Application Support/meeting-scribe in both dev and
// packaged builds (productName would otherwise fork settings/models)
app.setName("meeting-scribe");

protocol.registerSchemesAsPrivileged([
  // standard: without it Chromium can't seek a custom-scheme stream even with
  // correct 206 responses (electron/electron#38749)
  {
    scheme: "media",
    privileges: { standard: true, stream: true, supportFetchAPI: true },
  },
]);

let win: BrowserWindow | null = null;
let quitting = false;

const boundsPath = () =>
  path.join(app.getPath("userData"), "window-state.json");

function savedBounds(): Partial<Electron.Rectangle> {
  try {
    return JSON.parse(fs.readFileSync(boundsPath(), "utf8"));
  } catch {
    return {};
  }
}

function buildAppMenu(w: BrowserWindow): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      {
        label: "Recording",
        submenu: [
          {
            label: "Start / Stop Recording",
            accelerator: "CmdOrCtrl+R",
            click: () => {
              w.show();
              w.webContents.send("tray:command", "toggle");
            },
          },
          { type: "separator" },
          {
            label: "Test Meeting Reminder",
            click: () => testReminder(w),
          },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1080,
    height: 760,
    ...savedBounds(),
    minWidth: 860,
    minHeight: 600,
    title: "Meeting Scribe",
    backgroundColor: "#101014",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
    },
  });

  // invisible to screen sharing, recorders and screenshots - a meeting tool
  // must never leak itself into the meeting (Settings → Privacy to disable)
  win.setContentProtection(loadSettings().hideFromCapture !== false);

  registerIpc(win);
  createTray(win);
  buildAppMenu(win);
  startMeetingReminders(win);

  // closing the window keeps the app alive in the menu bar; Quit lives in the tray
  win.on("close", (e) => {
    try {
      fs.writeFileSync(boundsPath(), JSON.stringify(win!.getBounds()));
    } catch {
      /* bounds persistence is best-effort */
    }
    if (!quitting) {
      e.preventDefault();
      win?.hide();
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(async () => {
  // media://rec/<id>/<file> serves recordings from the recordings dir only.
  // The id sits in the path: a standard scheme lowercases the host.
  protocol.handle("media", (req) =>
    serveMedia(
      loadSettings().recordingsDir,
      decodeURIComponent(new URL(req.url).pathname),
      req.headers.get("range"),
    ),
  );

  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === "media");
  });

  // Meeting audio via a direct system-audio tap. Granting audio 'loopback' with
  // NO video source keeps this in the system-audio-recording permission class
  // only: no screen-recording grant, no capture indicator, and none of the
  // periodic screen-recording re-consent macOS applies to screen capture
  // (verified - the tap still works with screen recording revoked). Local
  // playback is unaffected, so the user still hears the meeting.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => callback({ audio: "loopback" }),
    { useSystemPicker: false },
  );

  if (systemPreferences.getMediaAccessStatus("microphone") !== "granted") {
    await systemPreferences.askForMediaAccess("microphone");
  }

  // BlackHole route only: auto-create / self-heal the multi-output device.
  // The system tap needs none of this.
  const s = loadSettings();
  if (captureMode(s) === "blackhole") {
    if (s.onboardedAt && s.outputDevice) void audioEnsure(s);
    else if (s.outputDevice === "Meeting Scribe")
      void ensureMultiOutput(s.outputDevice);
  }

  createWindow();

  // reopen on a real dock-icon click only. hasVisibleWindows is true when a
  // reminder toast is on screen, so clicking the toast (which activates the
  // app) no longer drags the main window open behind it.
  app.on("activate", (_e, hasVisibleWindows) => {
    if (hasVisibleWindows) return;
    if (win) win.show();
    else createWindow();
  });
});

app.on("before-quit", () => {
  quitting = true;
});

app.on("window-all-closed", () => {
  if (quitting) app.quit();
});

app.on("will-quit", (e) => {
  // restore the user's output device if the app quits mid-recording
  e.preventDefault();
  restoreOutputDevice().finally(() => app.exit(0));
});
