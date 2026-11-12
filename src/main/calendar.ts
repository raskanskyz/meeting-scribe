import { execFile } from "node:child_process";
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { CalendarEvent, CalendarResult } from "../shared/types";

// mirrors sidecar.ts resolution: dev reads from the project tree, packaged
// reads the binary copied into Resources by electron-builder's extraResources
function binPath(): string {
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath();
  return app.isPackaged
    ? path.join(base, "calendar-sidecar")
    : path.join(base, "swift", "calendar-sidecar");
}

interface RawResult {
  status: CalendarResult["status"];
  message?: string;
  calendarCount?: number;
  events?: CalendarEvent[];
}

/**
 * Reads upcoming calendar events via the EventKit sidecar and returns the ones
 * worth recording: everything not declined and not all-day.
 */
export async function fetchUpcoming(withinHours = 24): Promise<CalendarResult> {
  const bin = binPath();
  if (!fs.existsSync(bin)) {
    return {
      status: "error",
      message: "Calendar helper not built - run `npm run build:calendar`.",
      events: [],
    };
  }

  const raw = await new Promise<RawResult>((resolve) => {
    execFile(
      bin,
      ["--within-hours", String(withinHours)],
      { timeout: 20000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (!stdout) {
          resolve({
            status: "error",
            message: err?.message ?? "no output",
            events: [],
          });
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve({
            status: "error",
            message: "unreadable sidecar output",
            events: [],
          });
        }
      },
    );
  });

  // every real meeting counts: unanswered invites are still attended all the
  // time, and link-less meetings can be recorded mic-only - drop only what
  // the user explicitly declined and all-day blocks
  const all = raw.events ?? [];
  const events = all
    .filter((e) => e.myStatus !== "declined" && !e.isAllDay)
    .sort((a, b) => a.start.localeCompare(b.start));

  // when nothing matches, explain why in the app so the empty state is diagnosable
  let message = raw.message;
  if (events.length === 0 && raw.status === "ok") {
    const statuses =
      [...new Set(all.map((e) => e.myStatus))].join(", ") || "none";
    message =
      `Saw ${raw.calendarCount ?? "?"} calendars, ${all.length} events in the next ${withinHours}h ` +
      `(statuses: ${statuses}).`;
  }

  return { status: raw.status, message, events };
}
