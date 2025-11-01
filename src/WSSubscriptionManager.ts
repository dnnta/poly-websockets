import ms from 'ms';
import _ from 'lodash';
import Bottleneck from 'bottleneck';
import {
    WebSocketHandlers,
    PriceChangeEvent,
    BookEvent,
    LastTradePriceEvent,
    TickSizeChangeEvent,
    PolymarketWSEvent,
    PolymarketPriceUpdateEvent,
    isPriceChangeEvent
} from './types/PolymarketWebSocket';

import { SubscriptionManagerOptions, Auth } from './types/WebSocketSubscriptions';

import { GroupRegistry } from './modules/GroupRegistry';
import { OrderBookCache } from './modules/OrderBookCache';
import { GroupSocket } from './modules/GroupSocket';

import { UserWSEvent, TradeEvent, OrderEvent, isTradeEvent, isOrderEvent } from './types/PolymarketUserSocket';
import { UserSocketHandlers } from './types/PolymarketUserSocket';
import { UserRegistry } from './modules/UserRegistry';
import { UserSocket } from './modules/UserSocket';

import { logger } from './logger';


// Keeping a burst limit under 10/s to avoid rate limiting
// See https://docs.polymarket.com/quickstart/introduction/rate-limits#api-rate-limits
const BURST_LIMIT_PER_SECOND = 5;

const DEFAULT_RECONNECT_AND_CLEANUP_INTERVAL_MS = ms('10s');
const DEFAULT_MAX_MARKETS_PER_WS = 100;

class WSSubscriptionManager {
    private handlers: WebSocketHandlers;
    private burstLimiter: Bottleneck;
    private groupRegistry: GroupRegistry;
    private bookCache: OrderBookCache;
    private reconnectAndCleanupIntervalMs: number;
    private maxMarketsPerWS: number;

    private userHandlers: UserSocketHandlers;
    private userRegistry: UserRegistry;
    private auth: Auth;

    constructor(marketHandlers: WebSocketHandlers, userHandlers: UserSocketHandlers, options?: SubscriptionManagerOptions) {
        this.groupRegistry = new GroupRegistry();
        this.bookCache = new OrderBookCache();
        this.userRegistry = new UserRegistry();
        this.burstLimiter = options?.burstLimiter || new Bottleneck({
            reservoir: BURST_LIMIT_PER_SECOND,
            reservoirRefreshAmount: BURST_LIMIT_PER_SECOND,
            reservoirRefreshInterval: ms('1s'),
            maxConcurrent: BURST_LIMIT_PER_SECOND
        });

        this.auth = options?.auth || {
            key: '',
            secret: '',
            passphrase: '',
        };

        this.reconnectAndCleanupIntervalMs = options?.reconnectAndCleanupIntervalMs || DEFAULT_RECONNECT_AND_CLEANUP_INTERVAL_MS;
        this.maxMarketsPerWS = options?.maxMarketsPerWS || DEFAULT_MAX_MARKETS_PER_WS;

        this.handlers = {
            onBook: async (events: BookEvent[]) => {
                await this.actOnSubscribedEvents(events, marketHandlers.onBook);
            },
            onLastTradePrice: async (events: LastTradePriceEvent[]) => {
                await this.actOnSubscribedEvents(events, marketHandlers.onLastTradePrice);
            },
            onTickSizeChange: async (events: TickSizeChangeEvent[]) => {
                await this.actOnSubscribedEvents(events, marketHandlers.onTickSizeChange);
            },
            onPriceChange: async (events: PriceChangeEvent[]) => {
                await this.actOnSubscribedEvents(events, marketHandlers.onPriceChange);
            },
            onPolymarketPriceUpdate: async (events: PolymarketPriceUpdateEvent[]) => {
                await this.actOnSubscribedEvents(events, marketHandlers.onPolymarketPriceUpdate);
            },
            onWSClose: marketHandlers.onWSClose,
            onWSOpen: marketHandlers.onWSOpen,
            onError: marketHandlers.onError
        };

        this.userHandlers = {
            onTrade: async (events: TradeEvent[]) => {
                await this.actOnSubscribedUserEvents(events, userHandlers.onTrade);
            },
            onOrder: async (events: OrderEvent[]) => {
                await this.actOnSubscribedUserEvents(events, userHandlers.onOrder);
            },
            onWSClose: userHandlers.onWSClose,
            onWSOpen: userHandlers.onWSOpen,
            onError: userHandlers.onError
        };

        this.burstLimiter.on('error', (err: Error) => {
            this.handlers.onError?.(err);
        });

        // Check for dead groups every 10s and reconnect them if needed
        setInterval(() => {
            this.reconnectAndCleanupGroups();
        }, this.reconnectAndCleanupIntervalMs);
    }

    /*
        Clears all WebSocket subscriptions and state.

        This will:

        1. Remove all subscriptions and groups
        2. Close all WebSocket connections
        3. Clear the order book cache
    */
    public async clearState() {
        const previousGroups = await this.groupRegistry.clearAllGroups();

        // Close sockets outside the lock
        for (const group of previousGroups) {
            this.groupRegistry.disconnectGroup(group);
        }

        // Also clear the order book cache
        this.bookCache.clear();

        const previousUserGroups = await this.userRegistry.clearAllGroups();
        for (const group of previousUserGroups) {
            this.userRegistry.disconnectGroup(group);
        }   
    }

    /* 
        This function is called when:
        - a websocket event is received from the Polymarket WS
        - a price update event detected, either by after a 'last_trade_price' event or a 'price_change' event
        depending on the current bid-ask spread (see https://docs.polymarket.com/polymarket-learn/trading/how-are-prices-calculated)

        The user handlers will be called **ONLY** for assets that are actively subscribed to by any groups.
    */
    private async actOnSubscribedEvents<T extends PolymarketWSEvent | PolymarketPriceUpdateEvent>(events: T[], action?: (events: T[]) => Promise<void>) {

        // Filter out events that are not subscribed to by any groups
        events = _.filter(events, (event: T) => {
            // Handle PriceChangeEvent which doesn't have asset_id at root
            if (isPriceChangeEvent(event)) {
                // Check if any of the price_changes are subscribed
                return event.price_changes.some(price_change_item => {
                    const groupIndices = this.groupRegistry.getGroupIndicesForAsset(price_change_item.asset_id);
                    if (groupIndices.length > 1) {
                        logger.warn({
                            message: 'Found multiple groups for asset',
                            asset_id: price_change_item.asset_id,
                            group_indices: groupIndices
                        });
                    }
                    return groupIndices.length > 0;
                });
            }
            
            // For all other events, check asset_id at root
            if ('asset_id' in event) {
                const groupIndices = this.groupRegistry.getGroupIndicesForAsset(event.asset_id);

                if (groupIndices.length > 1) {
                    logger.warn({
                        message: 'Found multiple groups for asset',
                        asset_id: event.asset_id,
                        group_indices: groupIndices
                    });
                }
                return groupIndices.length > 0;
            }
            
            return false;
        });

        await action?.(events);
    }

    private async actOnSubscribedUserEvents<T extends UserWSEvent>(events: T[], action?: (events: T[]) => Promise<void>) {
        events = _.filter(events, (event: T) => {
            if (isTradeEvent(event) || isOrderEvent(event)) {
                return true;
            }
            return false;
        });
        await action?.(events);
    }

    /*  
        Edits wsGroups: Adds new subscriptions.

        - Filters out assets that are already subscribed
        - Finds a group with capacity or creates a new one
        - Creates a new WebSocket client and adds it to the group
    */
    public async addSubscriptions(assetIdsToAdd: string[]) {
        try {
            const groupIdsToConnect = await this.groupRegistry.addAssets(assetIdsToAdd, this.maxMarketsPerWS);
            for (const groupId of groupIdsToConnect) {
                await this.createWebSocketClient(groupId, this.handlers);
            }
        } catch (error) {
            const msg = `Error adding subscriptions: ${error instanceof Error ? error.message : String(error)}`;
            await this.handlers.onError?.(new Error(msg));
        }
    }

    public async addUserMarkets(marketIdsToAdd: string[]) {
        try {
            const groupIdsToConnect = await this.userRegistry.addMarkets(marketIdsToAdd, this.maxMarketsPerWS);
            for (const groupId of groupIdsToConnect) {
                await this.createUserWebSocketClient(groupId, this.userHandlers);
            }
        } catch (error) {
            const errMsg = `Error adding user subscriptions: ${error instanceof Error ? error.message : String(error)}`;
            await this.userHandlers.onError?.(new Error(errMsg));
        }
    }

    /*  
        Edits wsGroups: Removes subscriptions.
        The group will use the updated subscriptions when it reconnects.
        We do that because we don't want to miss events by reconnecting.
    */
    public async removeSubscriptions(assetIdsToRemove: string[]) {
        try {
            await this.groupRegistry.removeAssets(assetIdsToRemove, this.bookCache);
        } catch (error) {
            const errMsg = `Error removing subscriptions: ${error instanceof Error ? error.message : String(error)}`;
            await this.handlers.onError?.(new Error(errMsg));
        }
    }

    public async removeUserMarkets(marketIdsToRemove: string[]) {
        try {
            await this.userRegistry.removeMarkets(marketIdsToRemove);
        } catch (error) {
            const errMsg = `Error removing subscriptions: ${error instanceof Error ? error.message : String(error)}`;
            await this.userHandlers.onError?.(new Error(errMsg));
        }
    }

    /*
        This function runs periodically and:

        - Tries to reconnect groups that have assets and are disconnected
        - Cleans up groups that have no assets
    */
    private async reconnectAndCleanupGroups() {
        try {
            const reconnectIds = await this.groupRegistry.getGroupsToReconnectAndCleanup();
            const userReconnectIds = await this.userRegistry.getGroupsToReconnectAndCleanup();
            for (const groupId of reconnectIds) {
                await this.createWebSocketClient(groupId, this.handlers);
            }
            for (const groupId of userReconnectIds) {
                console.log("================================================");
                console.log(groupId);
                console.log("================================================");
                await this.createUserWebSocketClient(groupId, this.userHandlers);
            }
        } catch (err) {
            await this.handlers.onError?.(err as Error);
        }
    }

    private async createWebSocketClient(groupId: string, handlers: WebSocketHandlers) {
        const group = this.groupRegistry.findGroupById(groupId);

        /*
            Should never happen, but just in case.
        */
        if (!group) {
            await handlers.onError?.(new Error(`Group ${groupId} not found in registry`));
            return;
        }

        const groupSocket = new GroupSocket(group, this.burstLimiter, this.bookCache, handlers);
        try {
            await groupSocket.connect();
        } catch (error) {
            const errorMessage = `Error creating WebSocket client for group ${groupId}: ${error instanceof Error ? error.message : String(error)}`;
            await handlers.onError?.(new Error(errorMessage));
        }
    }   

    private async createUserWebSocketClient(groupId: string, handlers: UserSocketHandlers) {
        const group = this.userRegistry.findGroupById(groupId);
        if (!group) {
            await handlers.onError?.(new Error(`User group ${groupId} not found in registry`));
            return;
        }
    
        const userSocket = new UserSocket(group, this.burstLimiter, handlers, this.auth);
        try {
            await userSocket.connect();
        } catch (error) {
            const errorMessage = `Error creating User WebSocket client for group ${groupId}: ${error instanceof Error ? error.message : String(error)}`;
            await handlers.onError?.(new Error(errorMessage));
        }
    }
}

export { WSSubscriptionManager, WebSocketHandlers, UserSocketHandlers };