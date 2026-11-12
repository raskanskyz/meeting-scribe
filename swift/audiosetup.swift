import CoreAudio
import Foundation

// Standalone CoreAudio helper. Inspects the audio topology (is BlackHole
// installed, does the Multi-Output Device exist) and can create/rebuild that
// device programmatically - the same stacked aggregate Audio MIDI Setup makes
// by hand. Prints a single JSON object to stdout. Shipped as an extraResource
// binary and spawned by the Electron main process.
//
//   audio-sidecar status
//   audio-sidecar ensure [--name "Meeting Scribe"] [--rebuild]

let MANAGED_UID = "dev.eranr.meeting-scribe.multiout"

func emit(_ obj: [String: Any]) -> Never {
  let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8)
  FileHandle.standardOutput.write(data)
  exit(0)
}

func address(_ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}

func stringProperty(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
  var addr = address(selector)
  var size = UInt32(MemoryLayout<CFString?>.size)
  var value: CFString? = nil
  let status = withUnsafeMutablePointer(to: &value) {
    AudioObjectGetPropertyData(id, &addr, 0, nil, &size, $0)
  }
  guard status == noErr, let s = value else { return nil }
  return s as String
}

func allDeviceIDs() -> [AudioObjectID] {
  var addr = address(kAudioHardwarePropertyDevices)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr else { return [] }
  var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else { return [] }
  return ids
}

func outputChannelCount(_ id: AudioObjectID) -> Int {
  var addr = address(kAudioDevicePropertyStreamConfiguration, kAudioObjectPropertyScopeOutput)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr, size > 0 else { return 0 }
  let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
  defer { raw.deallocate() }
  guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, raw) == noErr else { return 0 }
  let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
  return list.reduce(0) { $0 + Int($1.mNumberChannels) }
}

func transportType(_ id: AudioObjectID) -> UInt32 {
  var addr = address(kAudioDevicePropertyTransportType)
  var size = UInt32(MemoryLayout<UInt32>.size)
  var value: UInt32 = 0
  guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr else { return 0 }
  return value
}

/// Output mute flag, main element then per-channel - devices implement one or
/// the other. nil when the device exposes neither.
func outputMuted(_ id: AudioObjectID) -> Bool? {
  for element in [kAudioObjectPropertyElementMain, 1] {
    var addr = AudioObjectPropertyAddress(
      mSelector: kAudioDevicePropertyMute,
      mScope: kAudioObjectPropertyScopeOutput,
      mElement: AudioObjectPropertyElement(element))
    guard AudioObjectHasProperty(id, &addr) else { continue }
    var size = UInt32(MemoryLayout<UInt32>.size)
    var value: UInt32 = 0
    if AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr { return value != 0 }
  }
  return nil
}

/// Output volume 0–1, main element then left channel.
func outputVolume(_ id: AudioObjectID) -> Float? {
  for element in [kAudioObjectPropertyElementMain, 1] {
    var addr = AudioObjectPropertyAddress(
      mSelector: kAudioDevicePropertyVolumeScalar,
      mScope: kAudioObjectPropertyScopeOutput,
      mElement: AudioObjectPropertyElement(element))
    guard AudioObjectHasProperty(id, &addr) else { continue }
    var size = UInt32(MemoryLayout<Float32>.size)
    var value: Float32 = 0
    if AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr { return value }
  }
  return nil
}

func defaultOutputID() -> AudioObjectID? {
  var addr = address(kAudioHardwarePropertyDefaultOutputDevice)
  var size = UInt32(MemoryLayout<AudioObjectID>.size)
  var id = AudioObjectID(0)
  guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id) == noErr, id != 0 else { return nil }
  return id
}

struct Device {
  let id: AudioObjectID
  let name: String
  let uid: String
  let outputChannels: Int
  let transport: UInt32
  var isAggregate: Bool { transport == kAudioDeviceTransportTypeAggregate }
  var isBlackhole: Bool { name.lowercased().contains("blackhole") && outputChannels > 0 }
}

func snapshot() -> [Device] {
  allDeviceIDs().compactMap { id in
    guard let name = stringProperty(id, kAudioDevicePropertyDeviceNameCFString),
          let uid = stringProperty(id, kAudioDevicePropertyDeviceUID)
    else { return nil }
    return Device(id: id, name: name, uid: uid, outputChannels: outputChannelCount(id), transport: transportType(id))
  }
}

func subDeviceUIDs(_ id: AudioObjectID) -> [String] {
  var addr = address(kAudioAggregateDevicePropertyFullSubDeviceList)
  var size = UInt32(MemoryLayout<CFArray?>.size)
  var value: CFArray? = nil
  let status = withUnsafeMutablePointer(to: &value) {
    AudioObjectGetPropertyData(id, &addr, 0, nil, &size, $0)
  }
  guard status == noErr, let arr = value as? [String] else { return [] }
  return arr
}

/// The real (non-virtual) output the multi-output should mirror to: the current
/// default output unless that's already an aggregate or BlackHole itself, in
/// which case fall back to the built-in speakers.
func referenceOutput(in devices: [Device]) -> Device? {
  if let defID = defaultOutputID(),
     let def = devices.first(where: { $0.id == defID }),
     !def.isAggregate, !def.isBlackhole {
    return def
  }
  return devices.first { $0.transport == kAudioDeviceTransportTypeBuiltIn && $0.outputChannels > 0 }
}

func statusPayload(_ devices: [Device], name: String) -> [String: Any] {
  let blackhole = devices.first { $0.isBlackhole }
  let aggregate = devices.first { $0.isAggregate && ($0.name == name || $0.uid == MANAGED_UID) }
  var payload: [String: Any] = [
    "blackhole": blackhole != nil,
    "device": aggregate != nil,
    "deviceName": name
  ]
  if let agg = aggregate {
    let subs = subDeviceUIDs(agg.id)
    payload["deviceHasBlackhole"] = blackhole.map { subs.contains($0.uid) } ?? false
    payload["subDevices"] = subs
  }
  if let defID = defaultOutputID(), let def = devices.first(where: { $0.id == defID }) {
    payload["defaultOutput"] = def.name
    // loopback capture is post-volume: a muted or zeroed output records silence
    if let muted = outputMuted(defID) { payload["outputMuted"] = muted }
    if let vol = outputVolume(defID) { payload["outputVolume"] = vol }
  }
  return payload
}

// ── argument parsing ──────────────────────────────────────────
let args = CommandLine.arguments
let command = args.count > 1 ? args[1] : "status"
var deviceName = "Meeting Scribe"
var rebuild = false
var i = 2
while i < args.count {
  switch args[i] {
  case "--name" where i + 1 < args.count:
    deviceName = args[i + 1]
    i += 2
  case "--rebuild":
    rebuild = true
    i += 1
  default:
    i += 1
  }
}

var devices = snapshot()

if command == "status" {
  emit(statusPayload(devices, name: deviceName))
}

guard command == "ensure" else {
  emit(["error": "unknown command: \(command)"])
}

guard let blackhole = devices.first(where: { $0.isBlackhole }) else {
  var payload = statusPayload(devices, name: deviceName)
  payload["error"] = "BlackHole is not installed"
  emit(payload)
}

let existing = devices.first { $0.isAggregate && ($0.name == deviceName || $0.uid == MANAGED_UID) }
if let agg = existing {
  // stale device (missing BlackHole, or user asked to re-point it at the
  // current speakers) gets torn down and recreated; a healthy one is kept
  let healthy = subDeviceUIDs(agg.id).contains(blackhole.uid)
  if healthy && !rebuild {
    emit(statusPayload(devices, name: deviceName))
  }
  guard AudioHardwareDestroyAggregateDevice(agg.id) == noErr else {
    emit(["error": "could not remove the existing \(deviceName) device"])
  }
}

guard let reference = referenceOutput(in: devices) else {
  emit(["error": "no physical output device found to pair with BlackHole"])
}

let description: [String: Any] = [
  kAudioAggregateDeviceNameKey as String: deviceName,
  kAudioAggregateDeviceUIDKey as String: MANAGED_UID,
  // stacked = Multi-Output Device (same signal to every sub-device)
  kAudioAggregateDeviceIsStackedKey as String: 1,
  kAudioAggregateDeviceMainSubDeviceKey as String: reference.uid,
  kAudioAggregateDeviceSubDeviceListKey as String: [
    [kAudioSubDeviceUIDKey as String: reference.uid],
    [
      kAudioSubDeviceUIDKey as String: blackhole.uid,
      // BlackHole resyncs to the speakers' clock instead of drifting apart
      kAudioSubDeviceDriftCompensationKey as String: 1
    ]
  ]
]

var aggID = AudioObjectID(0)
let status = AudioHardwareCreateAggregateDevice(description as CFDictionary, &aggID)
guard status == noErr else {
  emit(["error": "creating the device failed (OSStatus \(status))"])
}

devices = snapshot()
var payload = statusPayload(devices, name: deviceName)
payload["created"] = true
payload["pairedWith"] = reference.name
emit(payload)
