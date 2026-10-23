# Desktop screen mode (experimental)

A.C.A.S can now run without a userscript, browser extension, website integration,
or local WebSocket server. Electron captures the selected Windows display,
finds a visible 8×8 board, recognizes supported 2D pieces, tracks legal chess
moves, and draws UCI engine suggestions in a transparent click-through window.

**This is a first desktop implementation, not a universal board recognizer.**
Use only for analysis, training, or games where engine assistance is allowed.
There is no auto-clicking, input simulation, process injection, or anti-cheat
bypass.

## Windows quick start

With Node.js 24 installed, from a source checkout in PowerShell:

```powershell
cd C:\path\to\A.C.A.S\appServer
npm ci
npm run start:desktop
```

If your npm installation blocks dependency install scripts, approve Electron's
postinstall/download according to your npm policy before starting the app.
The normal `npm start` and installed app default to Desktop mode on Windows
unless you explicitly saved Web mode. Linux/macOS retain their legacy default;
screen mode is currently Windows-only.

1. Use **ADD ENGINE** to add a local UCI executable or a Python UCI script.
   Existing saved engines and [Python/Maia support](python/README.md) are reused.
   Native engines do not require Python for screen recognition.
2. In the Desktop panel select the engine, display, and matching piece theme:
   **Cburnett** or **Merida**. Set the board application's theme accordingly.
   Colors can differ, but arbitrary piece artwork/3D boards are not supported.
3. Set maximum depth and analysis time. Under **Engine options and starting
   position**, optionally set supported UCI options as JSON, for example
   `{"MultiPV":2}` or Maia's `{"EloSelf":1500,"EloOpponent":1700}`. Only include
   options your engine advertises. Invalid names/types/ranges are rejected.
   Engine-specific launch parameters are preserved (e.g. `--device=cpu`).
4. For a new game leave starting FEN empty and show the standard initial board.
   To attach midgame, enter its **complete FEN** first, including side to move,
   castling, en passant, and move counters. Pixels alone cannot recover these.
5. Click **WATCH SCREEN**, then keep one supported board fully visible on the
   chosen display. No board-area selection is necessary. The status changes
   from waiting to tracking after two matching observations. Orientation is
   inferred from the configured position/legal history, not guessed from turn.
6. Arrows appear above the board without stealing focus or consuming clicks.
   Move/resize the board and the next capture attempts to locate it again.
7. Use **RESET POSITION** before a new game, or **STOP** to turn capture off and
   release the desktop engine. Stop watching to change parameters or starting
   FEN, then start again. Losing the board pauses analysis and clears arrows.

To build a Windows installer from the same directory:

```powershell
npm run build
```

## Compatibility / current limitations

- Standard chess, **Cburnett/Merida 2D pieces**, one fully visible square board.
  Screenshot capture is not DOM-based and is not tied to a particular website,
  but unrecognized artwork, textured backgrounds, 3D, perspective, videos, or
  heavy board decorations may fail. The app must report uncertainty, not guess.
- The detector looks for regular alternating-color square backgrounds. Very
  small boards (below roughly 112 px after analysis downscaling), extreme
  colors, heavy labels, or nonuniform backgrounds may not be found.
- Multiple candidate boards are ambiguous during acquisition. Close/hide the
  other boards. Once tracking, the previous board location is preferred while
  it remains valid.
- History reconciliation accepts up to **two legal plies** between stable
  observations, including castling, en passant and promotion. More missed moves
  or an ambiguous/unreachable position require resynchronizing with a complete
  FEN or resetting at the beginning of a new game. Chess960/variants are not
  supported. Do not infer castling rights from a midgame screenshot.
- Dragging, transitions, highlights, obstruction and unknown pieces can pause
  tracking. Arrow moves are independently filtered against legal moves for
  the current FEN. Results for an old position are discarded.
- The capture interval is the delay **after** each frame finishes processing,
  not a guaranteed video frame rate. Default 1200 ms; minimum 500 ms.
  The displayed match percentage is template similarity, not a calibrated
  probability of correctness.
- Suggestions are independent of player identity: the engine analyzes the
  **side to move**. This desktop version does not inspect accounts, clocks,
  websites, or match metadata.
- An engine is shared with the existing lifecycle/console/settings code, but
  the Desktop profile is separate from legacy Web profiles. Stop/supersession
  waits for `bestmove` before another search, with a bounded failure timeout.
- Windows multi-monitor coordinates use the selected display's DIP bounds and
  normalized image coordinates, including negative monitor origins. Mixed-DPI
  hardware and real-world capture need verification on the target computer.
- The overlay is hidden briefly before each capture to avoid recognizing its
  own arrows; this can cause visible blinking. Content protection is also set,
  but is not relied on as a way to exclude the overlay from capture. Exclusive
  full-screen games may not show an overlay; use a normal/borderless window.

## Offline and privacy behavior

Screen watching starts only after **WATCH SCREEN** and stops on **STOP**, an
error, or application exit. Frames stay in memory and are not saved, uploaded,
or sent over WebSocket. Only the chosen display is analyzed. No remote vision
service, model download, or Python process is required by the recognizer.
Installing dependencies or initially downloading Maia weights still requires
network access, and external engines retain their own behavior.

Desktop mode does **not** call `startLocalWSS`; the previous userscript/Web UI
files are preserved but unused. To return to the old workflow, use **Use Web
mode** (restarts the app), or:

```powershell
npm run start:web
```

`--desktop` and `--web-mode` override the saved mode for that invocation. Engine
library entries and saved UCI options are not deleted by switching modes.

## Implementation and tests

- `backend/desktop/session.js`: same engine launcher, direct in-process UCI
  events, handshake, declared-option validation, search draining and stale-result
  suppression. No duplicate engine protocol implementation in a second process.
- `backend/desktop/runtime.js`: selected-display capture and Windows overlay.
- `ui/desktop/vision.js`: checkerboard acquisition and local template recognition.
- `ui/desktop/tracker.js`: stable-frame gate and legal-position reconciliation.
- `ui/desktop/chess.js`: unchanged copy of the project's existing chess.js rules
  library, including its original BSD notice; it is copied into the desktop app
  so packaging does not depend on files outside `appServer`.
- `ui/desktop/pieces`: standard Cburnett/Merida SVGs reused unchanged from the
  repository's existing `assets/images/pieces` sets, renamed for lookup. This
  feature does not relicense those assets; their original licensing applies.

From the repository root, after installing Playwright and its Chromium:

```sh
node --test --test-isolation=none tests/*.test.mjs
node --test tests/desktop-vision.test.cjs tests/desktop-ui.test.cjs tests/python-engine-ui.test.cjs tests/load-engine.test.cjs
```

`CHROMIUM_PATH` can point to an existing Chromium. `ACAS_SCREENSHOT_DIR` can
choose a directory for UI test previews; otherwise they go to the OS temp dir.
Vision tests render synthetic boards with the actual bundled piece images;
they do **not** prove accuracy across arbitrary real screenshots.

From `appServer`, the real Electron preload/IPC smoke test is:

```sh
npm run test:desktop-smoke
```

It launches the real UI using a temporary profile, checks Electron bridge/IPC
availability, exercises the actual transparent-overlay preload and canvas arrow
renderer, and verifies that port 2800 is not listening. It does not capture
screens. Run it with no unrelated service on port 2800. The Windows CI workflow
runs these checks and retains full logs as an artifact; failures print only a
short log excerpt.

Before calling the feature production-ready, manually verify on Windows 10/11:
board discovery, supported themes, black-bottom orientation, occlusion/window
switches, moving/resizing the board, display scaling/mixed-DPI monitors, capture
permission/failure handling, transparent click-through arrows, and clean exit.
