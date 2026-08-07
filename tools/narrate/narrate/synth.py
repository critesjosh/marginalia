"""Text-to-speech backends.

The interface is one method wide on purpose. Swapping Kokoro for Piper, F5 or a
hosted API should not touch segmentation, timing or packaging, and the `silence`
backend exists so the whole pipeline can be exercised end to end on a machine
with no GPU and no model weights.
"""

from __future__ import annotations

from typing import Protocol

#: Speaking rate used to fake durations in the silence backend. Roughly 155 wpm,
#: which is where an unhurried narrator lands.
CHARS_PER_SECOND = 14.5


class Backend(Protocol):
    name: str
    sample_rate: int

    def synth(self, text: str):
        """Returns mono float32 samples in [-1, 1] for one utterance."""


class SilenceBackend:
    """Generates silence of a plausible length. For testing the pipeline, not for listening."""

    name = 'silence'

    def __init__(self, sample_rate: int = 24000) -> None:
        self.sample_rate = sample_rate

    def synth(self, text: str):
        import numpy as np

        seconds = max(len(text) / CHARS_PER_SECOND, 0.2)
        return np.zeros(int(seconds * self.sample_rate), dtype='float32')


class KokoroBackend:
    """Kokoro-82M (Apache 2.0).

    Non-autoregressive, so unlike the LLM-backed models it does not drift,
    repeat or trail off on long inputs — which is the property that matters when
    a run is twelve thousand utterances long and nobody is listening to it.
    """

    name = 'kokoro'
    sample_rate = 24000

    def __init__(
        self,
        voice: str = 'af_heart',
        lang: str = 'a',
        speed: float = 1.0,
        device: str | None = None,
    ) -> None:
        try:
            from kokoro import KPipeline
        except ImportError as err:  # pragma: no cover - depends on the host env
            raise SystemExit(
                'The kokoro backend needs `pip install kokoro soundfile` and the '
                'espeak-ng system package. Use --backend silence to test the '
                'pipeline without them.'
            ) from err

        self.voice = voice
        self.speed = speed
        self._pipeline = KPipeline(lang_code=lang, device=device)

    def synth(self, text: str):
        import numpy as np

        chunks = []
        # Current versions yield a `Result` dataclass; older ones yield
        # `(graphemes, phonemes, audio)` tuples. Both still turn up in the wild.
        for result in self._pipeline(text, voice=self.voice, speed=self.speed):
            audio = result[2] if isinstance(result, tuple) else getattr(result, 'audio', None)
            if audio is None:
                continue
            if hasattr(audio, 'detach'):
                audio = audio.detach().cpu().numpy()
            chunks.append(np.asarray(audio, dtype='float32').reshape(-1))

        if not chunks:
            return np.zeros(int(0.2 * self.sample_rate), dtype='float32')
        return np.concatenate(chunks)


def build(name: str, voice: str, lang: str, speed: float, device: str | None = None) -> Backend:
    if name == 'silence':
        return SilenceBackend()
    if name == 'kokoro':
        return KokoroBackend(voice=voice, lang=lang, speed=speed, device=device)
    raise SystemExit(f'Unknown backend: {name}')
