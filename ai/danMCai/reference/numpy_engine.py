"""CPU reference for model export and browser inference validation."""

import os

os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("OMP_NUM_THREADS", "1")
from pathlib import Path
import pickle
import threading
import time
import numpy as np

CHECKPOINT = (next(p for p in Path(__file__).resolve().parents if (p / "package.json").is_file()) / 'ai/danMCai/models/baseline') / "policy.ckpt"


class WeightReader(pickle.Unpickler):
    """Only the NumPy array constructors in the supplied checkpoint are allowed."""

    def find_class(self, module, name):
        core = np._core if hasattr(np, "_core") else np.core
        allowed = {
            ("numpy", "ndarray"): np.ndarray,
            ("numpy", "dtype"): np.dtype,
            ("numpy.core.multiarray", "_reconstruct"): core.multiarray._reconstruct,
            ("numpy._core.multiarray", "_reconstruct"): core.multiarray._reconstruct,
        }
        if (module, name) not in allowed:
            raise pickle.UnpicklingError("Unsupported checkpoint object")
        return allowed[module, name]


def card_index(card_id):
    """Web physical card ID -> rank-major H/S/C/D feature index, then jokers."""
    if type(card_id) is not int or not 0 <= card_id < 108:
        raise ValueError("Invalid card ID")
    n = card_id % 54
    return n if n >= 52 else (n % 13) * 4 + (1, 0, 2, 3)[n // 13]


def cards_array(ids):
    if ids == [-1]:
        return -np.ones(54, dtype=np.float32)
    return np.bincount([card_index(c) for c in ids], minlength=54).astype(np.float32)


def universal_flags(hand, level):
    """Match upstream proc_universal exactly, including its original boundaries.

    Changing the feature definition would require retraining the supplied model.
    """
    res = np.zeros(12, dtype=np.float32)
    wild = (level - 2) * 4
    if hand[wild] == 0:
        return res
    res[0] = 1
    for suit in range(4):
        for start in range(8):
            window = [
                hand[suit + j * 4] if suit + j * 4 != wild else 0 for j in range(start, start + 5)
            ]
            if window.count(0) <= 1:
                res[1] = 1
                break
        if res[1]:
            break
    counts = [
        sum(hand[suit + rank * 4] != 0 and suit + rank * 4 != wild for suit in range(4))
        for rank in range(13)
    ]
    maximum = max(counts)
    res[8 - max(1, min(maximum, 6)) : 8] = 1
    tail = 0
    for i, count in enumerate(counts):
        if not count:
            tail = 0
            continue
        tail += 1
        if i >= 1:
            prev = counts[i - 1]
            if (count == 2 and prev >= 3) or (count >= 3 and prev == 2):
                res[9] = 1
            elif count == 2 and prev == 2:
                res[11] = 1
        if i >= 2:
            a, b = counts[i - 2 : i]
            if (
                (a == 1 and b >= 2 and count >= 2)
                or (a >= 2 and b == 1 and count >= 2)
                or (a >= 2 and b >= 2 and count == 1)
            ):
                res[10] = 1
    if tail >= 4:
        res[8] = 1
    return res


def replay(log):
    """Reproduce upstream synthetic pass/out entries during 接风 and 3/2-player play."""
    histories = [[] for _ in range(4)]
    sequence, out = [], []
    remaining, flag = [27] * 4, 1

    def append(p, cards):
        histories[p].append(cards)
        sequence.append(cards)

    for entry in log:
        p, cards = entry["p"], entry["cards"] or []
        append(p, cards)
        if len(out) == 1:
            if cards and flag == 1:
                flag = 2
                if p == (out[0] + 3) % 4:
                    append(out[0], [-1])
            elif flag == 1 and (p + 1) % 4 == out[0]:
                flag = 2
                append(out[0], [-1])
                append((p + 2) % 4, [])
            elif p == (out[0] + 3) % 4 and flag == 2:
                append(out[0], [-1])
        elif len(out) == 2:
            if cards and flag <= 2:
                flag = 3
                if (p + 1) % 4 in out:
                    append((p + 1) % 4, [-1])
                    append((p + 2) % 4, [-1])
            elif flag <= 2 and (p + 1) % 4 in out:
                flag = 3
                append((p + 1) % 4, [-1])
                append((p + 2) % 4, [-1])
                if p == (out[-1] + 2) % 4:
                    append((p + 3) % 4, [])
            elif (p + 1) % 4 in out and flag == 3:
                append((p + 1) % 4, [-1])
                append((p + 2) % 4, [-1])
        remaining[p] -= len(cards)
        if remaining[p] == 0 and p not in out:
            out.append(p)
    return histories, sequence, out, remaining


def validate(state):
    if not isinstance(state, dict):
        raise ValueError("Expected a game state")
    p, hand, log = state["p"], state["hand"], state["log"]
    if type(p) is not int or not 0 <= p < 4:
        raise ValueError("Invalid seat")
    if not isinstance(hand, list) or not 1 <= len(hand) <= 27 or len(set(hand)) != len(hand):
        raise ValueError("Invalid hand")
    for card in hand:
        card_index(card)
    if not isinstance(log, list) or len(log) > 512:
        raise ValueError("Invalid history")
    seen = set(hand)
    for entry in log:
        if type(entry["p"]) is not int or not 0 <= entry["p"] < 4:
            raise ValueError("Invalid history seat")
        cards = entry["cards"]
        if cards is not None and not isinstance(cards, list):
            raise ValueError("Invalid history cards")
        for card in cards or []:
            card_index(card)
            if card in seen:
                raise ValueError("Repeated physical card")
            seen.add(card)
    counts = state["counts"]
    if (
        not isinstance(counts, list)
        or len(counts) != 4
        or any(type(n) is not int or not 0 <= n <= 27 for n in counts)
    ):
        raise ValueError("Invalid remaining counts")
    expected = [27 - sum(len(e["cards"] or []) for e in log if e["p"] == seat) for seat in range(4)]
    if counts != expected or counts[p] != len(hand):
        raise ValueError("History and remaining counts disagree")
    for name in ("level", "selfLevel", "opponentLevel"):
        if type(state[name]) is not int or not 2 <= state[name] <= 14:
            raise ValueError("Invalid level")
    actions = state["actions"]
    if not isinstance(actions, list) or not 1 <= len(actions) <= 30000:
        raise ValueError("Invalid candidate count")
    holding = set(hand)
    for action in actions:
        if (
            not isinstance(action, list)
            or len(action) > 10
            or any(type(c) is not int for c in action)
            or len(set(action)) != len(action)
            or not set(action) <= holding
        ):
            raise ValueError("Candidate uses cards outside hand")
        if not action and not state.get("canPass", False):
            raise ValueError("Cannot pass when leading")


def encode(state):
    p, log = state["p"], state["log"]
    hand = cards_array(state["hand"])
    unseen = np.full(54, 2, dtype=np.float32) - hand
    for entry in log:
        unseen -= cards_array(entry["cards"] or [])
    histories, sequence, out, _ = replay(log)
    mate = (p + 2) % 4
    last_mate = histories[mate][-1] if histories[mate] and mate not in out else [-1]
    parts = [
        hand,
        universal_flags(hand, state["level"]),
        unseen,
        cards_array(sequence[-1] if sequence else [-1]),
        cards_array(last_mate),
    ]
    for offset in (1, 2, 3):
        played = [c for e in log if e["p"] == (p + offset) % 4 for c in e["cards"] or []]
        parts.append(cards_array(played))
    for offset in (1, 2, 3):
        parts.append(np.eye(28, dtype=np.float32)[state["counts"][(p + offset) % 4]])
    for name in ("selfLevel", "opponentLevel", "level"):
        parts.append(np.eye(13, dtype=np.float32)[state[name] - 2])
    features = np.concatenate(parts)
    assert features.shape == (513,)
    return features


class PolicyNetwork:
    def __init__(self, path=CHECKPOINT):
        with Path(path).open("rb") as stream:
            weights = WeightReader(stream).load()
        dims = [567, 512, 512, 512, 512, 512, 1]
        if not isinstance(weights, list) or len(weights) != 12:
            raise ValueError("Expected the supplied PolicyNetwork DMC checkpoint")
        self.layers = []
        for i, (inputs, outputs) in enumerate(zip(dims, dims[1:])):
            w, b = weights[2 * i : 2 * i + 2]
            if (
                w.shape != (inputs, outputs)
                or b.shape != (outputs,)
                or w.dtype != np.float32
                or b.dtype != np.float32
                or not np.isfinite(w).all()
                or not np.isfinite(b).all()
            ):
                raise ValueError("Unexpected checkpoint layer")
            self.layers.append((w, b))
        self.lock = threading.Lock()

    def values(self, batch):
        for i, (weights, bias) in enumerate(self.layers):
            batch = batch @ weights + bias
            if i < len(self.layers) - 1:
                np.tanh(batch, out=batch)
        return batch[:, 0]

    def decide(self, state):
        validate(state)
        features = encode(state)
        actions = state["actions"]
        scores = []
        start = time.perf_counter()
        with self.lock:
            # Bound memory without discarding suit variants or truncating candidates.
            for first in range(0, len(actions), 256):
                chunk = actions[first : first + 256]
                batch = np.empty((len(chunk), 567), dtype=np.float32)
                batch[:, :513] = features
                batch[:, 513:] = [cards_array(action) for action in chunk]
                scores.extend(self.values(batch).tolist())
        if not np.isfinite(scores).all():
            raise ValueError("Nonfinite model output")
        best = int(np.argmax(scores))
        return {
            "index": best,
            "value": scores[best],
            "candidates": len(actions),
            "elapsedMs": round((time.perf_counter() - start) * 1000),
            "engine": "PolicyNetwork DMC",
        }
