/**
 * v6 API 层验证（对应用户的 5 条需求）：
 *   ① 15m K 线接口：数量、与 1h 对齐、interval 参数行为
 *   ② BTC/ETH 数据齐全：15m 覆盖足够长的历史
 *   ③ 登录 + 账号数据隔离 + 登出失效
 *   ④ 胜率 PK：9 维度对比 + leader 判定
 *   ⑤ 强制复盘跳过 → 待补列表 → 补写后置为已写
 *
 * 纯 HTTP 层验证，不依赖浏览器。
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';

let pass = 0;
let fail = 0;
function log(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

/** 带 token 的 JSON 请求 */
async function req(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 无 body */
  }
  return { status: res.status, json };
}

/** 每个 1h 桶里有几根 15m */
function bucketCounts(bars1h, bars15m) {
  const m = new Map();
  for (const b of bars15m) {
    const k = Math.floor(b.time / 3600000);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  const stat = { full: 0, partial: 0, missing: 0, zero: 0 };
  for (const b of bars1h) {
    const k = Math.floor(b.time / 3600000);
    const c = m.get(k) ?? 0;
    if (c === 4) stat.full++;
    else if (c > 0) stat.partial++;
    else stat.missing++;
    if (c === 0) stat.zero++;
  }
  return stat;
}

const rnd = Math.random().toString(36).slice(2, 8);

console.log('\n═══ ① 15m K 线接口 ═══');

for (const symbol of ['BTCUSDT', 'ETHUSDT']) {
  const r = await req(`/api/klines?symbol=${symbol}&market=perp&interval=both&limit=1200`);
  const j = r.json ?? {};
  const b1 = j.bars1h ?? [];
  const b15 = j.bars15m ?? [];

  log(`${symbol} 接口 200`, r.status === 200, `HTTP ${r.status}`);
  log(`${symbol} 返回 15m 序列`, b15.length > 0, `${b15.length} 根`);
  log(
    `${symbol} 15m 根数 = 1h 的 4 倍量级`,
    b15.length >= Math.min(b1.length * 4, 4800),
    `1h=${b1.length} 15m=${b15.length}`,
  );

  // 15m 自身的时间步长必须是 900000ms
  let badStep = 0;
  for (let i = 1; i < b15.length; i++) {
    if (b15[i].time - b15[i - 1].time !== 900000) badStep++;
  }
  log(`${symbol} 15m 时间步长严格为 15 分钟`, badStep === 0, `异常 ${badStep} 处`);

  // 与 1h 对齐
  const st = bucketCounts(b1, b15);
  const alignRate = (st.full / Math.max(1, st.full + st.partial + st.missing)) * 100;
  log(
    `${symbol} 15m 与 1h 桶对齐（≥99% 的 1h 桶有 4 根 15m）`,
    alignRate >= 99,
    `完整 ${st.full} / 部分 ${st.partial} / 缺 ${st.missing} → ${alignRate.toFixed(2)}%`,
  );

  // 末尾允许 1 个不完整桶（当前小时还没走完）
  log(`${symbol} 缺失桶 ≤ 1（仅当前未走完小时）`, st.missing <= 1, `缺 ${st.missing} 个`);
}

// interval 参数行为
const r15 = await req('/api/klines?symbol=BTCUSDT&market=perp&interval=15m&limit=500');
const b15only = r15.json?.bars ?? [];
// limit 是「1h 根数」口径；15m 是同一时间跨度 → 根数 ×4（见路由 limit15 换算）
log(
  'interval=15m 直接返回 15m 序列（limit 口径 = 1h 根数 ×4）',
  b15only.length > 0 && b15only.length === 500 * 4,
  `${b15only.length} 根（期望 ${500 * 4}）`,
);
log(
  'interval=15m 时不重复下发 1h/4h',
  !r15.json?.bars1h && !r15.json?.bars4h,
  `keys=${Object.keys(r15.json ?? {}).join(',')}`,
);

const r1 = await req('/api/klines?symbol=BTCUSDT&market=perp&interval=1h&limit=200');
log('interval=1h 不下发 15m（省带宽）', (r1.json?.count15m ?? 0) === 0, `count15m=${r1.json?.count15m}`);

console.log('\n═══ ② BTC/ETH 数据齐全 ═══');

for (const symbol of ['BTCUSDT', 'ETHUSDT']) {
  const cov = await req(`/api/klines/${symbol}/coverage?market=perp&interval=15m`);
  const bars = cov.json?.bars ?? 0;
  const first = cov.json?.firstTime ? new Date(cov.json.firstTime) : null;
  const days = first ? Math.round((Date.now() - first.getTime()) / 86400000) : 0;
  log(
    `${symbol} 15m 覆盖 ≥ 1000 天`,
    days >= 1000,
    `${bars} 根 / ${first ? first.toISOString().slice(0, 10) : 'NA'} 起 / ${days} 天`,
  );
}

console.log('\n═══ ③ 登录 + 数据隔离 ═══');

const userA = `v6test_a_${rnd}`;
const userB = `v6test_b_${rnd}`;

const regA = await req('/api/auth/register', {
  method: 'POST',
  body: { username: userA, password: 'test1234', displayName: '甲' },
});
log('用户 A 注册成功', regA.status === 201 && !!regA.json?.token, `HTTP ${regA.status}`);
const tokenA = regA.json?.token;

const regB = await req('/api/auth/register', {
  method: 'POST',
  body: { username: userB, password: 'test1234', displayName: '乙' },
});
log('用户 B 注册成功', regB.status === 201 && !!regB.json?.token, `HTTP ${regB.status}`);
const tokenB = regB.json?.token;

const meA = await req('/api/auth/me', { token: tokenA });
log('Bearer token 可解析出当前用户', meA.json?.user?.username === userA, meA.json?.user?.username);

const noAuth = await req('/api/auth/me');
log('未登录时 /me 返回 user=null（不报错）', noAuth.status === 200 && noAuth.json?.user === null);

const dup = await req('/api/auth/register', {
  method: 'POST',
  body: { username: userA, password: 'test1234' },
});
log('重复用户名被拒绝', dup.status === 400, `HTTP ${dup.status} ${dup.json?.error ?? ''}`);

const badPwd = await req('/api/auth/login', {
  method: 'POST',
  body: { username: userA, password: 'wrongpass' },
});
log('错误密码登录被拒', badPwd.status === 401, `HTTP ${badPwd.status}`);

// A 建一个 session + 一笔交易
const sess = await req('/api/sessions', {
  method: 'POST',
  token: tokenA,
  body: {
    symbol: 'BTCUSDT',
    market: 'perp',
    startTime: new Date(Date.now() - 86400000).toISOString(),
    equityStart: 10000,
    meta: { tag: 'v6-isolation-test' },
  },
});
log('A 创建 session 成功', sess.status === 201 && !!sess.json?.id, `id=${sess.json?.id}`);
const sessIdA = sess.json?.id;

const trade = await req('/api/trades', {
  method: 'POST',
  token: tokenA,
  body: {
    sessionId: sessIdA,
    symbol: 'BTCUSDT',
    market: 'perp',
    side: 'long',
    entryTime: new Date(Date.now() - 3600000).toISOString(),
    entryPrice: 100,
    stopLoss: 98,
    takeProfit: 104,
    riskAmount: 200,
    qty: 100,
    // v6 扩展字段一并落库
    entryMode: 'limit',
    limitPrice: 99.5,
    stopType: 'atr',
    stopValue: 1.5,
    tpType: 'r',
    tpValue: 2,
    sizeMode: 'risk',
    sizeValue: 2,
    feeRate: 0.0004,
    slippageBps: 3,
    timeStopHrs: 24,
    confidence: 4,
    notes: 'v6 扩展字段测试',
  },
});
log('A 创建交易成功', trade.status === 201 && !!trade.json?.id, `id=${trade.json?.id}`);

const ext = trade.json ?? {};
log(
  '13 个开仓扩展字段全部落库',
  ext.entryMode === 'limit' &&
    Number(ext.limitPrice) === 99.5 &&
    ext.stopType === 'atr' &&
    Number(ext.stopValue) === 1.5 &&
    ext.tpType === 'r' &&
    Number(ext.tpValue) === 2 &&
    ext.sizeMode === 'risk' &&
    Number(ext.sizeValue) === 2 &&
    Number(ext.feeRate) === 0.0004 &&
    Number(ext.slippageBps) === 3 &&
    ext.timeStopHrs === 24 &&
    ext.confidence === 4 &&
    ext.notes === 'v6 扩展字段测试',
  `entryMode=${ext.entryMode} stopType=${ext.stopType} tpType=${ext.tpType} sizeMode=${ext.sizeMode} conf=${ext.confidence}`,
);

// 隔离：B 看不到 A 的 session / trade
const bSessions = await req('/api/sessions', { token: tokenB });
const bSees = (bSessions.json ?? []).some((s) => s.id === sessIdA);
log('B 看不到 A 的 session（数据隔离）', !bSees, `B 看到 ${(bSessions.json ?? []).length} 个`);

const aSessions = await req('/api/sessions', { token: tokenA });
log('A 能看到自己的 session', (aSessions.json ?? []).some((s) => s.id === sessIdA));

const bDetail = await req(`/api/sessions/${sessIdA}`, { token: tokenB });
log('B 直接按 id 取 A 的 session 被拒（404）', bDetail.status === 404, `HTTP ${bDetail.status}`);

const bPatch = await req(`/api/sessions/${sessIdA}`, {
  method: 'PATCH',
  token: tokenB,
  body: { status: 'closed' },
});
log('B 改不了 A 的 session', bPatch.status === 404, `HTTP ${bPatch.status}`);

// 登出 → token 失效
const lo = await req('/api/auth/logout', { method: 'POST', token: tokenA });
log('登出返回 ok', lo.status === 200 && lo.json?.ok === true);
const afterLo = await req('/api/auth/me', { token: tokenA });
log('登出后 token 失效', afterLo.json?.user === null, `user=${JSON.stringify(afterLo.json?.user)}`);

console.log('\n═══ ④ 胜率 PK ═══');

const pk = await req('/api/auth/pk');
const players = pk.json?.players ?? [];
const comparisons = pk.json?.comparisons ?? [];
log('PK 返回玩家列表', players.length >= 2, `${players.length} 人`);
log('两个测试账号都在名单里', players.some((p) => p.username === userA) && players.some((p) => p.username === userB));
log('PK 返回 9 个对比维度', comparisons.length === 9, `${comparisons.length} 个：${comparisons.map((c) => c.label).join('/')}`);

const EXPECTED_DIMS = [
  ['winRate', '胜率'],
  ['expectancy', '单笔期望'],
  ['totalR', '累计R'],
  ['avgR', '平均R'],
  ['profitFactor', '盈亏比'],
  ['maxDrawdown', '最大回撤'],
  ['adherenceRate', '守规则率'],
  ['closed', '已平仓笔数'],
  ['avgHoldHours', '平均持仓(h)'],
];
const missingDims = EXPECTED_DIMS.filter(([k]) => !comparisons.some((c) => c.key === k));
log('9 个维度键名齐全', missingDims.length === 0, `缺=${missingDims.map((d) => d[0]).join(',') || '无'}`);

const eachDimHasValues = comparisons.every(
  (c) => Array.isArray(c.values) && c.values.length === players.length && c.values.every((v) => 'display' in v),
);
log('每个维度都有全员数值 + 展示文案', eachDimHasValues);

const leaderOk = comparisons.every(
  (c) => c.leader === null || players.some((p) => p.userId === c.leader),
);
log('leader 指向合法玩家（或并列为 null）', leaderOk);

// 计数不放大：A 有 1 笔 open 交易（未平仓）→ closed 应为 0，不该被 journal 行放大
const pa = players.find((p) => p.username === userA);
log('A 已平仓笔数 = 0（未平仓的交易不计入）', pa?.closed === 0, `closed=${pa?.closed}`);

console.log('\n═══ ⑤ 强制复盘跳过 → 待补 → 补写 ═══');

const jr = await req('/api/journal', {
  method: 'POST',
  token: tokenB,
  body: {
    sessionId: sessIdA, // 故意指向 A 的 session，验证 B 的记录仍挂在自己名下
    symbol: 'BTCUSDT',
    market: 'perp',
    content: '',
    skipped: true,
    snapshot: { r: 0.5 },
  },
});
log('跳过复盘可落库（skipped=true）', jr.status === 201 && jr.json?.skipped === true, `id=${jr.json?.id}`);
const jid = jr.json?.id;

const pend = await req('/api/auth/pending-journal');
log('待补复盘计数 ≥ 1', (pend.json?.pending ?? 0) >= 1, `pending=${pend.json?.pending}`);

const bJournal = await req('/api/journal', { token: tokenB });
log('B 能看到自己的待补记录', (bJournal.json ?? []).some((j) => j.id === jid));

const fill = await req(`/api/journal/${jid}`, {
  method: 'PUT',
  token: tokenB,
  body: { followedPlan: true, emotion: '平静', mistakeTag: null, content: '补写复盘内容' },
});
log('补写成功且 skipped 置回 false', fill.status === 200 && fill.json?.skipped === false, `skipped=${fill.json?.skipped}`);

const pend2 = await req('/api/auth/pending-journal');
log('补写后待补计数下降', (pend2.json?.pending ?? 0) < (pend.json?.pending ?? 0), `${pend.json?.pending} → ${pend2.json?.pending}`);

// 越权补写：A 不能改 B 的记录
const tokenA2 = (await req('/api/auth/login', { method: 'POST', body: { username: userA, password: 'test1234' } }))
  .json?.token;
const cross = await req(`/api/journal/${jid}`, {
  method: 'PUT',
  token: tokenA2,
  body: { content: '越权写入' },
});
log('跨账号补写被拒（404）', cross.status === 404, `HTTP ${cross.status}`);

console.log(`\n═══ API 层结果：${pass} 通过 / ${fail} 失败 ═══`);
if (fail > 0) process.exitCode = 1;
