import { prepMs } from '../core/table-timing.mjs';
import { cardHTML } from './cards.js';
// Adapted from Clint e7538a18; examples only, never a policy or training input.
const RULES_L = 2;

// 'SA HK D10 C2 xw dw': spades ace, hearts king, diamonds 10, clubs 2, small joker, big joker; '|' leaves a small gap
export function ruleCards(spec) {
  let id = 1000;
  return spec
    .split(' ')
    .map((t) => {
      if (t === '|') return '<span class="ri-gap"></span>';
      if (t === 'xw' || t === 'dw')
        return cardHTML({ id: id++, s: 'J', r: t === 'dw' ? 17 : 16 }, RULES_L);
      const r = { A: 14, K: 13, Q: 12, J: 11 }[t.slice(1)] || +t.slice(1);
      return cardHTML({ id: id++, s: t[0], r }, RULES_L);
    })
    .join('');
}
const ruleItem = (name, text, { cards, tag, html } = {}) => ({ name, text, cards, tag, html });
export function rulesPages(rules, modelDescription, timing) {
  const trib = rules.trib,
    aFail = rules.aFail;
  return [
    {
      key: 'intro',
      label: '新手入门',
      tabs: [
        {
          label: '基本',
          items: [
            ruleItem(
              '四人两队',
              '你和对家一队，左右两家（上家、下家）是另一队。两副牌共 108 张，每人 27 张，按逆时针轮流出牌。',
            ),
            ruleItem(
              '出牌与跟牌',
              '先出的人可以出任意一种牌型；后面的人要出同一牌型、同样张数并且更大的牌，或者「过」。炸弹可以压任何不是炸弹的牌。其他三家都不要时，最后出牌的人重新先出。',
              { cards: 'H8 C8 | S10 D10', tag: '对 10 压对 8' },
            ),
            ruleItem(
              '接风',
              '一个人出完了手里的牌，其他人都不要他最后那手牌时，由他的队友接着先出。',
            ),
            ruleItem(
              '名次与胜负',
              '第一个出完的是头游，接着是二游、三游，剩下的是末游。每局结束时头游所在的一方升级；先从 2 打到 A 并且打过的一方赢下整场。',
            ),
            ruleItem('这一桌的电脑', `没坐人的座位由电脑来打，这一桌用的是：${modelDescription}。`),
          ],
        },
        {
          label: '牌的大小',
          items: [
            ruleItem(
              '从大到小',
              '大王 > 小王 > 级牌 > A > K > Q > … > 3 > 2。本局打几，几就是级牌：比 A 大，只比大小王小。',
              { cards: 'dw xw S2 SA SK SQ SJ S10 S9 S8 S7 S6 S5 S4 S3', tag: '以打 2 为例' },
            ),
            ruleItem('花色不分大小', '同样点数的牌一样大，花色只在同花顺里有用。', {
              cards: 'S9 H9 C9 D9',
            }),
            ruleItem(
              '级牌',
              '两队各有自己的级数，每局打「打级方」的级。牌面上标「级」的就是级牌。',
              { cards: 'S2 C2 D2', tag: '级牌' },
            ),
          ],
        },
        {
          label: '百搭',
          items: [
            ruleItem(
              '红心级牌是百搭',
              '红心的级牌（打 2 时就是红桃 2）可以当除大小王以外的任意一张牌用，两副牌共两张，牌面上有皇冠。',
              { cards: 'H2 H2', tag: '百搭' },
            ),
            ruleItem('补成对子', '百搭和一张 7 就是一对 7。', { cards: 'S7 H2' }),
            ruleItem('补进顺子', '缺一张也能连成顺子：3、百搭（当 4）、5、6、7。', {
              cards: 'S3 H2 C5 D6 S7',
            }),
            ruleItem('补成炸弹', '三张 Q 加一张百搭就是四张 Q 的炸弹。', {
              cards: 'SQ HQ CQ H2',
              tag: '炸弹',
            }),
          ],
        },
      ],
    },
    {
      key: 'types',
      label: '牌型一览',
      tabs: [
        {
          label: '普通牌型',
          items: [
            ruleItem('单张', '任意一张牌。', { cards: 'SK' }),
            ruleItem('对子', '两张点数一样的牌。', { cards: 'H8 C8' }),
            ruleItem('三张', '三张点数一样的牌，不带别的牌。', { cards: 'S9 H9 D9' }),
            ruleItem('三带二', '三张一样的牌带一对，比大小只看三张。', {
              cards: 'SQ HQ CQ | S5 D5',
              tag: '三张 + 一对',
            }),
            ruleItem(
              '顺子',
              '5 张点数相连的牌。A 可以当 1（A2345）也可以当 14（10JQKA），顺子里不能有大小王。',
              { cards: 'S3 H4 C5 D6 S7', tag: '刚好 5 张' },
            ),
            ruleItem('连对', '3 对点数相连的对子。', {
              cards: 'S4 H4 | C5 D5 | S6 H6',
              tag: '3 对相连',
            }),
            ruleItem('钢板', '2 个点数相连的三张。', {
              cards: 'S8 H8 C8 | D9 S9 H9',
              tag: '2 个三张相连',
            }),
          ],
        },
        {
          label: '炸弹',
          items: [
            ruleItem(
              '炸弹压一切',
              '炸弹可以压任何不是炸弹的牌型。炸弹之间按下面的顺序比，越往下越大；张数一样的炸弹比点数。',
            ),
            ruleItem('4 张炸弹', '四张点数一样的牌，最小的炸弹。', {
              cards: 'S6 H6 C6 D6',
              tag: '最小',
            }),
            ruleItem('5 张炸弹', '五张点数一样的牌。', { cards: 'S10 H10 C10 D10 S10' }),
            ruleItem('同花顺', '同一花色的顺子：比 5 张炸弹大，比 6 张炸弹小。', {
              cards: 'H9 H10 HJ HQ HK',
              tag: '5 张 < 同花顺 < 6 张',
            }),
            ruleItem('6 张及以上炸弹', '张数越多越大，6 张 < 7 张 < 8 张，百搭还可以补成更多张。', {
              cards: 'SJ HJ CJ DJ SJ HJ',
              tag: '6 张',
            }),
            ruleItem('天王炸', '两张大王加两张小王，全场最大，什么都能压。', {
              cards: 'xw xw dw dw',
              tag: '最大',
            }),
          ],
        },
      ],
    },
    {
      key: 'level',
      label: '升级进贡',
      tabs: [
        {
          label: '升级',
          items: [
            ruleItem('头游一方升级', '每局头游所在的一方升级，升几级看头游的队友排第几：', {
              html: '<div class="ri-steps"><span><b>二游</b>升 3 级</span><span><b>三游</b>升 2 级</span><span><b>末游</b>升 1 级</span></div>',
              tag: '看队友名次',
            }),
            ruleItem('下一局打谁的级', '升级的一方下一局打自己的级；没升级的一方级数不变。'),
          ],
        },
        {
          label: '进贡还贡',
          items: trib
            ? [
                ruleItem(
                  '进贡',
                  '从第二局起，上一局的末游把自己最大的一张牌（百搭除外）进贡给头游；最大的牌有几种花色时，自己选进贡哪一张，限时 30 秒。',
                  { cards: 'SA', tag: '末游 → 头游' },
                ),
                ruleItem(
                  '还贡',
                  '头游理完牌后，还一张 10 或以下的非百搭牌；没有合适低牌时还最小非百搭牌，限时 60 秒。',
                  { cards: 'C6', tag: '头游 → 末游' },
                ),
                ruleItem(
                  '双下',
                  '上一局一方是三游和末游（双下）时，两人都要进贡，分别给头游和二游。',
                ),
                ruleItem(
                  '抗贡',
                  '要进贡的一方合起来有两张大王（一人两张，或双下时两人各一张），就可以抗贡：这一局不进贡也不还贡，由上一局头游先出。',
                  { cards: 'dw dw', tag: '两张大王' },
                ),
              ]
            : [ruleItem('本场不进贡', '这一桌选了不进贡：每局由上一局的头游先出。')],
        },
        {
          label: '打 A',
          items: [
            ruleItem(
              '打过 A 赢下整场',
              '打到 A 的一方，这一局拿到头游并且队友不是末游（队友二游或三游），就赢下整场。',
              { cards: 'SA HA', tag: '整场胜利' },
            ),
            ruleItem(
              '三次机会',
              aFail === 'keep'
                ? '本桌打 A 不限次数，直到一方通过。'
                : aFail === 'once'
                  ? '每一方打 A 有三次机会。一方三次都没打过后，对方轮到打 A 时只有一次机会：打过算对方赢，没打过算双方平局。'
                  : `每一方打 A 有三次机会，三次都没打过${aFail === 'draw' ? '，本场算平局' : '，这一方从 2 重新打'}。`,
              {
                tag:
                  aFail === 'keep'
                    ? '不限次数'
                    : aFail === 'once'
                      ? '一次机会'
                      : aFail === 'draw'
                        ? '平局'
                        : '从 2 打',
              },
            ),
          ],
        },
      ],
    },
    {
      key: 'play',
      label: '操作计时',
      tabs: [
        {
          label: '出牌',
          items: [
            ruleItem(
              '选牌出牌',
              '点牌选中，再点「出牌」；双击任意一张牌直接出。「提示」依次给出能出的牌，「过」是这一轮不要，「重选」取消已选的牌。',
            ),
            ruleItem(
              '出牌需确认',
              '在「选项」里打开后，点出牌时选中的牌先放大，再点「确认」才出，防止点错。',
            ),
          ],
        },
        {
          label: '理牌',
          items: [
            ruleItem(
              '三种排法',
              '理牌方式按钮每点一下，依次换成「横式」「竖式」「手持」。竖式按大小从左到右排，同样点数叠成一列，一眼看出每个点数有几张；手持像握在手里一样展开成弧形，可选两排或三排。',
            ),
            ruleItem(
              '拖动与连选',
              '按住没选中的牌滑过几张，是连选这些牌；从选中的牌上按住拖动，是把它们一起挪到别处，也可以拖进左边的成组区。「复原」恢复成按大小排好的样子。',
            ),
            ruleItem(
              '成组区',
              '把选好的牌点「成组」放进左边的成组区，作为你拟定的一组牌，旁边会写出它是什么牌型。',
            ),
          ],
        },
        {
          label: '计时',
          items: [
            ruleItem(
              '一局的流程',
              `洗牌、切牌（上一局头游的上家洗、头游切，第一局随机）→ 发牌 → 进贡 → ${prepMs(rules) / 1000} 秒理牌（理好点「理牌结束」）→ 还贡 → 出牌。`,
              { tag: '每局开始' },
            ),
            ruleItem('限时', timing),
            ruleItem(
              '超时代打',
              'Clint 接管超时时，跟牌直接过；领出优先活动区整组小牌，再考虑已成组非炸牌和最小炸弹。神经网络和独立明牌工具沿用各自决策，不混用 Clint 策略。',
              { tag: '超时' },
            ),
          ],
        },
      ],
    },
  ];
}
