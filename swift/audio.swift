import CoreAudio
import Foundation

// CoreAudio helper sidecar. Prints a single JSON object to stdout.
//
// Commands:
//   setup [--name <device>]      create a multi-output device (<real output>
//                                + BlackHole) named <device> if BlackHole is
//                                installed and no such device exists yet
//   get-default                  name of the current default output device
//   set-default --name <device>  set the default output device by name
//   get-volume                   volume of the audible output - resolves the
//                                physical sub-device when the default is an
//                                aggregate (whose master volume macOS refuses
//                                to control, which is why volume keys go dead
//                                while recording)
//   set-volume --value <0..1>    set that same volume
//
// Replaces the manual Audio MIDI Setup dance and the SwitchAudioSource
// homebrew dependency.

func emit(_ obj: [String: Any]) -> Never {
  let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8)
  FileHandle.standardOutput.write(data)
  exit(0)
}

func fail(_ message: String) -> Never {
  emit(["status": "error", "message": message])
}

func address(
  _ selector: AudioObjectPropertySelector,
  _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(
    mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}

func allDevices() -> [AudioObjectID] {
  var addr = address(kAudioHardwarePropertyDevices)
  var size: UInt32 = 0
  guard
    AudioObjectGetPropertyDataSize(
      AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr
  else { return [] }
  var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard
    AudioObjectGetPropertyData(
      AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr
  else { return [] }
  return ids
}

func stringProp(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
  var addr = address(selector)
  var size = UInt32(MemoryLayout<CFString?>.size)
  var value: CFString?
  let err = withUnsafeMutablePointer(to: &value) {
    AudioObjectGetPropertyData(id, &addr, 0, nil, &size, $0)
  }
  guard err == noErr, let s = value else { return nil }
  return s as String
}

func name(_ id: AudioObjectID) -> String { stringProp(id, kAudioObjectPropertyName) ?? "" }
func uid(_ id: AudioObjectID) -> String { stringProp(id, kAudioDevicePropertyDeviceUID) ?? "" }

func outputChannels(_ id: AudioObjectID) -> Int {
  var addr = address(kAudioDevicePropertyStreamConfiguration, kAudioDevicePropertyScopeOutput)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr, size > 0 else {
    return 0
  }
  let raw = UnsafeMutableRawPointer.allocate(
    byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
  defer { raw.deallocate() }
  guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, raw) == noErr else { return 0 }
  let buffers = UnsafeMutableAudioBufferListPointer(
    raw.assumingMemoryBound(to: AudioBufferList.self))
  return buffers.reduce(0) { $0 + Int($1.mNumberChannels) }
}

func transport(_ id: AudioObjectID) -> UInt32 {
  var addr = address(kAudioDevicePropertyTransportType)
  var size = UInt32(MemoryLayout<UInt32>.size)
  var value: UInt32 = 0
  guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr else { return 0 }
  return value
}

func defaultOutput() -> AudioObjectID {
  var addr = address(kAudioHardwarePropertyDefaultOutputDevice)
  var size = UInt32(MemoryLayout<AudioObjectID>.size)
  var id: AudioObjectID = 0
  _ = AudioObjectGetPropertyData(
    AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id)
  return id
}

func subDevices(_ id: AudioObjectID) -> [AudioObjectID] {
  var addr = address(kAudioAggregateDevicePropertyActiveSubDeviceList)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr, size > 0 else {
    return []
  }
  var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &ids) == noErr else { return [] }
  return ids
}

/// the device whose volume the user actually hears: the physical sub-device
/// when the default output is our multi-output aggregate
func volumeTarget() -> AudioObjectID? {
  let def = defaultOutput()
  guard def != 0 else { return nil }
  if transport(def) == kAudioDeviceTransportTypeAggregate {
    let subs = subDevices(def)
    return subs.first(where: {
      !name($0).localizedCaseInsensitiveContains("blackhole") && outputChannels($0) > 0
    }) ?? subs.first
  }
  return def
}

func volumeAddr(_ element: UInt32) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyVolumeScalar,
    mScope: kAudioDevicePropertyScopeOutput, mElement: element)
}

func readVolume(_ id: AudioObjectID) -> Float32? {
  // element 0 is the master control; some devices only expose per-channel
  for el: UInt32 in [0, 1, 2] {
    var addr = volumeAddr(el)
    guard AudioObjectHasProperty(id, &addr) else { continue }
    var v: Float32 = 0
    var size = UInt32(MemoryLayout<Float32>.size)
    if AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &v) == noErr { return v }
  }
  return nil
}

func writeVolume(_ id: AudioObjectID, _ value: Float32) -> Bool {
  var v = min(max(value, 0), 1)
  var ok = false
  for el: UInt32 in [0, 1, 2] {
    var addr = volumeAddr(el)
    var settable = DarwinBoolean(false)
    guard AudioObjectHasProperty(id, &addr),
      AudioObjectIsPropertySettable(id, &addr, &settable) == noErr, settable.boolValue
    else { continue }
    if AudioObjectSetPropertyData(
      id, &addr, 0, nil, UInt32(MemoryLayout<Float32>.size), &v) == noErr
    {
      ok = true
    }
  }
  return ok
}

let args = CommandLine.arguments
let command = args.count > 1 ? args[1] : ""
var nameArg = "Meeting Scribe"
var valueArg: Float32 = -1
var i = 2
while i < args.count {
  if args[i] == "--name", i + 1 < args.count {
    nameArg = args[i + 1]
    i += 2
  } else if args[i] == "--value", i + 1 < args.count {
    valueArg = Float32(args[i + 1]) ?? -1
    i += 2
  } else {
    i += 1
  }
}

switch command {
case "get-default":
  emit(["status": "ok", "name": name(defaultOutput())])

case "set-default":
  guard let dev = allDevices().first(where: { name($0) == nameArg && outputChannels($0) > 0 })
  else { fail("output device not found: \(nameArg)") }
  var addr = address(kAudioHardwarePropertyDefaultOutputDevice)
  var devID = dev
  let err = AudioObjectSetPropertyData(
    AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil,
    UInt32(MemoryLayout<AudioObjectID>.size), &devID)
  if err != noErr { fail("could not set default output (\(err))") }
  emit(["status": "ok", "name": nameArg])

case "get-volume":
  guard let target = volumeTarget(), let v = readVolume(target) else {
    fail("no volume control on the current output")
  }
  emit(["status": "ok", "name": name(target), "volume": v])

case "set-volume":
  guard valueArg >= 0 else { fail("set-volume requires --value 0..1") }
  guard let target = volumeTarget() else { fail("no output device") }
  guard writeVolume(target, valueArg) else { fail("volume not settable on \(name(target))") }
  emit(["status": "ok", "name": name(target), "volume": valueArg])

case "setup":
  let devices = allDevices()
  if devices.contains(where: { name($0) == nameArg }) {
    emit(["status": "exists", "name": nameArg])
  }
  guard
    let blackhole = devices.first(where: {
      name($0).localizedCaseInsensitiveContains("blackhole") && outputChannels($0) > 0
    })
  else { emit(["status": "no-blackhole"]) }

  // the output the user actually hears: the current default, or the built-in
  // speakers when the default is BlackHole itself, an aggregate, or virtual
  let usable = { (id: AudioObjectID) -> Bool in
    outputChannels(id) > 0 && id != blackhole
      && transport(id) != kAudioDeviceTransportTypeAggregate
      && transport(id) != kAudioDeviceTransportTypeVirtual
  }
  var real = defaultOutput()
  if !usable(real) {
    guard
      let fallback = devices.first(where: {
        transport($0) == kAudioDeviceTransportTypeBuiltIn && outputChannels($0) > 0
      }) ?? devices.first(where: usable)
    else { fail("no physical output device found") }
    real = fallback
  }

  // raw key strings from AudioHardware.h (kAudioAggregateDevice*Key macros);
  // "stacked" makes it a multi-output device rather than an aggregate input
  let desc: [String: Any] = [
    "name": nameArg,
    "uid": "meeting-scribe-multi-output",
    "stacked": 1,
    "master": uid(real),
    "subdevices": [
      ["uid": uid(real)],
      ["uid": uid(blackhole), "drift": 1],
    ],
  ]
  var aggID = AudioObjectID(0)
  let err = AudioHardwareCreateAggregateDevice(desc as CFDictionary, &aggID)
  if err != noErr { fail("could not create multi-output device (\(err))") }
  emit(["status": "created", "name": nameArg, "output": name(real)])

default:
  fail(
    "usage: audio-sidecar setup|get-default|set-default|get-volume|set-volume [--name <device>] [--value <0..1>]"
  )
}
