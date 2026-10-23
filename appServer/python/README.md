# Python UCI engines and Maia-2

The local A.C.A.S server can run native UCI engines or `.py` scripts. Python
scripts must speak UCI over standard input/output; an arbitrary Python model
is not automatically a UCI engine. Only run scripts/interpreters you trust:
adding an engine permits local code execution. Use engine assistance only for
analysis, training, or games that explicitly allow it.

## Add a Python engine

1. Install the script's dependencies in a dedicated virtual environment.
2. In the local server, click **ADD ENGINE** and select the `.py` file.
3. Enter the **full path to that environment's Python executable**, without
   quotes or arguments. A single command on PATH (`python`, `python3`, `py`)
   also works, but a full venv path avoids selecting the wrong environment.
4. Give the engine a name, then select it under external engines in the A.C.A.S
   web GUI, exactly as for a native engine.

Interpreter/script paths containing spaces are supported. The server saves
runtime settings locally and starts Python directly, without a shell, using
unbuffered UTF-8 I/O and the script's directory as the working directory.
Existing native engine entries and UCI option persistence remain unchanged.
Removing/re-adding an entry lets you change its interpreter.

The packaged desktop app includes this directory as `python` next to the
installed application, outside Electron's archive. It does **not** bundle Python,
PyTorch, or model weights. From a source checkout, use `appServer/python`.

## Maia-2 setup (Windows PowerShell)

Use **Python 3.10–3.12** (3.12 recommended), not 3.13. From the repository root:

```powershell
py -3.12 -m venv "$env:USERPROFILE\.acas-maia2"
& "$env:USERPROFILE\.acas-maia2\Scripts\python.exe" -m pip install -r .\appServer\python\requirements-maia2.txt
& "$env:USERPROFILE\.acas-maia2\Scripts\python.exe" .\appServer\python\maia2_uci.py --warmup --device=cpu
```

Wait for warmup to finish successfully. It downloads the official Rapid weights
and runs one real prediction; PyTorch and weights require substantial download
size/disk space. Select `maia2_uci.py` in the server, then enter the expanded
absolute path to `.acas-maia2\Scripts\python.exe` (for example
`C:\Users\YourName\.acas-maia2\Scripts\python.exe`). Environment-variable syntax
such as `%USERPROFILE%` or `$env:USERPROFILE` is **not** expanded in the dialog.
If using the packaged app, substitute its `python` directory in the commands.

## Linux / macOS

```sh
python3.12 -m venv "$HOME/.acas-maia2"
"$HOME/.acas-maia2/bin/python" -m pip install -r appServer/python/requirements-maia2.txt
"$HOME/.acas-maia2/bin/python" appServer/python/maia2_uci.py --warmup --device=cpu
```

Select the script and the full path to `$HOME/.acas-maia2/bin/python`, with
`$HOME` replaced by your actual home directory in the dialog.

## Maia options and behavior

- **EloSelf**, **EloOpponent**: UCI spin options, default 1500. Maia-2 buckets
  Elo in 100-point intervals between 1100 and 1999; below 1100 and at/above 2000
  use the endpoint buckets. Values up to 3000 are accepted, not distinct models.
- **MultiPV**: top legal policy predictions, default 1.
- Launch parameters: `--device=cpu`, `--device=cuda`, `--device=mps` or
  `--device=auto` (default); `--model-type=rapid` (default) or `--model-type=blitz`.
  Set these in the external engine launch parameters in the web GUI.
- Default weights cache: `%LOCALAPPDATA%\acas\maia2` on Windows,
  `~/Library/Caches/acas/maia2` on macOS, or `$XDG_CACHE_HOME/acas/maia2`
  (`~/.cache/acas/maia2` by default) on Linux. This avoids writing into a
  read-only application installation directory. `--model-dir` can override it
  when running the adapter directly from a terminal.
- `uci` and `isready` respond before loading the model. First `go` loads weights
  lazily unless you ran warmup. Model output/download logs go to stderr, not UCI.
- Maia predicts human moves, not Stockfish-style search scores. `go depth`,
  `go nodes`, `go movetime` and `go infinite` each request **one** policy
  prediction; their limits do not control Maia inference. PVs contain one move;
  reported depth 1 means a policy prediction, not tree search. No fabricated
  centipawn scores or win probabilities are emitted.
- The command reader stays responsive while inference runs. `stop` returns a
  legal fallback if the prediction is not ready; it is **not** a Maia prediction.
  In-flight GPU/model work cannot be interrupted, but its stale result is
  discarded. New positions, `ucinewgame`, and `quit` discard old work too.
- `go searchmoves`, ponder, Chess960 and nonstandard variants are not supported.
- Missing dependencies, failed downloads, or invalid predictions are reported
  explicitly; inference failures return `bestmove 0000`, not random substitute
  moves. Inspect the local server console or run `--warmup` to diagnose them.

Maia-1 `.pb` weights are **not** Python scripts: use Lc0 for those. This adapter
uses the official `maia2==0.11.0` API; it does not convert Maia-1 weights or claim
Maia-3 compatibility. See the [official Maia-2 project](https://github.com/CSSLab/maia2)
and [published package](https://pypi.org/project/maia2/0.11.0/) for installation,
model licensing, supported hardware and upstream changes.

## Tests

From the repository root:

```sh
node --test --test-isolation=none tests/*.test.mjs
python -m pip install chess==1.11.2
python -m unittest discover -s tests -p 'test_maia2_uci.py' -v
```

Protocol tests use deterministic fake inference (no torch, network, weights or
GPU). They cover legal move filtering, FEN/history, options, terminal positions,
error reporting, responsive readiness/stop, and stale-result suppression. The
Node suite also launches a real Python fixture from a path containing spaces.
Set `PYTHON` to the test interpreter if it is not available as `python3`
(`python` on Windows). Real model/device validation is a separate `--warmup`
step and is not implied by passing the protocol tests.
