import { Mutex } from 'async-mutex';
import _ from 'lodash';
import { v4 as uuidv4 } from 'uuid';
import { UserSocketGroup, WebSocketStatus } from '../types/WebSocketSubscriptions';
import { logger } from '../logger';

/*
 * Global group store and mutex, intentionally **not** exported anymore to prevent
 * accidental external mutation.  All access should go through the helper methods
 * on GroupRegistry instead. 
 */
const wsGroups: UserSocketGroup[] = [];
const wsGroupsMutex = new Mutex();

export class UserRegistry {

    /** 
     * Atomic mutate helper.
     * 
     * @param fn - The function to run atomically.
     * @returns The result of the function.
     */
    public async mutate<T>(fn: (groups: UserSocketGroup[]) => T | Promise<T>): Promise<T> {
        const release = await wsGroupsMutex.acquire();
        try { return await fn(wsGroups); }
        finally { release(); }
    }

    /** 
     * Read-only copy of the registry.
     * 
     * Only to be used in test suite.
     */
    public snapshot(): UserSocketGroup[] {
        return wsGroups.map(group => ({
            ...group,
            marketIds: new Set(group.marketIds),
        }));
    }

    /**
     * Find the first group with capacity to hold new assets.
     * 
     * Returns the groupId if found, otherwise null.
     */
    public findGroupWithCapacity(newMarketLen: number, maxPerWS: number): string | null {
        for (const group of wsGroups) {
            if (group.marketIds.size === 0) continue;
            if (group.marketIds.size + newMarketLen <= maxPerWS) return group.groupId;
        }
        return null;
    }

    /**
     * Get the indices of all groups that contain the asset.
     * 
     * Returns an array of indices.
     */
    public getGroupIndicesForAsset(marketId: string): number[] {
        const indices: number[] = [];
        for (let i = 0; i < wsGroups.length; i++) {
            if (wsGroups[i]?.marketIds.has(marketId)) indices.push(i);
        }
        return indices;
    }

    /**
     * Check if any group contains the asset.
     */
    public hasAsset(marketId: string): boolean {
        return wsGroups.some(group => group.marketIds.has(marketId));
    }

    /**
     * Find the group by groupId.
     * 
     * Returns the group if found, otherwise undefined.
     */
    public findGroupById(groupId: string): UserSocketGroup | undefined {
        return wsGroups.find(g => g.groupId === groupId);
    }

    /**
     * Atomically remove **all** groups from the registry and return them so the
     * caller can perform any asynchronous cleanup (closing sockets, etc.)
     * outside the lock. 
     * 
     * Returns the removed groups.
     */
    public async clearAllGroups(): Promise<UserSocketGroup[]> {
        let removed: UserSocketGroup[] = [];
        await this.mutate(groups => {
            removed = [...groups];
            groups.length = 0;
        });
        return removed;
    }

    /**
     * Add new asset subscriptions.
     * 
     * – Ignores assets that are already subscribed.
     * – Either reuses an existing group with capacity or creates new groups (size ≤ maxPerWS).
     * – If appending to a group:
     *  - A new group is created with the updated assetIds.
     *  - The old group is marked for cleanup.
     *  - The group is added to the list of groups to connect.
     * 
     * @param assetIds - The assetIds to add.
     * @param maxPerWS - The maximum number of assets per WebSocket group.
     * @returns An array of *new* groupIds that need websocket connections.
     */
    public async addMarkets(marketIds: string[], maxPerWS: number): Promise<string[]> {
        const groupIdsToConnect: string[] = [];
        let newMarketIds: string[] = []

        await this.mutate(groups => {
            newMarketIds = marketIds.filter(id => !groups.some(g => g.marketIds.has(id)));
            if (newMarketIds.length === 0) return;

            const existingGroupId = this.findGroupWithCapacity(newMarketIds.length, maxPerWS);

            /*
                If no existing group with capacity is found, create new groups.
            */
            if (existingGroupId === null) {
                const chunks = _.chunk(newMarketIds, maxPerWS);
                for (const chunk of chunks) {
                    const groupId = uuidv4();
                    groups.push(
                        { 
                            groupId,
                            assetIds: new Set(),
                            marketIds: new Set(chunk), 
                            wsClient: null, 
                            status: WebSocketStatus.PENDING 
                        }
                    );
                    groupIdsToConnect.push(groupId);
                }

            /*
                If an existing group with capacity is found, update the group.
            */
            } else {
                const existingGroup = groups.find(g => g.groupId === existingGroupId);
                if (!existingGroup) {
                    // Should never happen
                    throw new Error(`Group with capacity not found for ${newMarketIds.join(', ')}`);
                }

                const updatedMarketIds = new Set([...existingGroup.marketIds, ...newMarketIds]);

                // Mark old group ready for cleanup
                existingGroup.assetIds = new Set();
                existingGroup.status = WebSocketStatus.CLEANUP;

                const groupId = uuidv4();
                groups.push(
                    { 
                        groupId, 
                        assetIds: new Set(), 
                        marketIds: updatedMarketIds,
                        wsClient: null, 
                        status: WebSocketStatus.PENDING 
                    }
                );
                groupIdsToConnect.push(groupId);
            }
        });

        if (newMarketIds.length > 0) {
            logger.info({
                message: `Added ${newMarketIds.length} new user market(s)`
            })
        }
        return groupIdsToConnect;
    }

    /**
     * Remove asset subscriptions from every group that contains the asset.
     * 
     * It should be only one group that contains the asset, we search all of them
     * regardless.
     * 
     * Returns the list of assetIds that were removed.
     */
    public async removeMarkets(marketIds: string[]): Promise<string[]> {
        const removedMarketIds: string[] = [];
        await this.mutate(groups => {
            groups.forEach(group => {
                if (group.marketIds.size === 0) return;

                marketIds.forEach(id => {
                    if (group.marketIds.delete(id)) {
                        removedMarketIds.push(id)
                    }
                });
            });
        });
        if (removedMarketIds.length > 0) {
            logger.info({
                message: `Removed ${removedMarketIds.length} user market(s)`
            })
        }
        return removedMarketIds;
    }

    /**
     * Disconnect a group.
     */
    public disconnectGroup(group: UserSocketGroup) {
        group.wsClient?.close();
        group.wsClient = null;

        logger.info({
            message: 'Disconnected User WebSocket market group',
            groupId: group.groupId,
            marketIds: Array.from(group.marketIds),
        });

    };
    /**
     * Check status of groups and reconnect or cleanup as needed.
     * 
     * – Empty groups are removed from the global array and returned.
     * – Dead (but non-empty) groups are reset so that caller can reconnect them.
     * – Pending groups are returned so that caller can connect them.
     * 
     * Returns an array of group IDs that need to be reconnected, after cleaning up empty and cleanup-marked groups.
     */
    public async getGroupsToReconnectAndCleanup(): Promise<string[]> {
        const reconnectIds: string[] = [];

        await this.mutate(groups => {
            const groupsToRemove = new Set<string>();

            for (const group of groups) {
                if (group.marketIds.size === 0) {
                    groupsToRemove.add(group.groupId);
                    continue;
                }

                if (group.status === WebSocketStatus.ALIVE) {
                    continue;
                }

                if (group.status === WebSocketStatus.DEAD) {
                    this.disconnectGroup(group);
                    reconnectIds.push(group.groupId);
                }
                if (group.status === WebSocketStatus.CLEANUP) {
                    groupsToRemove.add(group.groupId);
                    group.marketIds = new Set();
                    continue;
                }

                if (group.status === WebSocketStatus.PENDING) {
                    reconnectIds.push(group.groupId);
                }
            }
            if (groupsToRemove.size > 0) {
                groups.forEach(group => {
                    if (groupsToRemove.has(group.groupId)) {
                        this.disconnectGroup(group);
                    }
                });
                const remaining = groups.filter(group => !groupsToRemove.has(group.groupId));
                groups.splice(0, groups.length, ...remaining);
            }
        });
        return reconnectIds;
    }
} 