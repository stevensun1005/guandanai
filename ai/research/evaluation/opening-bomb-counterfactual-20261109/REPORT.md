# Opening bomb counterfactual (development check)

Not an acceptance result, a win rate or a strength claim. Protocol opening-bomb-counterfactual-v1; champion 017 (SHA-256 462afc99ee6bcfb788871d7a8f84d4298c008d57465c62d48ca1792cdb11b3f7); belief 16d767830e4536180fac56d744e95934b7525ab67b18d27df4f33066033d65e9. Deal seeds from 4300000000; 803 positions completed (target 800; status complete).

d = acting team round points with move B (highest-Q non-bomb) minus with move A (champion bomb). P1 = all seats raw 017 greedy after the forced move; P2 = all seats the deployed reasoning bot (9001). 95% percentile bootstrap over positions, 10,000 resamples.

**Reading (rule fixed before results): (iii) inconclusive at this size; P2 interval half-width 0.161.**

| Group | n | mean d | 95% bootstrap | d > 0 | d = 0 | d < 0 |
|---|---|---|---|---|---|---|
| P1 all | 803 | -0.014 | [-0.173, 0.146] | 33.3% | 35.5% | 31.3% |
| P2 all | 803 | -0.136 | [-0.296, 0.025] | 32.8% | 32.9% | 34.4% |
| d_P2 - d_P1 | 803 | -0.122 | [-0.264, 0.021] | 28.6% | 38.5% | 32.9% |

## P1

Mean outcome arm A (bomb) -0.004, arm B (no bomb) -0.017.

| Group | n | mean d | 95% bootstrap | d > 0 | d = 0 | d < 0 |
|---|---|---|---|---|---|---|
| table cards >80 | 696 | -0.006 | [-0.174, 0.161] | 33.3% | 35.3% | 31.3% |
| table cards 61-80 | 107 | -0.065 | [-0.495, 0.364] | 32.7% | 36.4% | 30.8% |
| visible trick | 548 | 0.075 | [-0.115, 0.266] | 34.3% | 34.7% | 31.0% |
| blind follow | 255 | -0.204 | [-0.486, 0.071] | 31.0% | 37.3% | 31.8% |
| trick single | 336 | 0.077 | [-0.158, 0.313] | 31.8% | 38.4% | 29.8% |
| trick other | 426 | -0.094 | [-0.319, 0.127] | 34.0% | 32.4% | 33.6% |
| trick pair | 41 | 0.073 | [-0.585, 0.683] | 36.6% | 43.9% | 19.5% |

## P2

Mean outcome arm A (bomb) 0.057, arm B (no bomb) -0.078.

| Group | n | mean d | 95% bootstrap | d > 0 | d = 0 | d < 0 |
|---|---|---|---|---|---|---|
| table cards >80 | 696 | -0.144 | [-0.313, 0.022] | 32.2% | 32.8% | 35.1% |
| table cards 61-80 | 107 | -0.084 | [-0.533, 0.364] | 36.4% | 33.6% | 29.9% |
| visible trick | 548 | -0.044 | [-0.230, 0.146] | 35.2% | 32.7% | 32.1% |
| blind follow | 255 | -0.333 | [-0.627, -0.039] | 27.5% | 33.3% | 39.2% |
| trick single | 336 | 0.012 | [-0.220, 0.244] | 33.9% | 34.2% | 31.8% |
| trick other | 426 | -0.268 | [-0.495, -0.054] | 31.7% | 31.0% | 37.3% |
| trick pair | 41 | 0.024 | [-0.610, 0.659] | 34.1% | 41.5% | 24.4% |

## Other

- Move B is a pass in 72.5% of positions; blind follows 31.8%.
- P2 search fallbacks to 017: midgame 0 of 17209 requests, endgame 13 of 8787 ({"endgame:budget":13}).
- Mean wall time per position (4 rounds): 11.903 s.
