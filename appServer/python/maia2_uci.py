#!/usr/bin/env python3
"""Minimal Maia-2 UCI adapter. Use only for analysis/permitted engine play."""
import contextlib
import math
import os
from pathlib import Path
import sys
import threading

try:
    import chess
except ImportError as error:
    raise SystemExit("Missing python-chess. Install requirements-maia2.txt with the selected Python interpreter.") from error


def default_model_dir():
    if sys.platform == "win32":
        cache = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local"))
    elif sys.platform == "darwin":
        cache = Path.home() / "Library/Caches"
    else:
        cache = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    return cache / "acas" / "maia2"


class MaiaPredictor:
    def __init__(self, device="auto", model_type="rapid", model_dir=None):
        self.device = device
        self.model_type = model_type
        self.model_dir = Path(model_dir) if model_dir is not None else default_model_dir()
        self.model = None
        self.prepared = None

    def __call__(self, fen, elo_self, elo_opponent):
        # Loading/downloads and library diagnostics must never corrupt UCI stdout.
        with contextlib.redirect_stdout(sys.stderr):
            from maia2 import inference, model
            if self.model is None:
                self.model = model.from_pretrained(type=self.model_type, device=self.device, save_root=str(self.model_dir))
                self.prepared = inference.prepare()
            probabilities, _white_expected_score = inference.inference_each(
                self.model, self.prepared, fen, elo_self, elo_opponent)
        return probabilities


class UciEngine:
    def __init__(self, predictor, emit=None):
        self.predictor = predictor
        self.emit = emit or (lambda line: print(line, file=sys.__stdout__, flush=True))
        self.board = chess.Board()
        self.options = {"EloSelf": 1500, "EloOpponent": 1500, "MultiPV": 1}
        self.condition = threading.Condition(threading.RLock())
        self.generation = 0
        self.pending = None
        self.active = None
        self.closed = False
        # One model/inference at a time; superseded work cannot publish a stale move.
        self.worker = threading.Thread(target=self._work, daemon=True)
        self.worker.start()

    def _cancel(self, bestmove=False):
        with self.condition:
            if bestmove and self.active is not None:
                board = self.active[1]
                move = next(iter(board.legal_moves), None)
                self.emit(f"bestmove {move.uci() if move else '0000'}")
            self.generation += 1
            self.pending = self.active = None

    def _position(self, words):
        if words[0] == "startpos":
            board, rest = chess.Board(), words[1:]
        elif words[0] == "fen":
            board, rest = chess.Board(" ".join(words[1:7])), words[7:]
            if not board.is_valid():
                raise ValueError("invalid board position")
        else:
            raise ValueError("expected startpos or fen")
        if rest:
            if rest[0] != "moves":
                raise ValueError("expected moves")
            for move in rest[1:]:
                board.push_uci(move)
        self._cancel()
        self.board = board

    def _work(self):
        while True:
            with self.condition:
                self.condition.wait_for(lambda: self.closed or self.pending is not None)
                if self.closed:
                    return
                generation, board, options = self.pending
                self.pending = None
            try:
                legal = {move.uci() for move in board.legal_moves}
                probabilities = self.predictor(board.fen(), options["EloSelf"], options["EloOpponent"]) if legal else {}
                ranked = sorted(
                    ((move, float(prob)) for move, prob in probabilities.items()
                     if move in legal and math.isfinite(float(prob)) and float(prob) >= 0),
                    key=lambda item: (-item[1], item[0]))
                if legal and not ranked:
                    raise ValueError("model returned no legal move probabilities")
                with self.condition:
                    if generation != self.generation or self.closed:
                        continue
                    for index, (move, probability) in enumerate(ranked[:options["MultiPV"]], 1):
                        self.emit(f"info string Maia probability {move} {probability:.6f}")
                        # Maia predicts moves, not centipawn scores or search depth.
                        self.emit(f"info depth 1 multipv {index} pv {move}")
                    self.emit(f"bestmove {ranked[0][0] if ranked else '0000'}")
                    self.active = None
            except Exception as error:
                with self.condition:
                    if generation == self.generation and not self.closed:
                        message = " ".join(str(error).splitlines())
                        self.emit(f"info string Maia error: {message}")
                        # Do not silently replace a broken Maia model with random play.
                        self.emit("bestmove 0000")
                        self.active = None

    def command(self, line):
        words = line.strip().split()
        if not words:
            return True
        command, args = words[0], words[1:]
        try:
            if command == "uci":
                self.emit("id name Maia-2 Python")
                self.emit("id author CSSLab / A.C.A.S adapter")
                for name, default, maximum in [("EloSelf", 1500, 3000), ("EloOpponent", 1500, 3000), ("MultiPV", 1, 256)]:
                    minimum = 1 if name == "MultiPV" else 100
                    self.emit(f"option name {name} type spin default {default} min {minimum} max {maximum}")
                self.emit("uciok")
            elif command == "isready":
                self.emit("readyok")
            elif command == "setoption":
                if len(args) != 4 or args[0] != "name" or args[2] != "value" or args[1] not in self.options:
                    raise ValueError("unsupported option")
                name, value = args[1], int(args[3])
                minimum, maximum = (1, 256) if name == "MultiPV" else (100, 3000)
                if not minimum <= value <= maximum:
                    raise ValueError(f"{name} must be between {minimum} and {maximum}")
                self.options[name] = value
            elif command == "position":
                self._position(args)
            elif command == "ucinewgame":
                self._cancel()
                self.board = chess.Board()
            elif command == "go":
                # This is a single-policy prediction, not a timed/search engine.
                if "searchmoves" in args or "ponder" in args:
                    raise ValueError("searchmoves and ponder are not supported")
                self._cancel()
                with self.condition:
                    self.pending = (self.generation, self.board.copy(), self.options.copy())
                    self.active = self.pending
                    self.condition.notify()
            elif command == "stop":
                self._cancel(bestmove=True)
            elif command == "quit":
                self.close()
                return False
        except (ValueError, IndexError) as error:
            self.emit(f"info string Invalid {command}: {error}")
            if command == "go":
                self._cancel()
                self.emit("bestmove 0000")
        return True

    def close(self):
        with self.condition:
            self.closed = True
            self._cancel()
            self.condition.notify()


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", choices=["auto", "cpu", "cuda", "mps"], default="auto")
    parser.add_argument("--model-type", choices=["rapid", "blitz"], default="rapid")
    parser.add_argument("--model-dir", type=Path, default=default_model_dir())
    parser.add_argument("--warmup", action="store_true", help="Download/load weights, run one prediction, then exit")
    args = parser.parse_args()
    predictor = MaiaPredictor(args.device, args.model_type, args.model_dir)
    if args.warmup:
        try:
            predictor(chess.STARTING_FEN, 1500, 1500)
        except Exception as error:
            raise SystemExit(f"Maia warmup failed: {error}") from error
        print("Maia-2 is ready. Weights cached in " + str(args.model_dir), file=sys.stderr)
        return
    engine = UciEngine(predictor)
    try:
        for line in sys.stdin:
            if not engine.command(line):
                break
    finally:
        engine.close()


if __name__ == "__main__":
    main()
