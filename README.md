# Poly-WebSockets

A TypeScript library for **real-time Polymarket market price alerts** over **Websocket** with **automatic reconnections** and **easy subscription management**.

> **Note**: This is a fork of [nevuamarkets/poly-websockets](https://github.com/nevuamarkets/poly-websockets) with additional features including User WebSocket support for trade and order events.

## Installation

```bash
npm install @ultralumao/poly-websockets
```

## Features

- 📊 **Real-time Market Updates**: Get `book` , `price_change`, `tick_size_change` and `last_trade_price` real-time market events from Polymarket WSS
- 👤 **Multi-User WebSocket Support**: Subscribe to multiple users' trade and order events via Polymarket User WebSocket, with one WebSocket connection per user
- 🔐 **Flexible User Channel Subscription**: User WebSocket handlers can be set separately and independently from market handlers
- 🎯 **Derived Future Price Event**: Implements Polymarket's [price calculation logic](https://docs.polymarket.com/polymarket-learn/trading/how-are-prices-calculated#future-price) (midpoint vs last trade price based on spread)
- 🔗 **Group Management**: Efficiently manages multiple asset subscriptions across connection groups **without losing events** when subscribing / unsubscribing assets
- 🔄 **Automatic Connection Management**: Handles WebSocket connections, reconnections, and cleanup for grouped assetId (i.e. clobTokenId) subscriptions
- 🚦 **Rate Limiting**: Built-in rate limiting to respect Polymarket API limits
- 💪 **TypeScript Support**: Full TypeScript definitions for all events and handlers

## Quick Start

### Market Data Subscriptions

```typescript
import {
  WSSubscriptionManager,
  WebSocketHandlers
  } from '@ultralumao/poly-websockets';

// Market data handlers
const marketHandlers: WebSocketHandlers = {
  onBook: async (events: BookEvent[]) => {
    for (const event of events) {
      console.log('book event', JSON.stringify(event, null, 2))
    }
  },
  onPriceChange: async (events: PriceChangeEvent[]) => {
    for (const event of events) {
      console.log('price change event', JSON.stringify(event, null, 2))
    }
  },
  onError: async (error: Error) => {
    console.error('Market WebSocket error:', error);
  }
};

// Create the subscription manager (only market handlers required)
const manager = new WSSubscriptionManager(marketHandlers);

// Subscribe to market assets
await manager.addSubscriptions(['asset-id-1', 'asset-id-2']);

// Remove subscriptions
await manager.removeSubscriptions(['asset-id-1']);
```

### User WebSocket Subscriptions (Multi-User Support)

```typescript
import {
  WSSubscriptionManager,
  WebSocketHandlers,
  UserSocketHandlers
  } from '@ultralumao/poly-websockets';

// Market data handlers
const marketHandlers: WebSocketHandlers = { /* ... */ };

// Create the subscription manager
const manager = new WSSubscriptionManager(marketHandlers);

// Set user handlers (can be done separately)
const userHandlers: UserSocketHandlers = {
  onTrade: async (apiKey: string, events: TradeEvent[]) => {
    console.log(`Trade events for user ${apiKey}:`, events);
    for (const event of events) {
      console.log('trade event', JSON.stringify(event, null, 2))
    }
  },
  onOrder: async (apiKey: string, events: OrderEvent[]) => {
    console.log(`Order events for user ${apiKey}:`, events);
    for (const event of events) {
      console.log('order event', JSON.stringify(event, null, 2))
    }
  },
  onWSOpen: async (apiKey: string) => {
    console.log(`User WebSocket connected for ${apiKey}`);
  },
  onWSClose: async (apiKey: string, code: number, reason: string) => {
    console.log(`User WebSocket closed for ${apiKey}:`, code, reason);
  },
  onError: async (apiKey: string, error: Error) => {
    console.error(`User WebSocket error for ${apiKey}:`, error);
  }
};

manager.setUserHandlers(userHandlers);

// Connect multiple users (each user gets their own WebSocket connection)
await manager.connectUserSocket({
  key: 'user1-api-key',
  secret: 'user1-api-secret',
  passphrase: 'user1-api-passphrase'
});

await manager.connectUserSocket({
  key: 'user2-api-key',
  secret: 'user2-api-secret',
  passphrase: 'user2-api-passphrase'
});

// Disconnect a specific user
await manager.disconnectUserSocket('user1-api-key');

// Clear all subscriptions and connections
await manager.clearState();
```

## API Reference

### WSSubscriptionManager

The main class that manages WebSocket connections and subscriptions.

#### Constructor

```typescript
new WSSubscriptionManager(
  marketHandlers: WebSocketHandlers, 
  options?: SubscriptionManagerOptions
)
```

**Parameters:**
- `marketHandlers` - Event handlers for market WebSocket events (book, price changes, etc.)
- `options` - Optional configuration object:
  - `maxMarketsPerWS?: number` - Maximum assets/markets per WebSocket connection (default: 100)
  - `reconnectAndCleanupIntervalMs?: number` - Interval for reconnection attempts (default: 10s)
  - `burstLimiter?: Bottleneck` - Custom rate limiter instance. If none is provided, one will be created and used internally in the component.

**Note:** User WebSocket handlers and authentication are now set separately via `setUserHandlers()` and `connectUserSocket()` methods, allowing flexible multi-user support.

#### Methods

##### `addSubscriptions(assetIds: string[]): Promise<void>`

Adds new asset subscriptions. The manager will:
- Filter out already subscribed assets
- Find available connection groups or create new ones
- Establish WebSocket connections as needed

##### `removeSubscriptions(assetIds: string[]): Promise<void>`

Removes asset subscriptions. **Connections are kept alive to avoid missing events**, and unused groups are cleaned up during the next reconnection cycle.

##### `setUserHandlers(userHandlers: UserSocketHandlers): void`

Sets the user WebSocket event handlers. This can be called separately from constructor initialization, allowing you to enable user WebSocket functionality when needed.

##### `connectUserSocket(auth: Auth): Promise<void>`

Connects a user WebSocket for a specific API key. Each user gets their own WebSocket connection (one user = one group). Supports connecting multiple users simultaneously.

**Parameters:**
- `auth` - API credentials for the user:
  ```typescript
  {
    key: string;        // API key (used to identify the user)
    secret: string;     // API secret
    passphrase: string; // API passphrase
  }
  ```

**Note:** `setUserHandlers()` must be called before connecting any user sockets.

##### `disconnectUserSocket(apiKey: string): Promise<void>`

Disconnects the WebSocket for a specific user by their API key.

**Parameters:**
- `apiKey` - The API key of the user to disconnect

##### `clearState(): Promise<void>`

Clears all subscriptions and state:
- Removes all asset subscriptions
- Disconnects all user WebSocket connections
- Closes all WebSocket connections
- Clears the internal order book cache

### WebSocketHandlers

Interface defining event handlers for market WebSocket events.

```typescript
interface WebSocketHandlers {
  // Core Polymarket WebSocket events
  onBook?: (events: BookEvent[]) => Promise<void>;
  onLastTradePrice?: (events: LastTradePriceEvent[]) => Promise<void>;
  onPriceChange?: (events: PriceChangeEvent[]) => Promise<void>;
  onTickSizeChange?: (events: TickSizeChangeEvent[]) => Promise<void>;
  
  // Derived polymarket price update event
  onPolymarketPriceUpdate?: (events: PolymarketPriceUpdateEvent[]) => Promise<void>;
  
  // Connection lifecycle events
  onWSOpen?: (groupId: string, assetIds: string[]) => Promise<void>;
  onWSClose?: (groupId: string, code: number, reason: string) => Promise<void>;
  onError?: (error: Error) => Promise<void>;
}
```

### UserSocketHandlers

Interface defining event handlers for user WebSocket events (trades and orders). All handlers receive the `apiKey` as the first parameter to identify which user the event belongs to, enabling multi-user support.

```typescript
interface UserSocketHandlers {
  // User-specific events
  // apiKey is provided to identify which user's events these are
  onTrade?: (apiKey: string, events: TradeEvent[]) => Promise<void>;
  onOrder?: (apiKey: string, events: OrderEvent[]) => Promise<void>;
  
  // Connection lifecycle events
  onWSOpen?: (apiKey: string) => Promise<void>;
  onWSClose?: (apiKey: string, code: number, reason: string) => Promise<void>;
  onError?: (apiKey: string, error: Error) => Promise<void>;
}
```

#### Key Event Types

**BookEvent**
- See // https://docs.polymarket.com/developers/CLOB/websocket/market-channel#book-message

**PriceChangeEvent**
- See https://docs.polymarket.com/developers/CLOB/websocket/market-channel#price-change-message

**onTickSizeChange**
- See https://docs.polymarket.com/developers/CLOB/websocket/market-channel#tick-size-change-message

**LastTradePriceEvent**
- Currently undocumented, but is emitted when a trade occurs

**PolymarketPriceUpdateEvent**
- Derived price update following Polymarket's display logic
- Uses midpoint when spread <= $0.10, otherwise uses last trade price
- Includes full order book context

**TradeEvent**
- Represents a trade event from Polymarket User WebSocket
- Contains trade details including maker orders, price, size, and status
- Requires User WebSocket authentication

**OrderEvent**
- Represents an order event from Polymarket User WebSocket
- Tracks order lifecycle: placement, updates, and cancellations
- Requires User WebSocket authentication

### Custom Rate Limiting

```typescript
import Bottleneck from 'bottleneck';

const customLimiter = new Bottleneck({
  reservoir: 10,
  reservoirRefreshAmount: 10,
  reservoirRefreshInterval: 1000,
  maxConcurrent: 10
});

const marketHandlers: WebSocketHandlers = { /* ... */ };

const manager = new WSSubscriptionManager(marketHandlers, {
  burstLimiter: customLimiter
});

// User handlers can be set separately
const userHandlers: UserSocketHandlers = { /* ... */ };
manager.setUserHandlers(userHandlers);
```

## Examples

Check the [examples](./examples) folder for complete working examples

## Error Handling

The library includes error handling:
- Automatic reconnection on connection drops
- User-defined error callbacks for custom handling

## Rate Limits

Respects Polymarket's API rate limits:
- Default: 5 requests per second burst limit
- Configurable through custom Bottleneck instances

## Fork Information

This package is a fork of [nevuamarkets/poly-websockets](https://github.com/nevuamarkets/poly-websockets).

### Differences from Original

- ✅ Added User WebSocket support for trade and order events
- ✅ **Flexible User Channel Subscription**: User handlers can be set separately via `setUserHandlers()`, independent of market handlers
- ✅ **Multi-User Support**: Each user gets their own WebSocket connection (one user = one group), allowing multiple users to be connected simultaneously
- ✅ **Separate User Connection Management**: `connectUserSocket(auth)` and `disconnectUserSocket(apiKey)` methods for per-user connection management
- ✅ **User Identification in Handlers**: All `UserSocketHandlers` callbacks receive `apiKey` as the first parameter to identify which user the event belongs to
- ✅ Added `UserSocketHandlers` interface for user-specific events
- ✅ Requires authentication credentials per user when connecting user WebSockets

### Original Repository

- Repository: https://github.com/nevuamarkets/poly-websockets
- Original Author: Konstantinos Lekkas
- License: AGPL-3.0

## License

AGPL-3.0

## Testing

```bash
npm test
```

## TypeScript Support

Full TypeScript definitions included.

## Disclaimer

This software is provided "as is", without warranty of any kind, express or implied. The author(s) are not responsible for:

- Any financial losses incurred from using this software
- Trading decisions made based on the data provided
- Bugs, errors, or inaccuracies in the data
- System failures or downtime
- Any other damages arising from the use of this software

Use at your own risk. Always verify data independently and never rely solely on automated systems for trading decisions.
