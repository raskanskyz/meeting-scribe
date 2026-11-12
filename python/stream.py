# /// script
# requires-python = ">=3.10,<3.14"
# dependencies = [
#   "mlx-whisper",
#   "numpy",
#   "silero-vad",
# ]
# ///
"""Live streaming transcription sidecar for Meeting Scribe (Apple GPU / MLX).

Long-lived process. Reads length-prefixed PCM frames per track on stdin, uses a
Silero neural VAD to cut utterances, transcribes each finished utterance with
mlx-whisper (model held resident across calls), and emits one JSON line per
committed segment on stdout.

stdin framing (binary, repeated):
    [track: 1 byte '0'|'1'][length: 4 bytes big-endian uint32][int16 PCM little-endian]
  track '0' = mic (Me), '1' = system (Them). 16 kHz mono.
  A frame with length 0 flushes that track's pending utterance (end of track).
  EOF on stdin shuts the process down (flushing everything first).

stdout (JSONL): {"type":"segment","track":"mic","speaker":"Me","start":..,"end":..,"text":..}
                {"type":"ready"}   {"type":"error","message":..}   {"type":"log",..}
"""
import collections
import json
import queue
import struct
import sys
import threading

import numpy as np

from transcribe import collapse_runs, seg_ok

SR = 16000
WINDOW = 512              # Silero v5 requires exactly 512 samples at 16 kHz
PREROLL_WINDOWS = 7       # ~224 ms kept before onset so no clipped phonemes
MAX_UTTERANCE_S = 15.0    # force-cut a speaker who never pauses
# below the floor an utterance is dropped as a blip. The mic floor is higher:
# a muted mic still delivers breath/keyboard noise, and sub-second VAD blips
# on it are the prime whisper-hallucination zone ("Thank you.", "Amen")
MIN_UTTERANCE_S = {"mic": 0.80, "system": 0.30}

TRACKS = {b"0": ("mic", "Me"), b"1": ("system", "Them")}

_emit_lock = threading.Lock()


def emit(**kw):
    line = json.dumps(kw, ensure_ascii=False) + "\n"
    with _emit_lock:
        sys.stdout.write(line)
        sys.stdout.flush()


class SileroSegmenter:
    """Streaming Silero VAD over one track. Yields (start_s, end_s, samples).

    Accumulates the audio windows of a live utterance between Silero's speech
    start/end events. Timestamps come from a local sample counter, never from the
    VAD's internal index, so it can't desync. Memory is bounded to one utterance
    plus a short preroll.
    """

    def __init__(self, track, speaker, make_iterator):
        self.track = track
        self.speaker = speaker
        self._vad = make_iterator()
        self._tail = np.zeros(0, dtype=np.float32)   # < WINDOW leftover
        self._preroll = collections.deque(maxlen=PREROLL_WINDOWS)
        self._utt = None                              # list of windows while collecting
        self._utt_start = 0                           # sample index of current utterance
        self._fed = 0                                 # samples fed so far

    def push(self, samples):
        out = []
        buf = np.concatenate([self._tail, samples]) if self._tail.size else samples
        n = buf.size // WINDOW
        for i in range(n):
            win = buf[i * WINDOW:(i + 1) * WINDOW]
            ev = self._vad(win)
            self._fed += WINDOW

            if self._utt is not None:
                self._utt.append(win)
            else:
                self._preroll.append(win)

            if ev and "start" in ev and self._utt is None:
                self._utt = list(self._preroll)
                self._utt_start = self._fed - len(self._utt) * WINDOW
                self._preroll.clear()
            elif ev and "end" in ev and self._utt is not None:
                u = self._close()
                if u:
                    out.append(u)

            # force-cut a speaker who never pauses, but keep collecting so no
            # audio is lost across the seam
            if self._utt is not None and (self._fed - self._utt_start) >= MAX_UTTERANCE_S * SR:
                u = self._close(keep_going=True)
                if u:
                    out.append(u)
        self._tail = buf[n * WINDOW:].astype(np.float32)
        return out

    def _close(self, keep_going=False):
        samples = np.concatenate(self._utt).astype(np.float32) if self._utt else None
        start = self._utt_start / SR
        end = self._fed / SR
        if keep_going:
            self._utt = []
            self._utt_start = self._fed
        else:
            self._utt = None
        if samples is None or samples.size < MIN_UTTERANCE_S[self.track] * SR:
            return None
        return (start, end, samples)

    def flush(self):
        if self._utt is not None:
            u = self._close()
            return [u] if u else []
        return []


def transcriber_worker(model_dir, language, q):
    import mlx_whisper

    lang = None if language == "auto" else language
    while True:
        item = q.get()
        if item is None:
            return
        track, speaker, start, end, samples = item
        try:
            r = mlx_whisper.transcribe(
                samples, path_or_hf_repo=model_dir, language=lang,
                fp16=True, verbose=False,
            )
            # keep only segments that pass the hallucination gates, so silence
            # decoded into filler never reaches the live view
            parts = [
                (s.get("text") or "").strip()
                for s in r.get("segments", [])
                if (s.get("text") or "").strip() and seg_ok(s)
            ]
            text = collapse_runs(" ".join(parts))
            if text:
                emit(type="segment", track=track, speaker=speaker,
                     start=round(start, 2), end=round(end, 2), text=text)
        except Exception as e:
            emit(type="log", message=f"transcribe failed: {type(e).__name__}: {e}")


def read_frame(stdin):
    header = stdin.read(5)
    if not header or len(header) < 5:
        return None
    track = header[0:1]
    (length,) = struct.unpack(">I", header[1:5])
    payload = b""
    while len(payload) < length:
        chunk = stdin.read(length - len(payload))
        if not chunk:
            return None
        payload += chunk
    return track, payload


def main():
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--language", default="he")
    args = ap.parse_args()

    from silero_vad import load_silero_vad, VADIterator

    vad_model = load_silero_vad()

    def make_iterator():
        return VADIterator(vad_model, sampling_rate=SR,
                           min_silence_duration_ms=500, speech_pad_ms=200)

    q = queue.Queue()
    worker = threading.Thread(
        target=transcriber_worker, args=(args.model_dir, args.language, q), daemon=True
    )
    worker.start()

    segs = {t: SileroSegmenter(name, spk, make_iterator) for t, (name, spk) in TRACKS.items()}
    emit(type="ready")

    stdin = sys.stdin.buffer
    while True:
        frame = read_frame(stdin)
        if frame is None:
            break
        track, payload = frame
        seg = segs.get(track)
        if seg is None:
            continue
        if len(payload) == 0:
            for u in seg.flush():
                q.put((seg.track, seg.speaker, u[0], u[1], u[2]))
            continue
        pcm = np.frombuffer(payload, dtype="<i2").astype(np.float32) / 32768.0
        for u in seg.push(pcm):
            q.put((seg.track, seg.speaker, u[0], u[1], u[2]))

    for seg in segs.values():
        for u in seg.flush():
            q.put((seg.track, seg.speaker, u[0], u[1], u[2]))
    q.put(None)
    worker.join()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        emit(type="error", message=f"{type(e).__name__}: {e}")
        sys.exit(1)
