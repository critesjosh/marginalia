"""Assembling utterances into one file per part, and the timings that go with it.

Timestamps are counted in samples on the concatenated buffer rather than by
summing per-segment durations in seconds, so rounding cannot accumulate across
the several thousand segments in a chapter.
"""

from __future__ import annotations

import shutil
import subprocess
import wave
from pathlib import Path


def encode_available(fmt: str) -> bool:
    return fmt == 'wav' or shutil.which('ffmpeg') is not None


def write_wav(path: Path, samples, sample_rate: int) -> None:
    import numpy as np

    clipped = np.clip(np.asarray(samples, dtype='float32'), -1.0, 1.0)
    pcm = (clipped * 32767.0).astype('<i2')

    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), 'wb') as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(pcm.tobytes())


def encode_opus(wav_path: Path, out_path: Path, bitrate: str) -> None:
    """Re-encodes to Ogg Opus, which is roughly a tenth the size at speech bitrates."""
    result = subprocess.run(
        [
            'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
            '-i', str(wav_path),
            '-c:a', 'libopus', '-b:a', bitrate, '-ac', '1', '-vbr', 'on',
            str(out_path),
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f'ffmpeg failed: {result.stderr.strip()}')


def concatenate(clips, sample_rate: int, gap: float):
    """Joins clips with a fixed gap, returning the buffer and each clip's [start, end).

    The gap belongs to the segment that precedes it: a reader who taps a segment
    hears the sentence and then the pause, rather than landing mid-silence.
    """
    import numpy as np

    silence = np.zeros(int(gap * sample_rate), dtype='float32')
    buffers: list = []
    bounds: list[tuple[float, float]] = []
    position = 0

    for clip in clips:
        clip = np.asarray(clip, dtype='float32').reshape(-1)
        start = position
        buffers.append(clip)
        position += len(clip)
        if len(silence):
            buffers.append(silence)
            position += len(silence)
        bounds.append((start / sample_rate, position / sample_rate))

    if not buffers:
        return np.zeros(0, dtype='float32'), []
    return np.concatenate(buffers), bounds
