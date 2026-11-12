import { app, BrowserWindow, ipcMain, screen } from "electron";
import path from "node:path";
import { fetchUpcoming } from "./calendar";
import { isRecording } from "./tray";

const LEAD_MS = 2 * 60_000; // notify 2 minutes before the meeting
const POLL_MS = 5 * 60_000;
const HORIZON_HOURS = 2;
const TOAST_W = 384;
const TOAST_H = 118;
const TOAST_TTL = 20_000;

interface Meeting {
  title: string;
  invitees: string[];
}

let mainWin: BrowserWindow | null = null;
const toastMeetings = new Map<number, Meeting>(); // webContents.id → meeting
const openToasts = new Set<number>(); // stacked-position bookkeeping

const esc = (s: string) =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );

// self-contained toast markup; talks back via the preload's toastAction
const toastHtml = (
  m: Meeting,
) => `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; user-select: none; }
  html, body { background: transparent; overflow: hidden; }
  .toast {
    display: flex; flex-direction: column; gap: 7px;
    height: ${TOAST_H - 4}px; margin: 2px;
    background: #1a1c23; border: 1px solid #2b2e39; border-radius: 14px;
    box-shadow: 0 14px 34px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.05);
    padding: 12px 14px 12px;
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    animation: in .22s cubic-bezier(.2,.7,.2,1);
  }
  @keyframes in { from { opacity: 0; transform: translateY(-8px); } }
  .head { display: flex; align-items: center; gap: 7px; }
  .lamp { width: 7px; height: 7px; border-radius: 50%; background: #ff453a;
    box-shadow: 0 0 8px #ff453a; animation: pulse 1.4s infinite; }
  @keyframes pulse { 50% { opacity: .35; } }
  .eyebrow { flex: 1; font-family: ui-monospace, Menlo, monospace; font-size: 9.5px;
    letter-spacing: .16em; color: #ff453a; }
  .x { background: none; border: none; color: #7a7d89; font-size: 13px;
    cursor: pointer; padding: 0 2px; }
  .x:hover { color: #edeef3; }
  .title { color: #edeef3; font-size: 14px; font-weight: 600; letter-spacing: -.01em;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .btns { display: flex; gap: 8px; }
  button.rec, button.open, button.dismiss {
    border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer;
    padding: 6px 13px; border: 1px solid #2b2e39;
  }
  button.rec { background: #ff453a; border-color: #c73129; color: #fff; }
  button.rec:hover { background: #ff5a50; }
  button.open { background: #20222b; color: #edeef3; }
  button.open:hover { background: #262832; }
  button.dismiss { background: none; border-color: transparent; color: #7a7d89;
    margin-left: auto; }
  button.dismiss:hover { color: #edeef3; }
</style></head><body>
  <div class="toast">
    <div class="head">
      <span class="lamp"></span>
      <span class="eyebrow">MEETING IN 2 MINUTES</span>
      <button class="x" onclick="act('dismiss')">✕</button>
    </div>
    <div class="title">${esc(m.title)}</div>
    <div class="btns">
      <button class="rec" onclick="act('start')">● Start recording</button>
      <button class="open" onclick="act('open')">Open</button>
      <button class="dismiss" onclick="act('dismiss')">Dismiss</button>
    </div>
  </div>
  <script>
    function act(a) { window.api.toastAction(a); }
    setTimeout(() => act('dismiss'), ${TOAST_TTL});
  </script>
</body></html>`;

function showToast(meeting: Meeting): void {
  // permission-free attention: our own always-on-top panel + a dock bounce -
  // native Notifications from unsigned builds get dropped silently by macOS
  app.dock?.bounce("critical");
  const wa = screen.getPrimaryDisplay().workArea;
  const toast = new BrowserWindow({
    width: TOAST_W,
    height: TOAST_H,
    x: wa.x + wa.width - TOAST_W - 12,
    y: wa.y + 12 + openToasts.size * (TOAST_H + 8),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    focusable: false, // never steals focus; buttons still click
    show: false,
    webPreferences: { preload: path.join(__dirname, "../preload/index.js") },
  });
  toast.setAlwaysOnTop(true, "screen-saver");
  toast.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  toast.setContentProtection(true); // never leaks into a shared screen
  toastMeetings.set(toast.webContents.id, meeting);
  openToasts.add(toast.id);
  const ttl = setTimeout(() => {
    if (!toast.isDestroyed()) toast.close();
  }, TOAST_TTL + 1500);
  toast.on("closed", () => {
    clearTimeout(ttl);
    openToasts.delete(toast.id);
    // visibleOnFullScreen turns the whole app into a UIElement (gone from the
    // Dock and Cmd+Tab) and Electron never turns it back; do that once the
    // last toast is gone. Doesn't activate the app or steal focus.
    if (openToasts.size === 0) void app.dock?.show();
  });
  toast.loadURL(
    "data:text/html;charset=utf-8," + encodeURIComponent(toastHtml(meeting)),
  );
  toast.once("ready-to-show", () => toast.showInactive());
}

/** Fire a sample toast now - wired to Recording → Test Meeting Reminder. */
export function testReminder(_win: BrowserWindow): void {
  showToast({ title: "Test meeting", invitees: [] });
}

/** Watches the local calendar and pops an in-app toast shortly before each
 *  meeting; Start begins recording prefilled, Open just opens the app. */
export function startMeetingReminders(win: BrowserWindow): void {
  mainWin = win;

  ipcMain.on("toast:action", (e, action: string) => {
    const meeting = toastMeetings.get(e.sender.id);
    toastMeetings.delete(e.sender.id);
    BrowserWindow.fromWebContents(e.sender)?.close();
    if (!meeting || action === "dismiss" || !mainWin) return;
    mainWin.show();
    mainWin.focus();
    mainWin.webContents.send("notify:meeting", {
      ...meeting,
      start: action === "start",
    });
  });

  const timers = new Map<string, NodeJS.Timeout>();
  const notified = new Set<string>();

  const poll = async () => {
    try {
      const res = await fetchUpcoming(HORIZON_HOURS);
      if (res.status !== "ok") return; // no access yet - next poll retries
      for (const e of res.events) {
        const key = `${e.id}|${e.start}`;
        if (notified.has(key) || timers.has(key)) continue;
        const delay = new Date(e.start).getTime() - LEAD_MS - Date.now();
        if (delay < -60_000) continue; // already well underway
        timers.set(
          key,
          setTimeout(
            () => {
              timers.delete(key);
              notified.add(key);
              if (isRecording()) return; // already capturing something
              showToast({
                title: e.title,
                invitees: e.attendees
                  .filter((a) => a.status.toLowerCase() !== "declined")
                  .map((a) => a.name.trim())
                  .filter(Boolean),
              });
            },
            Math.max(0, delay),
          ),
        );
      }
    } catch {
      /* calendar hiccups are fine; the next poll retries */
    }
  };

  poll();
  setInterval(poll, POLL_MS);

  // fire a sample right after launch when asked (used for visual testing)
  if (process.env.MS_TEST_REMINDER === "1")
    setTimeout(() => testReminder(win), 1500);
}
