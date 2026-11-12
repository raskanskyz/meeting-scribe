"""mlx batch path transcribes VAD speech only. Run: uv run --with numpy python tests/test_mlx_vad.py"""
import sys
import types
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))
import transcribe as t  # noqa: E402

SR = 16000
calls = []


def fake_transcribe(audio, **_):
    calls.append(len(audio))
    return {"segments": [{"start": 0.5, "end": len(audio) / SR, "text": " hi",
                          "no_speech_prob": 0.0, "avg_logprob": -0.2, "compression_ratio": 1.0}]}


spans = []
sys.modules["mlx_whisper"] = types.SimpleNamespace(transcribe=fake_transcribe)
sys.modules["faster_whisper"] = types.ModuleType("faster_whisper")
sys.modules["faster_whisper.audio"] = types.SimpleNamespace(decode_audio=lambda *a, **k: np.zeros(100 * SR))
sys.modules["faster_whisper.vad"] = types.SimpleNamespace(get_speech_timestamps=lambda a: spans)
t.emit = lambda **kw: None

# silent track: whisper never runs, so it can't decode silence into filler
assert t.transcribe_tracks_mlx("m", "en", {"mic": ("mic.webm", "Me")}) == {"mic": []}
assert calls == []

# each span decoded alone, timestamps shifted back onto the track timeline
spans[:] = [{"start": 10 * SR, "end": 12 * SR}, {"start": 50 * SR, "end": 55 * SR}]
out = t.transcribe_tracks_mlx("m", "en", {"mic": ("mic.webm", "Me")})["mic"]
assert calls == [2 * SR, 5 * SR], calls
assert [(s["start"], s["end"]) for s in out] == [(10.5, 12.0), (50.5, 55.0)], out

print("ok")
