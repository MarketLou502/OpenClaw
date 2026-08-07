# whisper-mlx

Native (non-Docker) Wyoming protocol STT server. Runs Whisper via Apple's MLX
framework on the Mac's GPU (Metal), replacing the old `whisper` Docker
container, which ran faster-whisper on CPU only — Docker Desktop (and every
other container runtime on macOS, OrbStack included) has no GPU passthrough
into Linux containers; that's a `Hypervisor.framework` limitation, not
something any particular container tool has chosen not to support yet.

Measured on this Mac (M4, 16GB): ~0.2s round-trip per utterance over the real
Wyoming protocol, vs. ~1.46s for the old Docker faster-whisper container on
the same test clip — roughly on par with the Parakeet/sherpa benchmark
(~0.18s) while keeping Whisper's `--initial-prompt` vocabulary-hint feature,
which Parakeet doesn't support.

## How it's built

This is `wyoming-faster-whisper` (the same package the old Docker image ran)
installed normally via pip into `venv/`, with three files hand-patched to add
an `mlx` backend option:

- `venv/lib/python3.9/site-packages/wyoming_faster_whisper/const.py` — added
  `SttLibrary.MLX`.
- `venv/lib/python3.9/site-packages/wyoming_faster_whisper/models.py` — added
  the `MLX` branch to `ModelLoader.load_transcriber()`, availability checks,
  and a `guess_model` default.
- `venv/lib/python3.9/site-packages/wyoming_faster_whisper/mlx_whisper_handler.py`
  (new file) — `MlxWhisperTranscriber`, calling `mlx_whisper.transcribe()`
  instead of `faster_whisper.WhisperModel.transcribe()`. Everything else
  (the Wyoming protocol server loop, audio buffering, CLI arg parsing) is
  the untouched upstream package.

**This means `pip install --upgrade wyoming-faster-whisper` in this venv
would silently wipe the patch.** If upgrading ever becomes necessary, reapply
the three edits above (diff against a fresh install to find them) rather than
just running the upgrade.

Note: `mlx_whisper`'s decoder only implements greedy/temperature-fallback
decoding, not beam search — `MlxWhisperTranscriber.transcribe()` deliberately
never forwards `beam_size` for this reason.

## Operating it

- Runs as a launchd daemon: `ai.openclaw.whisper-mlx`
  (`~/Library/LaunchAgents/ai.openclaw.whisper-mlx.plist`), port 10300.
- Home Assistant (in Docker) reaches it via `host.docker.internal:10300`
  (its Wyoming integration config entry was repointed from the old
  container's compose-network hostname `whisper` to this).
- `services/home-assistant/generate-whisper-vocab.js` regenerates this
  plist's `--initial-prompt` argument from the same board/habit/food-staple
  data it always has. Regenerating requires a reload to take effect:
  ```
  launchctl unload ~/Library/LaunchAgents/ai.openclaw.whisper-mlx.plist
  launchctl load ~/Library/LaunchAgents/ai.openclaw.whisper-mlx.plist
  ```
- Logs: `~/Library/Logs/openclaw/whisper-mlx.log`.
