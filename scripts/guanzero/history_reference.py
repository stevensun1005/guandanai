"""Independent Python replay and client0-style 20-action/5x216 encoding."""
def replay(log):
    histories, sequence, out, remaining = [[], [], [], []], [], [], [27]*4
    flag = 1
    def append(p, cards):
        histories[p].append(cards)
        sequence.append(cards)
    for entry in log:
        p, cards = entry['p'], entry.get('cards') or []
        append(p, cards)
        if len(out) == 1:
            if cards and flag == 1:
                flag = 2
                if p == (out[0]+3)%4: append(out[0], [-1])
            elif flag == 1 and (p+1)%4 == out[0]:
                flag = 2
                append(out[0], [-1]); append((p+2)%4, [])
            elif p == (out[0]+3)%4 and flag == 2: append(out[0], [-1])
        elif len(out) == 2:
            if cards and flag <= 2:
                flag = 3
                if (p+1)%4 in out:
                    append((p+1)%4, [-1]); append((p+2)%4, [-1])
            elif flag <= 2 and (p+1)%4 in out:
                flag = 3
                append((p+1)%4, [-1]); append((p+2)%4, [-1])
                if p == (out[-1]+2)%4: append((p+3)%4, [])
            elif (p+1)%4 in out and flag == 3:
                append((p+1)%4, [-1]); append((p+2)%4, [-1])
        remaining[p] -= len(cards)
        if remaining[p] == 0 and p not in out: out.append(p)
    return histories, sequence, out

def history(state):
    sequence = replay(state['log'])[1][-20:]
    sequence = [[] for _ in range(20-len(sequence))] + sequence
    encoded = []
    for cards in sequence:
        row = [0]*54
        if cards == [-1]: row = [-1]*54
        else:
            for card in cards:
                n = card % 54
                index = n if n >= 52 else (n%13)*4 + [1,0,2,3][n//13]
                row[index] += 1
        encoded.extend(row)
    return encoded
