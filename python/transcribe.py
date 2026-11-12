# /// script
# requires-python = ">=3.10,<3.14"
# dependencies = [
#   "faster-whisper>=1.1.0",
#   "av<19",  # 19 dropped av.open(metadata_errors=), faster-whisper 1.2.1 still passes it
#   "huggingface_hub>=0.26",
#   "pyannote.audio>=4.0,<5",
#   "mlx-whisper",
# ]
# ///
"""Sidecar for Meeting Scribe. Speaks JSONL on stdout.

Commands:
  download   --repo <hf-repo> --dest <dir>
  transcribe --dir <recording-dir> --model-dir <dir> --language <code>
             [--diarize-cache <dir>] [--voiceprints <path>] [--match-threshold <0-1>]
"""
import argparse
import difflib
import json
import os
import re
import sys
import threading
from pathlib import Path

# speaker embeddings only (voiceprints); diarization itself is Nemotron 3
EMBEDDING_MODEL = "pyannote/speaker-diarization-community-1"
MATCH_THRESHOLD = 0.55
# a cluster with less than this much speech (and under 8% of the busiest
# speaker) is treated as an over-segmentation fragment, not a real attendee
FRAGMENT_SEC = 15.0
# ...but only folded into a neighbour it actually resembles, so a genuinely
# brief distinct speaker (low similarity to everyone) is kept
FOLD_COSINE = 0.30

# Whisper hallucination gates (the openai-whisper defaults). A segment is kept
# only when it doesn't look like silence decoded into filler ("Thank you.") or
# a repetition loop ("situation situation ..." compresses extremely well).
NO_SPEECH_MAX = 0.6
LOGPROB_MIN = -1.0
COMPRESSION_MAX = 2.4

_emit_lock = threading.Lock()


def seg_ok(seg) -> bool:
    """Quality gate for one raw whisper segment dict."""
    if seg.get("no_speech_prob", 0.0) > NO_SPEECH_MAX and seg.get("avg_logprob", 0.0) < LOGPROB_MIN:
        return False
    if seg.get("compression_ratio", 0.0) > COMPRESSION_MAX:
        return False
    return True


def collapse_runs(text: str, max_run: int = 2) -> str:
    """Cap immediate word repetitions that survive the compression gate."""
    out = []
    for w in text.split():
        if len(out) >= max_run and all(x.casefold() == w.casefold() for x in out[-max_run:]):
            continue
        out.append(w)
    return " ".join(out)


def emit(**kw):
    line = json.dumps(kw, ensure_ascii=False) + "\n"
    with _emit_lock:
        sys.stdout.write(line)
        sys.stdout.flush()


def cmd_download(repo: str, dest: str):
    from huggingface_hub import HfApi, hf_hub_download

    api = HfApi()
    info = api.model_info(repo, files_metadata=True)
    files = [(s.rfilename, s.size or 0) for s in info.siblings]
    total = sum(size for _, size in files) or 1
    done = 0
    emit(type="progress", pct=0)
    for name, size in files:
        hf_hub_download(repo_id=repo, filename=name, local_dir=dest)
        done += size
        emit(type="progress", pct=round(100 * done / total, 1))
    emit(type="progress", pct=100)


def fmt_ts(sec: float) -> str:
    s = int(sec)
    return f"{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}"


def transcribe_track(model, path: Path, language: str, track: str):
    segments, info = model.transcribe(
        str(path),
        language=None if language == "auto" else language,
        vad_filter=True,
        beam_size=1,
    )
    out = []
    duration = info.duration or 1
    for seg in segments:
        text = seg.text.strip()
        if text:
            out.append({"start": seg.start, "end": seg.end, "text": text})
        emit(type="progress", track=track, pct=round(min(100, 100 * seg.end / duration), 1))
    emit(type="progress", track=track, pct=100)
    return out


def _norm(text: str) -> str:
    return " ".join("".join(c.lower() for c in text if c.isalnum() or c.isspace()).split())


def _words(text: str) -> list:
    return _norm(text).split()


def _bleed_coverage(mic_words, window_words, min_run=2):
    """How much of a mic segment is echoed by the meeting audio.

    Returns (coverage 0..1, matching blocks). Runs shorter than `min_run` words
    are ignored, so incidental single-word hits ("the", "it") can't accumulate
    into a false positive.
    """
    sm = difflib.SequenceMatcher(None, mic_words, window_words, autojunk=False)
    blocks = [b for b in sm.get_matching_blocks() if b.size >= min_run]
    return sum(b.size for b in blocks) / max(len(mic_words), 1), blocks


# the whole mic segment is the meeting audio coming back
BLEED_DROP = 0.85
# partly echo - worth salvaging what the user actually said
BLEED_STRIP = 0.5
# a salvaged remainder shorter than this is fragments, not speech
BLEED_MIN_KEEP_WORDS = 4


def drop_bleed(me_segs, them_segs):
    """Remove speaker bleed from the mic track.

    Without headphones the meeting audio re-enters the microphone, so the mic
    transcript repeats what the other side said and the user gets credited with
    their words. The system track is a clean digital copy, so mic text echoing
    it at the same timestamps is bleed.

    Compared against the *concatenated* overlapping meeting text rather than
    each segment in turn: the tracks are segmented independently, so one ~10s
    mic segment routinely spans several shorter meeting segments and no single
    pairwise comparison scores high enough to catch it.

    A segment that is entirely echo is dropped; one that mixes real speech with
    echo keeps only the non-echoed words, so talking over the meeting doesn't
    cost the user their own sentence.
    """
    kept = []
    for m in me_segs:
        window = " ".join(
            t["text"]
            for t in them_segs
            if m["start"] < t["end"] + 2 and m["end"] > t["start"] - 2
        )
        if not window:
            kept.append(m)
            continue

        mic_words = _words(m["text"])
        coverage, blocks = _bleed_coverage(mic_words, _words(window))
        if coverage >= BLEED_DROP:
            continue
        if coverage < BLEED_STRIP:
            kept.append(m)
            continue

        echoed = set()
        for b in blocks:
            echoed.update(range(b.a, b.a + b.size))
        residue = [w for i, w in enumerate(mic_words) if i not in echoed]
        if len(residue) >= BLEED_MIN_KEEP_WORDS:
            kept.append({**m, "text": " ".join(residue)})
    return kept


def ready_marker(cache_dir: str) -> Path:
    return Path(cache_dir) / ".ready"


# fraction of 100 ms frames above -45 dBFS for a track to count as carrying
# meeting audio. The loopback tap reads post-volume system output, so with
# nothing playing it yields either digital silence or a low noise floor
# (~-56 dBFS, measured 0.06-0.18% active); real meeting audio measures 6% and
# up, so this threshold sits an order of magnitude clear of both.
SPEECH_ACTIVE_MIN = 0.015
SPEECH_FRAME = 1600  # 100 ms at 16 kHz
SPEECH_GATE = 10 ** (-45 / 20)

_speech_seen = {}


def carries_speech(path) -> bool:
    """Does this track hold speech-level audio, not just a noise floor?

    Whisper emitting segments is not proof: a noise floor decodes into a
    handful of phantom segments - enough to pass a truthiness test, not enough
    to diarize - so the check measures the audio itself. Result is cached
    because the answer is needed both before and during finalize.
    """
    key = str(path)
    if key in _speech_seen:
        return _speech_seen[key]

    import numpy as np
    from faster_whisper.audio import decode_audio

    try:
        wav = decode_audio(key, sampling_rate=16000)
        usable = len(wav) // SPEECH_FRAME * SPEECH_FRAME
        if usable:
            frames = wav[:usable].reshape(-1, SPEECH_FRAME)
            rms = np.sqrt((frames**2).mean(axis=1))
            active = float((rms > SPEECH_GATE).mean())
        else:
            active = 0.0
        _speech_seen[key] = active >= SPEECH_ACTIVE_MIN
        emit(type="log", message=f"{Path(key).stem}: {active * 100:.2f}% speech-active")
    except Exception as e:
        # unmeasurable audio won't diarize either, so prefer the other track
        emit(type="log", message=f"speech check failed for {Path(key).name}: {type(e).__name__}")
        _speech_seen[key] = False
    return _speech_seen[key]


def diar_track_for(tracks, by_track=None) -> str:
    """Which track to diarize: the meeting track when it carries the meeting.

    Everyone coming through the mic (an in-room meeting) or a tap that recorded
    silence both leave the system track without meeting audio, and the mic -
    which heard every voice in the room - is what needs diarizing. Choosing the
    system track there collapses the whole conversation into one speaker.
    """
    if "system" not in tracks:
        return "mic"
    if "mic" not in tracks:
        return "system"
    if by_track is not None and not by_track.get("system"):
        return "mic"
    return "system" if carries_speech(tracks["system"][0]) else "mic"


def diarize_file(path: Path, cache_dir: str, on_pct=None):
    """Who-spoke-when on one audio file. Returns (turns, labels, embeddings).

    Turns come from Nemotron 3 Diarization (the diarize-sidecar, CoreML).
    Per-speaker embeddings come from community-1's embedding model, the one
    every enrolled voiceprint was made with, so matching stays comparable."""
    import shutil
    import subprocess
    import tempfile
    import wave

    import numpy as np
    import torch
    from faster_whisper.audio import decode_audio
    from pyannote.audio import Pipeline

    sidecar = os.environ.get("DIARIZE_SIDECAR") or "diarize-sidecar"
    if not shutil.which(sidecar):
        raise RuntimeError("diarization helper not built - run `npm run build:diarize`")
    wav = decode_audio(str(path), sampling_rate=16000)
    with tempfile.TemporaryDirectory() as tmp:
        wav_path = Path(tmp) / "audio.wav"
        with wave.open(str(wav_path), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes((np.clip(wav, -1, 1) * 32767).astype("<i2").tobytes())
        proc = subprocess.run(
            [sidecar, str(wav_path), "--cache", cache_dir],
            capture_output=True, text=True,
        )
    out = json.loads(proc.stdout or "{}")
    if "turns" not in out:
        raise RuntimeError(out.get("error") or proc.stderr.strip()[-300:] or f"exit {proc.returncode}")
    turns = sorted((float(ts), float(te), lbl) for ts, te, lbl in out["turns"])
    if on_pct:
        on_pct(50)

    pipeline = Pipeline.from_pretrained(
        EMBEDDING_MODEL,
        token=os.environ.get("HF_TOKEN") or None,
        cache_dir=cache_dir,
    )
    ready_marker(cache_dir).touch()
    embed = pipeline._embedding

    # centroid per speaker: embed its longest turns, clipped to 10 s windows
    labels = sorted({t[2] for t in turns})
    centroids = []
    for lbl in labels:
        mine = sorted((t for t in turns if t[2] == lbl), key=lambda t: t[0] - t[1])[:30]
        vecs = []
        for ts, te, _ in mine:
            a, b = int(ts * 16000), int(min(te, ts + 10) * 16000)
            if b - a < 16000 and vecs:
                continue
            chunk = torch.from_numpy(wav[a:b].copy()).reshape(1, 1, -1)
            v = np.asarray(embed(chunk))[0]
            if np.isfinite(v).all():
                vecs.append(v / (np.linalg.norm(v) or 1.0))
        centroids.append(np.mean(vecs, axis=0) if vecs else np.full(embed.dimension, np.nan))
    if on_pct:
        on_pct(100)
    return turns, labels, np.stack(centroids) if centroids else np.zeros((0, embed.dimension))


class DiarizeJob:
    """Diarization in a background thread, overlapping CPU-bound whisper.

    Progress is buffered until begin_reporting() so the UI's single progress
    bar isn't fed two phases at once.
    """

    def __init__(self, path: Path, cache_dir: str, track: str):
        self.track = track
        self._pct = 0.0
        self._show = False
        self._lock = threading.Lock()
        self._result = None
        self._error = None
        self._thread = threading.Thread(target=self._run, args=(path, cache_dir), daemon=True)
        self._thread.start()

    def _on_pct(self, pct):
        with self._lock:
            self._pct = pct
            if not self._show:
                return
        emit(type="progress", track="diarize", pct=pct)

    def _run(self, path: Path, cache_dir: str):
        try:
            self._result = diarize_file(path, cache_dir, self._on_pct)
        except BaseException as e:
            self._error = e

    def begin_reporting(self):
        with self._lock:
            self._show = True
            pct = self._pct
        emit(type="progress", track="diarize", pct=pct)

    def result(self):
        self._thread.join()
        if self._error:
            raise self._error
        return self._result


def roster_allowed(invitees, voiceprints):
    """Voiceprint names linked to the calendar roster.

    Invitees are full names or emails ("Alice Smith", "alice@example.com",
    "mailto:bob@example.com"); voiceprints are enrolled under short transcript-style
    labels ("Alice", "Bob", "Carol"). Bridge on case-folded tokens, allowing a
    prefix match in either direction: work emails are often <first><lastinitial>
    ("alices", "carolj"), so the enrolled first name is a prefix of the email token;
    conversely a short handle ("dan") is a prefix of the label ("Daniel").
    The 3-char floor keeps initials/noise from linking. A voiceprint that links
    to nobody on the roster is excluded from matching. Bias is deliberately
    toward inclusion - the acoustic threshold still decides the actual name, so
    a slightly permissive roster only widens candidates, never mislabels."""
    tokens = set()
    for inv in invitees:
        local = str(inv).casefold().split("@", 1)[0]
        for sep in "._-:+":
            local = local.replace(sep, " ")
        tokens.update(t for t in local.split() if t)

    def links(name):
        v = name.casefold().strip()
        for t in tokens:
            if v == t or (min(len(v), len(t)) >= 3 and (t.startswith(v) or v.startswith(t))):
                return True
        return False

    return {n for n in voiceprints if links(n)}


def name_clusters(ordered, emb_by_label, voiceprints, threshold=MATCH_THRESHOLD, allowed=None):
    """Match cluster centroids against enrolled voiceprints; unknowns get Speaker N.

    Pairs are claimed best-similarity-first (one cluster per name), so an
    over-segmentation fragment can't steal a name from the speaker's main
    cluster just by appearing earlier. A leftover cluster may then reuse an
    already-claimed name when it matches that voiceprint AND resembles the
    claiming cluster - the diarizer split one person, and the same-name merge
    in finalize folds the pieces back together. With `allowed` (the calendar
    roster) only those voiceprints are candidates, so a cluster can never be
    named as someone absent from the meeting."""
    import numpy as np

    sims = []
    for lbl in ordered:
        emb = np.asarray(emb_by_label[lbl], dtype=float)
        if not np.isfinite(emb).all():
            continue
        for name, entry in voiceprints.items():
            if allowed is not None and name not in allowed:
                continue
            ref = np.asarray(entry.get("embedding", []), dtype=float)
            if ref.shape != emb.shape:
                continue
            denom = float(np.linalg.norm(emb) * np.linalg.norm(ref)) or 1.0
            sim = float(np.dot(emb, ref) / denom)
            if sim >= threshold:
                sims.append((sim, lbl, name))
    sims.sort(key=lambda s: -s[0])

    names, claimed = {}, {}
    for _sim, lbl, name in sims:
        if lbl in names or name in claimed:
            continue
        names[lbl] = (name, True)
        claimed[name] = lbl
    for _sim, lbl, name in sims:
        if lbl not in names and cosine(emb_by_label[lbl], emb_by_label[claimed[name]]) >= FOLD_COSINE:
            names[lbl] = (name, True)

    n = 0
    for lbl in ordered:
        if lbl not in names:
            n += 1
            names[lbl] = (f"Speaker {n}", False)
    return names


PLACEHOLDER = re.compile(r"^Speaker \d+$")
# a mic voice this close to a simultaneously-talking system voice is that same
# person echoing in (measured 0.89-0.98 for echo, <0.3 for a voice not on the call)
ECHO_COSINE = 0.8
# a mic voice with at least this share of its speech echoing is the call itself
ECHO_SHARE = 0.5


def identify_speakers(turns, labels, embeddings, voiceprints, threshold, allowed,
                      n0=0, prefix=""):
    """Name one track's diarized clusters and merge the ones that are one person.

    Returns (label -> name, speaker chips). Placeholders are numbered from n0+1;
    finalize renumbers the ones that surface. `prefix` namespaces cluster ids so
    two diarized tracks' labels (both start at SPEAKER_00) can't collide."""
    first = {}
    for ts, _te, lbl in turns:
        first.setdefault(lbl, ts)
    ordered = sorted(labels, key=lambda l: first.get(l, float("inf")))
    emb_by_label = {lbl: embeddings[labels.index(lbl)] for lbl in labels}
    named = name_clusters(ordered, emb_by_label, voiceprints, threshold, allowed)

    # Collapse clusters that are really one person: duplicate voiceprints
    # (e.g. "Lior" and "LIOR") would otherwise name two clusters as two
    # attendees. Clusters merge only on the same enrolled name
    # (case-insensitive); a voice-similarity merge fused distinct
    # attendees, since Nemotron's centroids put different people at 0.5+.
    parent = {lbl: lbl for lbl in ordered}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    # fold tiny fragment clusters (diarizer over-splits, and the scraps
    # then false-match a random voiceprint) into the acoustically nearest
    # substantial cluster - but only when they clearly resemble it, so a
    # genuinely brief speaker isn't swallowed
    dur = {lbl: 0.0 for lbl in ordered}
    for ts, te, lbl in turns:
        if lbl in dur:
            dur[lbl] += te - ts
    maxd = max(dur.values(), default=0.0)
    big = [lbl for lbl in ordered if dur[lbl] >= max(FRAGMENT_SEC, 0.08 * maxd)]
    for lbl in ordered:
        if lbl not in big and big:
            nearest = max(big, key=lambda b: cosine(emb_by_label[lbl], emb_by_label[b]))
            if cosine(emb_by_label[lbl], emb_by_label[nearest]) >= FOLD_COSINE:
                parent[find(lbl)] = find(nearest)

    for i, a in enumerate(ordered):
        for b in ordered[i + 1:]:
            na = named[a][0] if named[a][1] else None
            nb = named[b][0] if named[b][1] else None
            same_name = na and nb and na.strip().lower() == nb.strip().lower()
            if same_name:
                parent[find(a)] = find(b)

    # one representative per identity; prefer a voiceprint name over a
    # "Speaker N" placeholder
    rep_name, chips, n = {}, [], n0
    for r in dict.fromkeys(find(lbl) for lbl in ordered):
        name, matched = named[r]
        for lbl in ordered:
            if find(lbl) == r and named[lbl][1] and not matched:
                name, matched = named[lbl]
        if not matched:
            n += 1
            name = f"Speaker {n}"
        rep_name[r] = name
        chips.append({
            "cluster": prefix + r,
            "name": name,
            "matched": matched,
            "embedding": [float(x) for x in emb_by_label[r]],
        })
    merged = len(ordered) - len(rep_name)
    if merged:
        emit(type="log", message=f"merged {merged} duplicate speaker cluster(s)")
    return {prefix + lbl: rep_name[find(lbl)] for lbl in ordered}, chips


def mic_speakers(path, segs, sys_segs, sys_emb, cache_dir, voiceprints, threshold,
                 allowed, n0):
    """Diarize the mic track: drop the call echoing into it, split who's left.

    Text-based bleed suppression misses echo the mic transcribed differently
    (another language, a garbled phrase), and in a room whose conferencing
    system is on the call every in-room voice reaches the system track too. A
    mic segment is echo when a system segment overlaps it in time AND that
    system speaker's voice matches the mic segment's voice - the pairing, not
    either signal alone, since distinct people's centroids can sit at 0.85+.

    Of the surviving voices, the one with the most speech stays "Me" (the user
    sits closest to their own mic); anyone else in the room gets a voiceprint
    name or a placeholder. One voice -> no names, so a solo mic keeps plain Me.
    Returns (kept segs, cluster -> name, chips); tags kept segs' "cluster".
    ponytail: loudest-voice-is-Me heuristic; a "this voiceprint is me" setting
    would be exact if a louder colleague ever out-talks the user."""
    turns, labels, embeddings = diarize_file(path, cache_dir)
    assign_clusters(segs, turns)
    mic_emb = dict(zip(labels, embeddings))

    def echo(seg):
        return seg["cluster"] is not None and any(
            s["start"] < seg["end"] + 1 and s["end"] > seg["start"] - 1
            and cosine(mic_emb[seg["cluster"]], sys_emb[s["cluster"]]) >= ECHO_COSINE
            for s in sys_segs if s.get("cluster") in sys_emb
        )

    # judged per voice: a voice that is mostly echo is the call, so its
    # stragglers (echo the system transcript has no segment for) go too
    total, echoed, is_echo = {}, {}, {id(seg): echo(seg) for seg in segs}
    for seg in segs:
        d = seg["end"] - seg["start"]
        total[seg["cluster"]] = total.get(seg["cluster"], 0.0) + d
        if is_echo[id(seg)]:
            echoed[seg["cluster"]] = echoed.get(seg["cluster"], 0.0) + d
    call = {c for c in echoed if c is not None and echoed[c] >= ECHO_SHARE * total[c]}
    kept = [seg for seg in segs if not is_echo[id(seg)] and seg["cluster"] not in call]
    if len(kept) < len(segs):
        emit(type="log", message=f"mic: dropped {len(segs) - len(kept)} segment(s) echoing the call")
    for seg in kept:
        if seg["cluster"] is not None:
            seg["cluster"] = "mic:" + seg["cluster"]
    names, chips = identify_speakers(turns, labels, embeddings, voiceprints, threshold,
                                     allowed, n0, prefix="mic:")

    talk = {}
    for seg in kept:
        if seg["cluster"] in names:
            who = names[seg["cluster"]]
            talk[who] = talk.get(who, 0.0) + seg["end"] - seg["start"]
    if len(talk) < 2:
        for seg in kept:
            seg["cluster"] = None
        return kept, {}, []

    me = max(talk, key=talk.get)
    emit(type="log", message=f"mic: {len(talk)} in-room voices, {me!r} kept as Me")
    chips = [c for c in chips if c["name"] in talk]
    for chip in chips:
        if chip["name"] == me:
            chip["name"], chip["matched"] = "Me", True
    return kept, {lbl: "Me" if name == me else name for lbl, name in names.items()}, chips


def assign_clusters(segs, turns):
    for seg in segs:
        best, best_ov = None, 0.0
        for ts, te, lbl in turns:
            ov = min(seg["end"], te) - max(seg["start"], ts)
            if ov > best_ov:
                best_ov, best = ov, lbl
        if best is None and turns:
            mid = (seg["start"] + seg["end"]) / 2
            best = min(turns, key=lambda t: abs((t[0] + t[1]) / 2 - mid))[2]
        seg["cluster"] = best


def cosine(a, b) -> float:
    import numpy as np

    a = np.asarray(a, dtype=float)
    b = np.asarray(b, dtype=float)
    if not (np.isfinite(a).all() and np.isfinite(b).all()):
        return 0.0
    na, nb = float(np.linalg.norm(a)), float(np.linalg.norm(b))
    return float(np.dot(a, b) / (na * nb)) if na and nb else 0.0


def transcribe_tracks_mlx(model_dir: str, language: str, tracks):
    """Batch transcription on the Apple GPU (mlx-whisper) for Re-transcribe."""
    import mlx_whisper
    from faster_whisper.audio import decode_audio
    from faster_whisper.vad import get_speech_timestamps

    lang = None if language == "auto" else language
    by_track = {}
    for track, (path, _) in tracks.items():
        audio = decode_audio(str(path), sampling_rate=16000)
        # Whisper decodes silence into filler ("Thank you." every 30s window),
        # and on large-v3-turbo no_speech_prob stays ~0 so seg_ok can't catch
        # it. Transcribe each VAD speech span on its own instead. Not stitched
        # like faster-whisper's vad_filter: whisper skips speech across the
        # seams and seam timestamps map back to the wrong span. Not mlx
        # clip_timestamps: 0.4.3 never seeks to a clip's start, so it still
        # decodes the gaps.
        segs = []
        for span in get_speech_timestamps(audio):
            offset = span["start"] / 16000
            result = mlx_whisper.transcribe(
                audio[span["start"]:span["end"]], path_or_hf_repo=model_dir,
                language=lang, fp16=True, verbose=False,
            )
            for s in result.get("segments", []):
                text = collapse_runs((s.get("text") or "").strip())
                if text and seg_ok(s):
                    segs.append({"start": offset + s["start"], "end": offset + s["end"],
                                 "text": text})
        by_track[track] = segs
        emit(type="progress", track=track, pct=100)
    return by_track


def open_tracks(rec_dir: str):
    tracks = {}
    for track, speaker in (("mic", "Me"), ("system", "Them")):
        p = Path(rec_dir) / f"{track}.webm"
        if p.exists() and p.stat().st_size > 0:
            tracks[track] = (p, speaker)
    return tracks


def finalize(rec_dir: str, by_track, tracks, diarize_cache, voiceprints_path,
             match_threshold, diar_job=None, asr=None):
    """Diarize, suppress bleed, name speakers and write the transcript files.

    Shared by transcribe (ASR then finalize) and the live path (finalize the
    segments already produced while recording).

    asr: {"engine": ..., "model": ...} recorded in meta.json so a stored
    transcript says what produced it - engine and model both changed over the
    life of this app and transcripts are otherwise indistinguishable."""
    meta = {}
    meta_path = Path(rec_dir) / "meta.json"
    if meta_path.exists():
        meta = json.loads(meta_path.read_text())

    diar_track = diar_track_for(tracks, by_track)

    # A track that never carried speech-level audio can only have decoded its
    # noise floor into hallucinated filler ("Thank you." on loop). Left in,
    # those segments keep the track's fixed Me/Them label - the diarizer never
    # sees them - and surface as a phantom attendee in the timeline. Dropped
    # before bleed suppression so hallucinated text can't eat real mic speech.
    for track in by_track:
        if track != diar_track and by_track[track] and not carries_speech(tracks[track][0]):
            emit(type="log", message=(
                f"dropped {len(by_track[track])} hallucinated segment(s): "
                f"{track} track has no speech-level audio"
            ))
            by_track[track] = []

    if "mic" in by_track and "system" in by_track:
        before = len(by_track["mic"])
        by_track["mic"] = drop_bleed(by_track["mic"], by_track["system"])
        dropped = before - len(by_track["mic"])
        if dropped:
            emit(type="log", message=f"bleed suppression: dropped {dropped} mic segment(s)")

    cluster_names, speakers_out, diar_error = {}, [], None
    if diarize_cache and by_track.get(diar_track):
        emit(type="phase", phase="diarizing")
        try:
            if diar_job and diar_job.track == diar_track:
                diar_job.begin_reporting()
                turns, labels, embeddings = diar_job.result()
            else:
                turns, labels, embeddings = diarize_file(
                    tracks[diar_track][0],
                    diarize_cache,
                    lambda pct: emit(type="progress", track="diarize", pct=pct),
                )
            voiceprints = {}
            if voiceprints_path:
                try:
                    voiceprints = json.loads(Path(voiceprints_path).read_text())
                except Exception:
                    pass
            # the calendar roster, when present, is the source of truth for who
            # could be in this meeting - never match a voiceprint outside it
            allowed, invitees = None, meta.get("invitees") or []
            if invitees and voiceprints:
                allowed = roster_allowed(invitees, voiceprints)
                emit(type="log", message=(
                    f"roster: matching restricted to {sorted(allowed) or 'nobody'}"
                    f" ({len(invitees)} calendar invitees)"
                ))
            assign_clusters(by_track[diar_track], turns)
            cluster_names, speakers_out = identify_speakers(
                turns, labels, embeddings, voiceprints, match_threshold, allowed)

            # Hybrid meeting: the system track carried the remote side, but the
            # mic may have heard several people in the room. Diarize it too so
            # they aren't all credited to the user.
            if diar_track == "system" and by_track.get("mic"):
                try:
                    by_track["mic"], mic_names, mic_chips = mic_speakers(
                        tracks["mic"][0], by_track["mic"], by_track["system"],
                        dict(zip(labels, embeddings)), diarize_cache, voiceprints,
                        match_threshold, allowed, len(speakers_out))
                    cluster_names.update(mic_names)
                    speakers_out += mic_chips
                except Exception as e:
                    emit(type="log", message=f"mic diarization skipped: {type(e).__name__}: {e}"[:300])
        except Exception as e:
            msg = str(e)
            if "gated" in msg.lower() or "401" in msg or "403" in msg:
                diar_error = "Hugging Face token missing or model terms not accepted (Settings → Speaker identification)"
            else:
                diar_error = f"{type(e).__name__}: {msg}"[:300]
            emit(type="log", message=f"diarization skipped: {diar_error}")

    emit(type="phase", phase="merging")
    labeled = []
    for track, segs in by_track.items():
        for seg in segs:
            if seg.get("cluster") in cluster_names:
                seg["speaker"] = cluster_names[seg["cluster"]]
            else:
                seg["speaker"] = tracks[track][1]
                seg["cluster"] = track
            labeled.append(seg)
    labeled.sort(key=lambda s: s["start"])

    # placeholders were numbered per diarized cluster, including clusters that
    # got no segments; renumber the ones that surfaced 1..k in order of
    # appearance so there are no gaps
    renum = {}
    for seg in labeled:
        if PLACEHOLDER.match(seg["speaker"]) and seg["speaker"] not in renum:
            renum[seg["speaker"]] = f"Speaker {len(renum) + 1}"
    for seg in labeled:
        seg["speaker"] = renum.get(seg["speaker"], seg["speaker"])
    speakers_out = [c for c in speakers_out
                    if not PLACEHOLDER.match(c["name"]) or c["name"] in renum]
    for chip in speakers_out:
        chip["name"] = renum.get(chip["name"], chip["name"])

    # roster = the distinct speakers who ACTUALLY appear in the transcript, in
    # order of first appearance. Counting from the transcript (not the raw
    # cluster list) drops phantom diarization clusters that got no segments -
    # those were inflating the attendee count by one or more.
    roster = []
    for seg in labeled:
        if seg["speaker"] not in roster:
            roster.append(seg["speaker"])

    speakers_path = Path(rec_dir) / "speakers.json"
    if speakers_out:
        # keep only chips for clusters that surfaced in the transcript
        present = [s for s in speakers_out if s["name"] in roster]
        speakers_path.write_text(json.dumps(present, ensure_ascii=False), encoding="utf-8")
    else:
        speakers_path.unlink(missing_ok=True)
    if roster:
        meta["attendees"] = len(roster)
        meta["speakers"] = roster
    else:
        meta.pop("attendees", None)
        meta.pop("speakers", None)
    if diarize_cache:
        meta["diarization"] = diar_error or "ok"
    else:
        meta.pop("diarization", None)
    if asr:
        meta["asr"] = asr
    # computed from transcript.md on every list; persisting it only leaves a
    # stale "false" behind for anything that reads meta.json directly
    meta.pop("hasTranscript", None)
    if meta:
        meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    lines = [f"# {meta.get('title', Path(rec_dir).name)}", ""]
    single = len({seg["speaker"] for seg in labeled}) <= 1
    for seg in labeled:
        prefix = "" if single else f"**{seg['speaker']}** "
        lines.append(f"- {prefix}`[{fmt_ts(seg['start'])}]` {seg['text']}")

    (Path(rec_dir) / "transcript.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (Path(rec_dir) / "transcript.json").write_text(
        json.dumps(labeled, ensure_ascii=False, indent=1), encoding="utf-8"
    )


def cmd_transcribe(rec_dir: str, model_dir: str, language: str, engine: str = "faster-whisper",
                   diarize_cache: str | None = None, voiceprints_path: str | None = None,
                   match_threshold: float = MATCH_THRESHOLD):
    marker = "weights.safetensors" if engine == "mlx" else "model.bin"
    if not (Path(model_dir) / marker).exists():
        emit(type="error", message=f"model not downloaded: {model_dir}")
        sys.exit(2)

    tracks = open_tracks(rec_dir)
    if not tracks:
        emit(type="error", message="no audio tracks found")
        sys.exit(2)

    # once the diarization models are cached, stay offline so pipeline loads
    # never stall on Hugging Face reachability
    if diarize_cache and ready_marker(diarize_cache).exists():
        os.environ.setdefault("HF_HUB_OFFLINE", "1")

    # diarization runs on the Neural Engine while whisper is busy, so kick it off
    # first and let the two overlap
    diar_job = None
    if diarize_cache:
        # same track finalize() will settle on, so the overlapped job isn't wasted
        pre_track = diar_track_for(tracks)
        diar_job = DiarizeJob(tracks[pre_track][0], diarize_cache, pre_track)

    emit(type="phase", phase="loading")
    if engine == "mlx":
        emit(type="phase", phase="transcribing")
        by_track = transcribe_tracks_mlx(model_dir, language, tracks)
    else:
        from faster_whisper import WhisperModel

        model = WhisperModel(model_dir, device="cpu", compute_type="int8")
        emit(type="phase", phase="transcribing")
        by_track = {
            track: transcribe_track(model, path, language, track)
            for track, (path, _) in tracks.items()
        }

    finalize(rec_dir, by_track, tracks, diarize_cache, voiceprints_path, match_threshold,
             diar_job, asr=asr_info(engine, model_dir))


def asr_info(engine: str, model_dir: str) -> dict:
    """Provenance for meta.json: the engine plus the model repo id, recovered
    from the cache directory name ('org__repo' is how downloads are stored)."""
    return {"engine": engine, "model": Path(model_dir).name.replace("__", "/")}


def cmd_finalize(rec_dir: str, segments_path: str, diarize_cache: str | None = None,
                 voiceprints_path: str | None = None, match_threshold: float = MATCH_THRESHOLD,
                 engine: str | None = None, model_dir: str | None = None):
    """Finalize live-produced segments: no ASR, just diarize/label/write."""
    tracks = open_tracks(rec_dir)
    live = json.loads(Path(segments_path).read_text())
    by_track = {t: [] for t in tracks}
    for seg in live:
        track = seg.get("track")
        if track in by_track:
            by_track[track].append(
                {"start": seg["start"], "end": seg["end"], "text": seg["text"].strip()}
            )
    for segs in by_track.values():
        segs.sort(key=lambda s: s["start"])

    if diarize_cache and ready_marker(diarize_cache).exists():
        os.environ.setdefault("HF_HUB_OFFLINE", "1")

    asr = asr_info(engine, model_dir) if engine and model_dir else None
    if asr:
        asr["live"] = True
    finalize(rec_dir, by_track, tracks, diarize_cache, voiceprints_path, match_threshold,
             asr=asr)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser("download")
    d.add_argument("--repo", required=True)
    d.add_argument("--dest", required=True)

    t = sub.add_parser("transcribe")
    t.add_argument("--dir", required=True)
    t.add_argument("--model-dir", required=True)
    t.add_argument("--language", default="he")
    t.add_argument("--engine", default="faster-whisper", choices=["faster-whisper", "mlx"])
    t.add_argument("--diarize-cache", default=None)
    t.add_argument("--voiceprints", default=None)
    t.add_argument("--match-threshold", type=float, default=MATCH_THRESHOLD)

    f = sub.add_parser("finalize")
    f.add_argument("--dir", required=True)
    f.add_argument("--segments", required=True)
    f.add_argument("--diarize-cache", default=None)
    f.add_argument("--voiceprints", default=None)
    f.add_argument("--match-threshold", type=float, default=MATCH_THRESHOLD)
    f.add_argument("--engine", default=None, choices=["faster-whisper", "mlx"])
    f.add_argument("--model-dir", default=None)

    args = ap.parse_args()
    try:
        if args.cmd == "download":
            cmd_download(args.repo, args.dest)
        elif args.cmd == "finalize":
            cmd_finalize(args.dir, args.segments, args.diarize_cache,
                         args.voiceprints, args.match_threshold,
                         args.engine, args.model_dir)
        else:
            cmd_transcribe(args.dir, args.model_dir, args.language, args.engine,
                           args.diarize_cache, args.voiceprints, args.match_threshold)
    except Exception as e:  # surface any failure as a JSON event
        emit(type="error", message=f"{type(e).__name__}: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
