export interface BinanceAccount {
  id: string;
  name: string;
  apiKey: string;
  apiSecret: string;
  isActive: boolean;
}

export interface BalanceInfo {
  accountId: string;
  asset: string;
  balance: string;
  availableBalance: string;
  type: 'spot' | 'futures';
}

export interface PositionInfo {
  accountId: string;
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  liquidationPrice: string;
  leverage: string;
}

export interface OrderInfo {
  accountId: string;
  symbol: string;
  orderId: number;
  price: string;
  origQty: string;
  executedQty: string;
  status: string;
  type: string;
  side: string;
  time: number;
}
