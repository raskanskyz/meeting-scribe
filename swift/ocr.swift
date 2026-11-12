import Foundation
import ImageIO
import Vision

// Standalone Vision OCR helper. Recognizes the text in each image file given
// on the command line, fully on-device, and prints one JSON array to stdout:
//
//   ocr-sidecar frame1.jpg frame2.jpg  ->  [{"file":"frame1.jpg","text":"..."}, ...]
//
// A file that cannot be read or recognized yields an empty "text", never a
// failure, so one bad frame cannot sink the rest. Shipped as an extraResource
// binary and spawned by the Electron main process.

func recognize(_ path: String) -> String {
  guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
    let image = CGImageSourceCreateImageAtIndex(src, 0, nil)
  else { return "" }
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true
  request.automaticallyDetectsLanguage = true
  do { try VNImageRequestHandler(cgImage: image, options: [:]).perform([request]) } catch { return "" }
  return (request.results ?? [])
    .compactMap { $0.topCandidates(1).first?.string }
    .joined(separator: "\n")
}

let out = CommandLine.arguments.dropFirst().map { ["file": $0, "text": recognize($0)] }
let data = (try? JSONSerialization.data(withJSONObject: out)) ?? Data("[]".utf8)
FileHandle.standardOutput.write(data)
