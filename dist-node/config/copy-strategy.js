export function computeProportionalSizing(input) {
    const { yourUsdBalance, traderUsdBalance, traderTradeUsd, multiplier } = input;
    const denom = Math.max(1, traderUsdBalance + Math.max(0, traderTradeUsd));
    const ratio = Math.max(0, yourUsdBalance / denom);
    const base = Math.max(0, traderTradeUsd * ratio);
    const targetUsdSize = Math.max(1, base * Math.max(0, multiplier));
    return { targetUsdSize, ratio };
}
