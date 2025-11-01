/**
 * Represents a maker order in a trade event from Polymarket User WebSocket
 * 
 * Maker orders are the orders that were already in the order book and got matched
 * when a taker order was executed.
 * 
 * @example
 * {
 *   "asset_id": "52114319501245915516055106046884209969926127482827954674443846427813813222426",
 *   "matched_amount": "10",
 *   "order_id": "0xff354cd7ca7539dfa9c28d90943ab5779a4eac34b9b37a757d7b32bdfb11790b",
 *   "outcome": "YES",
 *   "owner": "9180014b-33c8-9240-a14b-bdca11c0a465",
 *   "price": "0.57"
 * }
 */
export type MakeOrder = {
  asset_id: string;
  matched_amount: string;
  order_id: string;
  outcome: string;
  owner: string;
  price: string;
};

/**
 * Represents a trade event from Polymarket User WebSocket
 * @example
 * {
 *   "asset_id": "52114319501245915516055106046884209969926127482827954674443846427813813222426",
 *   "event_type": "trade",
 *   "id": "28c4d2eb-bbea-40e7-a9f0-b2fdb56b2c2e",
 *   "last_update": "1672290701",
 *   "maker_orders": [
 *     {
 *       "asset_id": "52114319501245915516055106046884209969926127482827954674443846427813813222426",
 *       "matched_amount": "10",
 *       "order_id": "0xff354cd7ca7539dfa9c28d90943ab5779a4eac34b9b37a757d7b32bdfb11790b",
 *       "outcome": "YES",
 *       "owner": "9180014b-33c8-9240-a14b-bdca11c0a465",
 *       "price": "0.57"
 *     }
 *   ],
 *   "market": "0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af",
 *   "matchtime": "1672290701",
 *   "outcome": "YES",
 *   "owner": "9180014b-33c8-9240-a14b-bdca11c0a465",
 *   "price": "0.57",
 *   "side": "BUY",
 *   "size": "10",
 *   "status": "MATCHED",
 *   "taker_order_id": "0x06bc63e346ed4ceddce9efd6b3af37c8f8f440c92fe7da6b2d0f9e4ccbc50c42",
 *   "timestamp": "1672290701",
 *   "trade_owner": "9180014b-33c8-9240-a14b-bdca11c0a465",
 *   "type": "TRADE"
 * }
 */
export type TradeEvent = {
  asset_id: string;
  event_type: 'trade';
  id: string;
  last_update: string;
  maker_orders: MakeOrder[];
  market: string;
  matchtime: string;
  outcome: string;
  owner: string;
  price: string;
  side: 'BUY' | 'SELL';
  size: string;
  status: string;
  taker_order_id: string;
  timestamp: string;
  trade_owner: string;
  type: 'TRADE';
};

/**
 * Represents an order event from Polymarket User WebSocket
 * 
 * Order events track the lifecycle of user orders, including placement, updates,
 * and cancellations.
 * 
 * @example
 * {
 *   "asset_id": "52114319501245915516055106046884209969926127482827954674443846427813813222426",
 *   "associate_trades": null,
 *   "event_type": "order",
 *   "id": "0xff354cd7ca7539dfa9c28d90943ab5779a4eac34b9b37a757d7b32bdfb11790b",
 *   "market": "0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af",
 *   "order_owner": "9180014b-33c8-9240-a14b-bdca11c0a465",
 *   "original_size": "10",
 *   "outcome": "YES",
 *   "owner": "9180014b-33c8-9240-a14b-bdca11c0a465",
 *   "price": "0.57",
 *   "side": "SELL",
 *   "size_matched": "0",
 *   "timestamp": "1672290687",
 *   "type": "PLACEMENT"
 * }
 */
export type OrderEvent = {
  asset_id: string;
  associate_trades: unknown | null;
  event_type: 'order';
  id: string;
  market: string;
  order_owner: string;
  original_size: string;
  outcome: string;
  owner: string;
  price: string;
  side: 'BUY' | 'SELL';
  size_matched: string;
  timestamp: string;
  type: string;
};

export type UserSocketHandlers = {

    onTrade?: (events: TradeEvent[]) => Promise<void>;
    
    onOrder?: (events: OrderEvent[]) => Promise<void>;
    
    // Error handling
    onError?: (error: Error) => Promise<void>;
    onWSClose?: (groupId: string, code: number, reason: string) => Promise<void>;
    onWSOpen?: (groupId: string, marketIds: string[]) => Promise<void>;
}

export type UserWSEvent = TradeEvent | OrderEvent;

export function isTradeEvent(event: UserWSEvent | TradeEvent): event is TradeEvent {
    return event?.event_type === 'trade';
}

export function isOrderEvent(event: UserWSEvent | OrderEvent): event is OrderEvent {
    return event?.event_type === 'order';
}