import FluidAudio
import Foundation

// Who-spoke-when with NVIDIA Nemotron 3 Diarization (FluidAudio, CoreML on the
// Neural Engine). Spawned by python/transcribe.py:
//   diarize-sidecar <audio.wav> --cache <dir>
//     prints one JSON object { turns: [[start, end, speaker], ...] } or { error }
//   diarize-sidecar --prepare --cache <dir>
//     downloads the model only, one JSON line per { progress } then { ready }
// The model downloads into <dir> on first use; after that it runs offline.

func emit(_ obj: [String: Any], code: Int32 = 0) -> Never {
  line(obj)
  exit(code)
}

func line(_ obj: [String: Any]) {
  let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8)
  FileHandle.standardOutput.write(data + Data("\n".utf8))
}

let args = CommandLine.arguments
var audioPath: String?
var cacheDir: String?
var prepare = false
var i = 1
while i < args.count {
  if args[i] == "--prepare" {
    prepare = true
    i += 1
  } else if args[i] == "--cache", i + 1 < args.count {
    cacheDir = args[i + 1]
    i += 2
  } else {
    audioPath = args[i]
    i += 1
  }
}
// offline preset: 30.4 s look-ahead, the most accurate; latency is moot for a finished file
let config = Nemotron3Config.offline
let cacheURL = cacheDir.map { URL(fileURLWithPath: $0) }

if prepare {
  do {
    _ = try await Nemotron3Models.loadFromHuggingFace(config: config, cacheDirectory: cacheURL) {
      line(["progress": Int($0.fractionCompleted * 100)])
    }
    emit(["ready": true])
  } catch {
    emit(["error": "\(error)"], code: 1)
  }
}

guard let audioPath else { emit(["error": "usage: diarize-sidecar <audio.wav> --cache <dir>"], code: 2) }

do {
  let models = try await Nemotron3Models.loadFromHuggingFace(config: config, cacheDirectory: cacheURL)
  let diarizer = Nemotron3Diarizer(config: config, models: models)
  let audio = try AudioConverter().resampleAudioFile(path: audioPath)
  let (probs, frames) = try diarizer.processComplete(audio)
  let turns = Nemotron3Diarizer.segments(probabilities: probs, frameCount: frames)
    .map { [Double($0.startSeconds), Double($0.endSeconds), "speaker_\($0.speakerIndex)"] as [Any] }
  emit(["turns": turns])
} catch {
  emit(["error": "\(error)"], code: 1)
}
