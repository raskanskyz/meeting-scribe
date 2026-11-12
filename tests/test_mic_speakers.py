"""Mic-track echo drop + speaker split. Run: uv run --with numpy python tests/test_mic_speakers.py"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))
import transcribe as t  # noqa: E402

A, B, R = np.eye(4)[0], np.eye(4)[1], np.eye(4)[2]  # distinct voices; R is remote


def fake_diarize(turns, labels, embs):
    t.diarize_file = lambda *a, **k: (turns, labels, np.stack(embs))


def segs(*spans):
    return [{"start": s, "end": e, "text": "x"} for s, e in spans]


def run(mic, sys_segs=(), voiceprints=None, n0=0):
    return t.mic_speakers("mic.webm", mic, list(sys_segs), {"R0": R}, None,
                          voiceprints or {}, 0.55, None, n0)


# two in-room voices, no call: more speech stays Me, the other is a placeholder
fake_diarize([(0, 60, "S0"), (60, 90, "S1")], ["S0", "S1"], [A, B])
kept, names, chips = run(segs((0, 30), (30, 60), (60, 90)), n0=2)
assert [s["cluster"] for s in kept] == ["mic:S0", "mic:S0", "mic:S1"]
assert names == {"mic:S0": "Me", "mic:S1": "Speaker 4"}, names  # finalize renumbers
assert {c["cluster"]: c["name"] for c in chips} == names

# the other voice matches an enrolled voiceprint -> named
_, names, _ = run(segs((0, 30), (60, 90)), voiceprints={"Michael": {"embedding": list(B)}})
assert names["mic:S1"] == "Michael", names

# the second voice is the remote speaker echoing in while they talk -> dropped,
# leaving one voice: the mic is plain Me again
fake_diarize([(0, 60, "S0"), (60, 100, "S1")], ["S0", "S1"], [A, R])
remote = [{"start": 59, "end": 91, "text": "y", "cluster": "R0"}]
# (95, 97) is a straggler the system transcript missed: goes with its voice
kept, names, chips = run(segs((0, 30), (60, 90), (95, 97)), remote)
assert [(s["start"], s["cluster"]) for s in kept] == [(0, None)], kept
assert (names, chips) == ({}, [])

# ...but a voice unlike the remote speaker is kept even while they talk over it
fake_diarize([(0, 60, "S0"), (60, 90, "S1")], ["S0", "S1"], [A, B])
kept, names, _ = run(segs((0, 30), (60, 90)), remote)
assert len(kept) == 2 and names["mic:S1"].startswith("Speaker"), names

print("ok")
