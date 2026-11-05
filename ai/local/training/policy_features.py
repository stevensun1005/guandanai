"""Public supplementary features shared with src/ai/policy-features.mjs."""

import numpy as np

POLICY_EXTRA_FEATURES = 53
POLICY_EXTRA_VERSION = 1
POLICY_ACTION_TYPES = (
    "single",
    "pair",
    "triple",
    "full",
    "straight",
    "pairs3",
    "trip2",
    "bomb",
    "sflush",
    "jokers",
)


def _rank(card):
    face = card % 54
    return face - 36 if face >= 52 else face % 13 + 2


def _wild(card, level):
    return (card % 54) // 13 == 1 and _rank(card) == level


def _value(shape):
    return 1.0 if shape["type"] == "jokers" else shape["value"] / 17


def _prepare_policy_extras(state):
    if len(state.get("actionShapes", [])) != len(state["actions"]):
        raise ValueError("Invalid residual action inputs")
    p, counts, log = (state[x] for x in ("p", "counts", "log"))
    result = np.zeros(POLICY_EXTRA_FEATURES, dtype=np.float32)
    trick = state.get("trick") if state["canPass"] else None
    if state["canPass"] and not trick:
        raise ValueError("Missing public trick")
    result[0] = bool(trick)
    if trick:
        result[1 + (trick["player"] - p) % 4] = 1
        result[5 + POLICY_ACTION_TYPES.index(trick["play"]["type"])] = 1
        result[15] = _value(trick["play"])
        result[16] = trick["play"]["n"] / 10
        passes = 0
        for entry in reversed(log):
            if entry["cards"]:
                break
            passes += 1
        result[17] = min(3, passes) / 3
    played = [0, 0, 0, 0]
    first = -1
    for entry in log:
        played[entry["p"]] += len(entry["cards"] or [])
        if played[entry["p"]] == 27:
            first = entry["p"]
            break
    result[18 + (0 if first < 0 else 1 if first % 2 == p % 2 else 2)] = 1
    result[41] = bool(trick and trick["player"] == (p + 2) % 4)
    result[42] = sum(count > 0 for count in counts) / 4
    opponents = [counts[seat] for seat in ((p + 1) % 4, (p + 3) % 4) if counts[seat] > 0]
    result[44] = min(opponents) / 27 if opponents else 0
    return result


def encode_policy_extras(state, action_index, prepared=None):
    """No opponent cards, sampled determinizations or private state are accepted."""
    if type(action_index) is not int or not 0 <= action_index < len(state["actions"]):
        raise ValueError("Invalid residual action inputs")
    if prepared is None:
        prepared = _prepare_policy_extras(state)
    p, hand, counts, level = (state[x] for x in ("p", "hand", "counts", "level"))
    action = state["actions"][action_index]
    shape = state["actionShapes"][action_index]
    result = prepared.copy()
    if action:
        result[22 + POLICY_ACTION_TYPES.index(shape["type"])] = 1
        result[32] = _value(shape)
        result[33] = len(action) / 10
        result[34] = sum(_wild(card, level) for card in action) / 2
        result[35] = sum(_rank(card) == level or _rank(card) >= 16 for card in action) / 10
    else:
        result[21] = 1
    used = set(action)
    remaining = [card for card in hand if card not in used]
    result[36] = len(remaining) / 27
    for step in range(1, 5):
        seat = (p + step) % 4
        if (len(remaining) if seat == p else counts[seat]) > 0:
            result[37 + step % 4] = 1
            break
    result[43] = bool(action and not remaining)
    ranks = {}
    wilds = jokers = levels = 0
    for card in remaining:
        rank = _rank(card)
        levels += rank == level
        jokers += rank >= 16
        if _wild(card, level):
            wilds += 1
        else:
            ranks[rank] = ranks.get(rank, 0) + 1
    for count in ranks.values():
        result[44 + count if count <= 3 else 48] += 1
    result[45:49] /= 13
    result[49] = wilds / 2
    result[50] = jokers / 4
    result[51] = levels / 8
    result[52] = len(ranks) / 15
    return result


def encode_policy_extras_batch(state):
    """Return [actions,53], processing the public history once per decision."""
    prepared = _prepare_policy_extras(state)
    return np.array(
        [encode_policy_extras(state, index, prepared) for index in range(len(state["actions"]))],
        dtype=np.float32,
    ).reshape(-1, POLICY_EXTRA_FEATURES)
