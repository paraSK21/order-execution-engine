export interface Order {
  orderId: string;
  type: 'market';
  tokenIn: string;
  tokenOut: string;
  amount: number;
  status: 'pending' | 'routing' | 'building' | 'submitted' | 'confirmed' | 'failed';
  executedPrice?: number;
  txHash?: string;
  error?: string;
  timestamp: string;
  selectedDex?: string;
  routingDecision?: {
    raydium: { price: number; fee: number };
    meteora: { price: number; fee: number };
    selected: string;
    reason: string;
  };
}