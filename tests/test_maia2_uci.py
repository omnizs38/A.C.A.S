"""No PyTorch, model weights, network or GPU needed for protocol tests."""
import importlib.util
from pathlib import Path
import threading
import subprocess
import sys
import time
import unittest
from unittest.mock import patch
import types

import chess

SPEC = importlib.util.spec_from_file_location(
    "maia2_uci", Path(__file__).resolve().parents[1] / "appServer/python/maia2_uci.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.lines = []
        self.calls = []
        self.engine = MODULE.UciEngine(self.predict, self.lines.append)

    def tearDown(self):
        self.engine.close()
        self.engine.worker.join(1)

    def predict(self, fen, elo_self, elo_opponent):
        self.calls.append((fen, elo_self, elo_opponent))
        return {"e2e4": 0.6, "d2d4": 0.3, "e2e5": 0.9, "a2a3": float('nan')}

    def wait_bestmove(self, count=1):
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            if sum(line.startswith("bestmove ") for line in self.lines) >= count:
                return
            time.sleep(0.005)
        self.fail(f"No bestmove: {self.lines}")

    def test_handshake_and_readiness(self):
        self.engine.command("uci")
        self.engine.command("isready")
        self.assertIn("uciok", self.lines)
        self.assertEqual(self.lines[-1], "readyok")
        self.assertIn("option name EloSelf type spin default 1500 min 100 max 3000", self.lines)

    def test_options_and_legal_multipv(self):
        for command in ["setoption name EloSelf value 1800", "setoption name EloOpponent value 2000",
                        "setoption name MultiPV value 2", "go depth 8"]:
            self.engine.command(command)
        self.wait_bestmove()
        self.assertEqual(self.calls[0][1:], (1800, 2000))
        self.assertEqual(self.lines[-1], "bestmove e2e4")
        self.assertIn("info depth 1 multipv 2 pv d2d4", self.lines)
        self.assertFalse(any("score cp" in line for line in self.lines))

    def test_positions_and_new_game(self):
        self.engine.command("position startpos moves e2e4 e7e5")
        self.assertEqual(self.engine.board.piece_at(chess.E4), chess.Piece(chess.PAWN, chess.WHITE))
        fen = self.engine.board.fen()
        self.engine.command(f"position fen {fen} moves g1f3")
        self.assertEqual(self.engine.board.turn, chess.BLACK)
        self.engine.command("ucinewgame")
        self.assertEqual(self.engine.board.fen(), chess.STARTING_FEN)

    def test_invalid_position_is_atomic(self):
        for position in ["position", "position fen nonsense", "position startpos moves e2e5",
                         "position fen 8/8/8/8/8/8/8/8 w - - 0 1"]:
            self.engine.command(position)
            self.assertEqual(self.engine.board.fen(), chess.STARTING_FEN)
        self.assertTrue(all(line.startswith("info string Invalid position:") for line in self.lines))

    def test_invalid_options_do_not_mutate(self):
        for command in ["setoption name EloSelf value -1", "setoption name EloSelf value no",
                        "setoption name MultiPV value 0", "setoption name Unknown value 1"]:
            self.engine.command(command)
        self.assertEqual(self.engine.options, {"EloSelf": 1500, "EloOpponent": 1500, "MultiPV": 1})

    def test_terminal_position_does_not_call_model(self):
        self.engine.command("position startpos moves f2f3 e7e5 g2g4 d8h4")
        self.engine.command("go")
        self.wait_bestmove()
        self.assertEqual(self.lines[-1], "bestmove 0000")
        self.assertEqual(self.calls, [])

    def test_model_failure_is_visible_and_not_random_play(self):
        def fail(*_args):
            raise RuntimeError("missing weights\ncheck network")
        self.engine.predictor = fail
        self.engine.command("go")
        self.wait_bestmove()
        self.assertIn("info string Maia error: missing weights check network", self.lines)
        self.assertEqual(self.lines[-1], "bestmove 0000")

    def test_no_legal_prediction_is_reported(self):
        self.engine.predictor = lambda *_args: {"e2e5": 1}
        self.engine.command("go")
        self.wait_bestmove()
        self.assertIn("info string Maia error: model returned no legal move probabilities", self.lines)

    def test_stop_is_responsive_and_suppresses_late_result(self):
        entered, release = threading.Event(), threading.Event()
        def slow(*args):
            entered.set()
            release.wait(2)
            return self.predict(*args)
        self.engine.predictor = slow
        self.engine.command("go")
        self.assertTrue(entered.wait(1))
        try:
            self.engine.command("isready")
            self.assertEqual(self.lines[-1], "readyok")
            self.engine.command("stop")
            self.wait_bestmove()
            self.assertIn(chess.Move.from_uci(self.lines[-1].split()[1]), self.engine.board.legal_moves)
        finally:
            release.set()
        self.engine.close()
        self.engine.worker.join(1)
        self.assertEqual(sum(line.startswith("bestmove ") for line in self.lines), 1)

    def test_replacement_position_suppresses_stale_result(self):
        entered, release = threading.Event(), threading.Event()
        def slow(fen, *_args):
            entered.set()
            release.wait(2)
            board = chess.Board(fen)
            return {next(iter(board.legal_moves)).uci(): 1}
        self.engine.predictor = slow
        self.engine.command("go")
        self.assertTrue(entered.wait(1))
        self.engine.command("position startpos moves e2e4")
        self.engine.command("go")
        release.set()
        self.wait_bestmove()
        move = chess.Move.from_uci(self.lines[-1].split()[1])
        self.assertIn(move, self.engine.board.legal_moves)
        self.assertEqual(sum(line.startswith("bestmove ") for line in self.lines), 1)

    def test_quit_and_empty_input(self):
        self.assertTrue(self.engine.command(""))
        self.assertFalse(self.engine.command("quit"))
        self.assertTrue(self.engine.closed)

    def test_real_process_handshake_needs_no_maia_or_weights(self):
        result = subprocess.run([sys.executable, str(SPEC.origin)],
            input="uci\nisready\nquit\n", text=True, capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("uciok\nreadyok\n", result.stdout)
        self.assertNotIn("Downloading", result.stdout)

    def test_predictor_uses_documented_api_and_loads_once(self):
        calls = []
        fake = types.SimpleNamespace(
            model=types.SimpleNamespace(from_pretrained=lambda **kwargs: calls.append(kwargs) or "model"),
            inference=types.SimpleNamespace(prepare=lambda: "prepared",
                inference_each=lambda *args: (calls.append(args) or {"e2e4": 1}, 0.5)))
        with patch.dict("sys.modules", {"maia2": fake}):
            predictor = MODULE.MaiaPredictor("cpu", "blitz", "test-model-cache")
            self.assertEqual(predictor("fen", 1500, 1600), {"e2e4": 1})
            predictor("other fen", 1700, 1800)
        self.assertEqual(calls, [{"type": "blitz", "device": "cpu", "save_root": "test-model-cache"},
            ("model", "prepared", "fen", 1500, 1600),
            ("model", "prepared", "other fen", 1700, 1800)])


if __name__ == "__main__":
    unittest.main()
