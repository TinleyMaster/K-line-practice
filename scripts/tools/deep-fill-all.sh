#!/usr/bin/env bash
# 其余标的的 15m 深历史（批量慢跑，正式工具）
# 用法：npm run deep:fill:all
# 目标：拉到币安各自的上市日（--since 给最早点，币安自己决定有多少）
# 限速：每个标的之间 sleep 20s，把请求摊薄到 <5 次/分钟
# 预计：68 个标的 × ~3 分钟 ≈ 3~4 小时
set -u
cd "$(dirname "$0")/../../server" || exit 1
PERP="1000PEPEUSDT,AAVEUSDT,ADAUSDT,AGTUSDT,AKEUSDT,APTUSDT,ARBUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BRUSDT,BTWUSDT,DOGEUSDT,DOODUSDT,DOTUSDT,ENAUSDT,FETUSDT,FILUSDT,GTCUSDT,HBARUSDT,HYPEUSDT,INJUSDT,IOSTUSDT,IRYSUSDT,JCTUSDT,LINKUSDT,LITUSDT,LTCUSDT,MAGICUSDT,MAGMAUSDT,MOVRUSDT,NEARUSDT,OGNUSDT,ONDOUSDT,PAXGUSDT,PENGUUSDT,PONSUSDT,PUMPUSDT,QNTUSDT,QUSDT,RLCUSDT,SANDUSDT,SOLUSDT,STRKUSDT,SUIUSDT,TAOUSDT,TIAUSDT,TRUMPUSDT,UNIUSDT,USUSDT,WLDUSDT,WUSDT,XLMUSDT,XMRUSDT,XRPUSDT,ZECUSDT,ZROUSDT,龙虾USDT"
SPOT="BNBUSDT,DOGEUSDT,HYPEUSDT,NEARUSDT,QNTUSDT,SOLUSDT,SUIUSDT,WLDUSDT,XRPUSDT,ZECUSDT"

one() {
  local market="$1"; local sym="$2"
  echo "######## $(date '+%H:%M:%S') $market/$sym ########"
  node src/scripts/deep-fill.js --symbols "$sym" --market "$market" --interval 15m --since 2017-08-17
  echo "---- exit=$? ----"
  sleep 20
}

for s in ${PERP//,/ }; do one perp "$s"; done
for s in ${SPOT//,/ }; do one spot "$s"; done
echo "######## ALL DONE $(date '+%H:%M:%S') ########"
