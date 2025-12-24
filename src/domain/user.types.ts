
export type TrackedUser = {
  address: string;
};

export interface UserStats {
  totalPnl: number;
  totalVolume: number;
  totalFeesPaid: number;
  winRate: number;
  tradesCount: number;
  winCount: number;
  lossCount: number;
  allowanceApproved: boolean;
  portfolioValue: number;
  cashBalance: number;
}
