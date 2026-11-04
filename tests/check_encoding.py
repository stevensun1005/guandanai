"""Check every feature against the actual upstream client, without its old runtime.

Run after node tests/check_ai.js. AST loads only the original pure feature methods;
TensorFlow, websocket, ZeroMQ and training processes are never imported or run.
"""

import ast
import json
from pathlib import Path
import sys
from functools import reduce
from collections import Counter

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from ai.reference.numpy_engine import PolicyNetwork, encode, validate, cards_array, card_index

UPSTREAM = ROOT / "ai/reference"
namespace = {"np": np, "reduce": reduce, "Counter": Counter, "json": json}
util = ast.parse((UPSTREAM / "util.py").read_text(encoding="utf-8"))
utility_nodes = [
    n
    for n in util.body
    if isinstance(n, ast.FunctionDef)
    and n.name in ("card2array", "card2num")
    or isinstance(n, ast.Assign)
    and any(isinstance(t, ast.Name) and t.id == "CardToNum" for t in n.targets)
]
exec(compile(ast.Module(body=utility_nodes, type_ignores=[]), "upstream_util", "exec"), namespace)
source = ast.parse((UPSTREAM / "client0.py").read_text(encoding="utf-8"))
nodes = [
    n
    for n in source.body
    if isinstance(n, ast.FunctionDef)
    and n.name == "_get_one_hot_array"
    or isinstance(n, ast.Assign)
    and any(isinstance(t, ast.Name) and t.id == "RANK" for t in n.targets)
]
original = next(n for n in source.body if isinstance(n, ast.ClassDef) and n.name == "ExampleClient")
reference = ast.ClassDef(
    name="Reference",
    bases=[],
    keywords=[],
    decorator_list=[],
    body=[
        n
        for n in original.body
        if isinstance(n, ast.FunctionDef)
        and n.name in ("received_message", "prepare", "proc_universal")
    ],
)
nodes.append(reference)
exec(
    compile(
        ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])),
        "upstream_client",
        "exec",
    ),
    namespace,
)


def card_name(card):
    n = card % 54
    if n >= 52:
        return ("SB", "HR")[n - 52]
    return "SHCD"[n // 13] + "23456789TJQKA"[n % 13]


def reference_batch(state):
    ref = namespace["Reference"]()
    ref.mypos = state["p"]
    ref.history_action = {p: [] for p in range(4)}
    ref.action_seq, ref.action_order, ref.over = [], [], []
    ref.remaining, ref.flag = {p: 27 for p in range(4)}, 1
    initial = state["hand"] + [
        c for e in state["log"] if e["p"] == ref.mypos for c in e["cards"] or []
    ]
    encoded = namespace["card2num"]([card_name(c) for c in initial])
    ref.other_left_hands = [2] * 54
    for c in encoded:
        ref.other_left_hands[c] -= 1
    for entry in state["log"]:
        ref.received_message(
            json.dumps(
                {
                    "type": "notify",
                    "stage": "play",
                    "curPos": entry["p"],
                    "curAction": [None, None, [card_name(c) for c in entry["cards"] or []]],
                }
            )
        )
    rank = lambda n: "23456789TJQKA"[n - 2]
    return ref.prepare(
        {
            "indexRange": len(state["actions"]) - 1,
            "actionList": [[None, None, [card_name(c) for c in a]] for a in state["actions"]],
            "handCards": [card_name(c) for c in state["hand"]],
            "curRank": rank(state["level"]),
            "selfRank": rank(state["selfLevel"]),
            "oppoRank": rank(state["opponentLevel"]),
        }
    )["x_batch"]


def main():
    states = json.loads((ROOT / "tests/fixtures/positions.json").read_text())
    for i, state in enumerate(states):
        # End-of-round diagnostic snapshots use candidates without a pass.
        validate(state)
        actual = np.array(
            [np.concatenate((encode(state), cards_array(a))) for a in state["actions"]]
        )
        np.testing.assert_array_equal(actual, reference_batch(state), err_msg=f"snapshot {i}")
    print(f"{len(states)} snapshots: all 567 features exactly match upstream")
    # Exercise every suit, rank, deck copy and joker explicitly.
    for card in range(108):
        reference = namespace["card2array"](namespace["card2num"]([card_name(card)]))
        np.testing.assert_array_equal(cards_array([card]), reference)
    model = PolicyNetwork()
    rng = np.random.default_rng(17)
    batch = rng.normal(size=(5, 567)).astype(np.float32)
    np.testing.assert_allclose(
        model.values(batch), [model.values(row[None])[0] for row in batch], atol=2e-5
    )
    bad = {**states[0], "hand": states[0]["hand"] + states[0]["hand"][:1]}
    try:
        validate(bad)
    except ValueError:
        pass
    else:
        raise AssertionError("duplicate cards accepted")
    print("108 card mappings, batched inference and invalid-state rejection passed")


if __name__ == "__main__":
    main()
