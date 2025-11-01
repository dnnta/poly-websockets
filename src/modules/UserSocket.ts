import WebSocket from 'ws';
import Bottleneck from 'bottleneck';
import { logger } from '../logger';
import { UserSocketGroup, WebSocketStatus, Auth } from '../types/WebSocketSubscriptions';
import {
    TradeEvent,
    OrderEvent,
    UserSocketHandlers,
    UserWSEvent,
    isTradeEvent,
    isOrderEvent,
} from '../types/PolymarketUserSocket';
import _ from 'lodash';
import ms from 'ms';
import { randomInt } from 'crypto';

const CLOB_WSS_USER_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/user';

export class UserSocket {
    private pingInterval?: NodeJS.Timeout;

    constructor(
        private group: UserSocketGroup,
        private limiter: Bottleneck,
        private handlers: UserSocketHandlers,
        private auth: Auth,
    ) {}

    /**
     * Establish the websocket connection using the provided Bottleneck limiter.
     * 
     */
    public async connect(): Promise<void> {    
        if (this.group.marketIds.size === 0) {
            this.group.status = WebSocketStatus.CLEANUP;
            return;
        }

        try {
            logger.info({
                message: 'Connecting to User WebSocket',
                groupId: this.group.groupId,
                marketLength: this.group.marketIds.size,
            });
            this.group.wsClient = await this.limiter.schedule({ priority: 0 }, async () => { 
                const ws = new WebSocket(CLOB_WSS_USER_URL);
                /*
                    This handler will be replaced by the handlers in setupEventHandlers
                */
                ws.on('error', (err) => {
                    logger.warn({
                        message: 'Error connecting to User WebSocket',
                        error: err,
                        groupId: this.group.groupId,
                        marketIdsLength: this.group.marketIds.size,
                    });
                });
                return ws;
            });
        } catch (err) {
            console.log(err);
            this.group.status = WebSocketStatus.DEAD;
            throw err; // caller responsible for error handler
        }

        this.setupEventHandlers();
    }

    private setupEventHandlers() {
        const group = this.group;
        const handlers = this.handlers;
        
        // Capture the current WebSocket instance to avoid race conditions
        const currentWebSocket = group.wsClient;
        if (!currentWebSocket) {
            return;
        }

        /*
            Define handlers within this scope to capture 'this' context
        */
        const handleOpen = async () => {    
            if (group.marketIds.size === 0) {
                group.status = WebSocketStatus.CLEANUP;
                return;
            }

            // Verify this handler is for the current WebSocket instance
            if (currentWebSocket !== group.wsClient) {
                logger.warn({
                    message: 'handleOpen called for stale User WebSocket instance',
                    groupId: group.groupId,
                });
                return;
            }

            // Additional safety check for readyState
            if (currentWebSocket.readyState !== WebSocket.OPEN) {
                logger.warn({
                    message: 'handleOpen called but User WebSocket is not in OPEN state',
                    groupId: group.groupId,
                    readyState: currentWebSocket.readyState,
                });
                return;
            }

            group.status = WebSocketStatus.ALIVE;
            const params = {
                markets: Array.from(group.marketIds),
                type: 'user',
                auth: {
                    apiKey: this.auth.key,
                    secret: this.auth.secret,
                    passphrase: this.auth.passphrase,
                }
            };

            currentWebSocket.send(JSON.stringify(params));
            await handlers.onWSOpen?.(group.groupId, Array.from(group.marketIds));

            this.pingInterval = setInterval(() => {
                if (group.marketIds.size === 0) {
                    clearInterval(this.pingInterval);
                    group.status = WebSocketStatus.CLEANUP;
                    return;
                }

                // Verify we're still using the same WebSocket
                if (currentWebSocket !== group.wsClient) {
                    clearInterval(this.pingInterval);
                    return;
                }

                if (!currentWebSocket || currentWebSocket.readyState !== WebSocket.OPEN) {
                    clearInterval(this.pingInterval);
                    group.status = WebSocketStatus.DEAD;
                    return;
                }
                currentWebSocket.ping();
            }, randomInt(ms('15s'), ms('25s')));
        };

        const handleMessage = async (data: Buffer) => {
            const messageStr = data.toString();

            // Handle PONG messages that might be sent to message handler during handler reattachment
            if (messageStr === 'PONG') {
                return;
            }

            let events: UserWSEvent[] = [];
            try {
                const parsedData: any = JSON.parse(messageStr);
                events = Array.isArray(parsedData) ? parsedData : [parsedData];
            } catch (err) {
                await handlers.onError?.(new Error(`Not JSON: ${messageStr}`));
                return;
            }

            const tradeEvents: TradeEvent[] = [];
            const orderEvents: OrderEvent[] = [];

            for (const event of events) {
                /* 
                    Skip events for market ids that are not in the group to ensure that
                    we don't get stale events for market that were removed.
                */
                if (isTradeEvent(event)) {
                    tradeEvents.push(event);
                } else if (isOrderEvent(event)) {
                    orderEvents.push(event);
                }                
            }

            await this.handleTradeEvents(tradeEvents);
            await this.handleOrderEvents(orderEvents);
        };

        const handlePong = () => {
            group.groupId;
        };

        const handleError = (err: Error) => {            
            group.status = WebSocketStatus.DEAD;
            clearInterval(this.pingInterval);
            handlers.onError?.(new Error(`User WebSocket error for group ${group.groupId}: ${err.message}`));
        };

        const handleClose = async (code: number, reason?: Buffer) => {
            console.log("================================================");
            console.log(code);
            console.log(reason);
            console.log("================================================");
            group.status = WebSocketStatus.DEAD;
            clearInterval(this.pingInterval);
            await handlers.onWSClose?.(group.groupId, code, reason?.toString() || '');
        };

        // Remove any existing handlers
        currentWebSocket.removeAllListeners();

        // Add the handlers
        currentWebSocket.on('open', handleOpen);
        currentWebSocket.on('message', handleMessage);
        currentWebSocket.on('pong', handlePong);
        currentWebSocket.on('error', handleError);
        currentWebSocket.on('close', handleClose);

        if (group.marketIds.size === 0) {
            group.status = WebSocketStatus.CLEANUP;
            return;
        }
    }

    private async handleOrderEvents(orderEvents: OrderEvent[]): Promise<void> {
        if (orderEvents.length) {
            await this.handlers.onOrder?.(orderEvents);
        }
    }

    private async handleTradeEvents(tradeEvents: TradeEvent[]): Promise<void> {
        if (tradeEvents.length) {
            await this.handlers.onTrade?.(tradeEvents);
        }
    }
} 