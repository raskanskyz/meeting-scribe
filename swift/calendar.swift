import EventKit
import Foundation

// Standalone EventKit reader. Requests calendar access, then prints a single
// JSON object { status, message?, events[] } to stdout. Shipped as an
// extraResource binary and spawned by the Electron main process.

let args = CommandLine.arguments
var withinHours = 24.0
var i = 1
while i < args.count {
  if args[i] == "--within-hours", i + 1 < args.count {
    withinHours = Double(args[i + 1]) ?? 24.0
    i += 2
  } else {
    i += 1
  }
}

func emit(_ obj: [String: Any]) -> Never {
  let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8)
  FileHandle.standardOutput.write(data)
  exit(0)
}

let store = EKEventStore()
let sem = DispatchSemaphore(value: 0)
var granted = false

if #available(macOS 14.0, *) {
  store.requestFullAccessToEvents { ok, _ in granted = ok; sem.signal() }
} else {
  store.requestAccess(to: .event) { ok, _ in granted = ok; sem.signal() }
}
sem.wait()

if !granted {
  let auth = EKEventStore.authorizationStatus(for: .event)
  let status: String
  switch auth {
  case .denied: status = "denied"
  case .restricted: status = "restricted"
  case .notDetermined: status = "notDetermined"
  default: status = "denied"
  }
  emit(["status": status, "events": []])
}

let iso = ISO8601DateFormatter()
iso.formatOptions = [.withInternetDateTime]

func statusStr(_ s: EKParticipantStatus) -> String {
  switch s {
  case .accepted: return "accepted"
  case .declined: return "declined"
  case .tentative: return "tentative"
  case .pending: return "pending"
  case .delegated: return "delegated"
  default: return "unknown"
  }
}

let videoPattern =
  #"https?://[^\s<>"']*(?:zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|webex\.com|whereby\.com|around\.co|meet\.lync\.com)[^\s<>"']*"#

func extractVideo(_ texts: [String?]) -> String? {
  for t in texts {
    guard let t = t else { continue }
    if let r = t.range(of: videoPattern, options: .regularExpression) {
      return String(t[r])
    }
  }
  return nil
}

// external accounts (Google/Exchange over CalDAV) may not have their sources
// loaded on a freshly created store in a spawned process
store.refreshSourcesIfNecessary()
let calendars = store.calendars(for: .event)

let now = Date()
let end = now.addingTimeInterval(withinHours * 3600)
let predicate = store.predicateForEvents(
  withStart: now, end: end, calendars: calendars.isEmpty ? nil : calendars)
let events = store.events(matching: predicate)

var out: [[String: Any]] = []
for e in events {
  let video = extractVideo([e.url?.absoluteString, e.location, e.notes])

  var myStatus = "unknown"
  var attendees: [[String: String]] = []
  if let list = e.attendees {
    for p in list {
      attendees.append(["name": p.name ?? p.url.absoluteString, "status": statusStr(p.participantStatus)])
      if p.isCurrentUser { myStatus = statusStr(p.participantStatus) }
    }
  }
  if e.organizer?.isCurrentUser == true && myStatus == "unknown" { myStatus = "accepted" }
  if e.attendees?.isEmpty ?? true { myStatus = "accepted" }

  var dict: [String: Any] = [
    "id": e.eventIdentifier ?? UUID().uuidString,
    "title": e.title ?? "(no title)",
    "start": iso.string(from: e.startDate),
    "end": iso.string(from: e.endDate),
    "isAllDay": e.isAllDay,
    "myStatus": myStatus,
    "attendees": attendees
  ]
  if let loc = e.location, !loc.isEmpty { dict["location"] = loc }
  if let notes = e.notes, !notes.isEmpty { dict["notes"] = String(notes.prefix(2000)) }
  if let url = e.url?.absoluteString { dict["url"] = url }
  if let video = video { dict["videoLink"] = video }
  if let org = e.organizer?.name { dict["organizer"] = org }
  out.append(dict)
}

emit(["status": "ok", "calendarCount": calendars.count, "events": out])
