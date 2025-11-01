import { Mutex } from 'async-mutex';
import _ from 'lodash';
import { v4 as uuidv4 } from 'uuid';
import { Auth, UserSocketGroup, WebSocketStatus } from '../types/WebSocketSubscriptions';
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
            apiKey: group.auth.key,
        }));
    }

    /**
     * Get the indices of all groups that contain the asset.
     * 
     * Returns an array of indices.
     */
    public getUserGroupIndex(apiKey: string): number {
        for (let i = 0; i < wsGroups.length; i++) {
            if (wsGroups[i]?.apiKey === apiKey) {
                return i;
            };
        }
        return -1;
    }

    /**
     * Check if any group contains subscriptions for the given apiKey.
     */
    public hasGroup(apiKey: string): boolean {
        return wsGroups.some(group => group.apiKey === apiKey);
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
    public async addUserSubscription(auth: Auth): Promise<string[]> {
        const groupIdsToConnect: string[] = [];
        await this.mutate(groups => {
            const existingGroupId = this.hasGroup(auth.key);
            if (!existingGroupId) {
                const groupId = uuidv4();
                groups.push(
                    { 
                        groupId,
                        apiKey: auth.key,
                        auth: auth,
                        wsClient: null, 
                        status: WebSocketStatus.PENDING 
                    }
                );
                groupIdsToConnect.push(groupId);
            } else {
                logger.warn({
                    message: `User webSocket with apiKey [${auth.key}] already exists. ignoring...`,
                });
            }
        });
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
    public async removeUserSubscriptions(apiKey: string): Promise<void> {
        await this.mutate(groups => {
            const group = groups.find(g => g.apiKey === apiKey);
            if (!group) {
                return;
            }
            this.disconnectGroup(group);
        });
    }

    /**
     * Disconnect a group.
     */
    public disconnectGroup(group: UserSocketGroup) {
        group.wsClient?.close();
        group.wsClient = null;

        logger.info({
            message: 'Disconnected User WebSocket group',
            groupId: group.groupId,
            apiKey: group.apiKey,
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
                if (group.status === WebSocketStatus.ALIVE) {
                    continue;
                }

                if (group.status === WebSocketStatus.DEAD) {
                    this.disconnectGroup(group);
                    reconnectIds.push(group.groupId);
                }
                if (group.status === WebSocketStatus.CLEANUP) {
                    groupsToRemove.add(group.groupId);
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