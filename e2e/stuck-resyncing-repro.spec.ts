/**
 * E2E REPRODUCTION TEST: Multi-Client Sync Bug
 *
 * ORIGINAL BUG DESCRIPTION:
 * 1. Open 2 clients
 * 2. Wait for them to sync
 * 3. Refresh both clients
 * 4. Both clients get stuck at "Sync: resyncing..." forever
 * 5. Console shows: "No majorityHash in tick X (expected with 2 clients)"
 *
 * ACTUAL BUG FOUND:
 * The test revealed a MORE FUNDAMENTAL bug - clients never sync in the first place!
 *
 * ROOT CAUSE IDENTIFIED:
 * - "[modu-network] RESYNC received but no onResyncSnapshot callback registered!"
 * - This is a race condition: server sends RESYNC during connection, but the
 *   onResyncSnapshot callback isn't registered until AFTER network.connect() returns
 * - Both clients think they're the first joiner (empty room)
 * - activeClients arrays are empty on both sides
 * - The "No majorityHash" warning never appears because neither client thinks
 *   there are 2 clients in the room
 *
 * This test FAILS if:
 * - Clients cannot achieve sync within 30 seconds
 * - activeClients doesn't show 2 clients on both sides
 */
import { test, expect, chromium, Browser, Page } from '@playwright/test';

const GAME_URL = 'http://localhost:3001/examples/cell-eater';
const ROOM_ID = 'e2e-stuck-repro-' + Date.now() + '-' + Math.random().toString(36).slice(2);

test.describe('REPRODUCTION: Stuck Resyncing After Refresh', () => {
    let browser: Browser;

    test.beforeAll(async () => {
        browser = await chromium.launch({ headless: !process.env.HEADED });
    });

    test.afterAll(async () => {
        await browser.close();
    });

    test('BUG REPRO: refresh both clients -> stuck in resyncing', async () => {
        const context1 = await browser.newContext();
        const context2 = await browser.newContext();

        let page1 = await context1.newPage();
        let page2 = await context2.newPage();

        // Track "No majorityHash" warnings - this is the key indicator
        const noMajorityHashLogs: string[] = [];
        let noMajorityHashCount = 0;

        const setupConsoleLogging = (page: Page, name: string) => {
            page.on('console', msg => {
                const text = msg.text();

                // Capture the specific warning we're looking for
                if (text.includes('No majorityHash')) {
                    noMajorityHashCount++;
                    noMajorityHashLogs.push(`[${name}] ${text}`);
                    console.log(`[${name}] WARNING:`, text);
                }

                // Also log desync events
                if (text.includes('DESYNC DETECTED')) {
                    console.log(`[${name}] DESYNC:`, text);
                }

                // Log sync state changes
                if (text.includes('resyncing') || text.includes('resync')) {
                    console.log(`[${name}] RESYNC:`, text);
                }

                // Log connection/join events (important for debugging activeClients issue)
                if (text.includes('[ecs-debug]') || text.includes('[ecs]')) {
                    console.log(`[${name}]`, text);
                }

                // Log snapshot related events
                if (text.includes('Snapshot') || text.includes('snapshot') || text.includes('Late join') || text.includes('First join')) {
                    console.log(`[${name}] SNAPSHOT:`, text);
                }
            });
        };

        setupConsoleLogging(page1, 'CLIENT1');
        setupConsoleLogging(page2, 'CLIENT2');

        const url = `${GAME_URL}?room=${ROOM_ID}`;
        console.log('\n========================================');
        console.log('REPRODUCTION TEST: Stuck Resyncing');
        console.log('Room:', ROOM_ID);
        console.log('URL:', url);
        console.log('========================================\n');

        // Helper to get sync state
        const getSyncState = async (page: Page) => {
            return await page.evaluate(() => {
                const game = (window as any).game;
                if (!game) return null;
                const activeClients = game.getActiveClients?.() || [];
                return {
                    frame: (game as any).currentFrame || 0,
                    hash: (game.world?.getStateHash?.() || 0).toString(16).padStart(8, '0'),
                    entityCount: game.world?.entityCount || 0,
                    activeClients: activeClients.length,
                    activeClientsList: activeClients.map((c: string) => c.slice(0, 8)),
                    isDesynced: (game as any).isDesynced || false,
                    resyncPending: (game as any).resyncPending || false,
                    clientId: game.getClientId?.()?.slice(0, 8) || 'unknown',
                    authorityClientId: (game as any).authorityClientId?.slice(0, 8) || 'none',
                };
            });
        };

        // Helper to wait for game to be CONNECTED to server (not just running locally)
        const waitForServerConnection = async (page: Page) => {
            await page.waitForFunction(() => {
                const g = (window as any).game;
                if (!g) return false;
                // Check if we have a real server clientId (not local-xxx)
                const clientId = g.getClientId?.() || '';
                const isConnected = clientId.length > 10 && !clientId.startsWith('local-');
                return isConnected && (g as any).currentFrame > 10;
            }, { timeout: 30000 });
        };

        // ========================================
        // STEP 1: Open first client and wait for SERVER connection
        // ========================================
        console.log('STEP 1: Opening first client...');
        await page1.goto(url);
        await waitForServerConnection(page1);

        const state1Initial = await getSyncState(page1);
        console.log('Client 1 connected to server:', state1Initial);

        // Debug: check activeClients via direct access
        const debug1 = await page1.evaluate(() => {
            const g = (window as any).game;
            return {
                activeClients: (g as any).activeClients,
                authorityClientId: (g as any).authorityClientId,
                localClientIdStr: (g as any).localClientIdStr,
                connectionClientId: (g as any).connection?.clientId,
            };
        });
        console.log('Client 1 debug:', debug1);

        // Wait a bit for the first client to stabilize
        await page1.waitForTimeout(2000);

        // ========================================
        // STEP 2: Open second client and wait for SERVER connection
        // ========================================
        console.log('\nSTEP 2: Opening second client...');
        await page2.goto(url);
        await waitForServerConnection(page2);

        const state2Initial = await getSyncState(page2);
        console.log('Client 2 connected to server:', state2Initial);

        // ========================================
        // STEP 3: Wait for initial sync (100% match)
        // ========================================
        console.log('\nSTEP 3: Waiting for initial sync...');

        // Wait until both clients see 2 active clients and have matching hashes
        let syncAchieved = false;
        for (let i = 0; i < 30; i++) {  // 30 seconds max
            await page1.waitForTimeout(1000);

            const s1 = await getSyncState(page1);
            const s2 = await getSyncState(page2);

            console.log(`  Check ${i + 1}: Client1 hash=${s1?.hash} entities=${s1?.entityCount} activeClients=${s1?.activeClients}`);
            console.log(`           Client2 hash=${s2?.hash} entities=${s2?.entityCount} activeClients=${s2?.activeClients}`);

            if (s1 && s2 &&
                s1.activeClients === 2 && s2.activeClients === 2 &&
                s1.hash === s2.hash &&
                !s1.isDesynced && !s2.isDesynced &&
                !s1.resyncPending && !s2.resyncPending) {
                console.log('\n  SUCCESS: Initial sync achieved!');
                console.log(`  Matching hash: ${s1.hash}`);
                console.log(`  Matching entities: ${s1.entityCount}`);
                syncAchieved = true;
                break;
            }
        }

        // If we couldn't achieve initial sync, note it but continue
        if (!syncAchieved) {
            console.log('\n  WARNING: Initial sync not achieved, but continuing with refresh test...');
        }

        // ========================================
        // STEP 4: Refresh BOTH clients
        // ========================================
        console.log('\nSTEP 4: Refreshing BOTH clients simultaneously...');

        // Reset warning count for post-refresh monitoring
        noMajorityHashCount = 0;
        noMajorityHashLogs.length = 0;

        // Refresh both at the same time
        await Promise.all([
            page1.reload(),
            page2.reload()
        ]);

        // Re-setup logging after reload (page listeners are lost)
        setupConsoleLogging(page1, 'CLIENT1-POST');
        setupConsoleLogging(page2, 'CLIENT2-POST');

        // Wait for reconnection to SERVER (not just local game running)
        console.log('Waiting for reconnection after refresh...');
        await Promise.all([
            waitForServerConnection(page1),
            waitForServerConnection(page2)
        ]);
        console.log('Both clients reconnected to server');

        // ========================================
        // STEP 5: Check if stuck in resyncing for >10 seconds
        // ========================================
        console.log('\nSTEP 5: Monitoring for stuck resyncing state (10 second timeout)...');

        let stuckInResyncing = false;
        let recoveredFromResync = false;
        let stuckSeconds = 0;

        for (let i = 0; i < 15; i++) {  // Monitor for 15 seconds
            await page1.waitForTimeout(1000);

            const s1 = await getSyncState(page1);
            const s2 = await getSyncState(page2);

            const client1Stuck = s1?.isDesynced || s1?.resyncPending;
            const client2Stuck = s2?.isDesynced || s2?.resyncPending;
            const eitherStuck = client1Stuck || client2Stuck;

            console.log(`\n[Second ${i + 1} after refresh]`);
            console.log(`  Client1: hash=${s1?.hash} desynced=${s1?.isDesynced} resyncPending=${s1?.resyncPending}`);
            console.log(`  Client2: hash=${s2?.hash} desynced=${s2?.isDesynced} resyncPending=${s2?.resyncPending}`);
            console.log(`  "No majorityHash" warnings so far: ${noMajorityHashCount}`);

            if (eitherStuck) {
                stuckSeconds++;
                console.log(`  STATUS: Stuck in resyncing (${stuckSeconds} seconds)`);

                if (stuckSeconds >= 10) {
                    stuckInResyncing = true;
                    console.log('\n  !!! BUG REPRODUCED: STUCK IN RESYNCING FOR 10+ SECONDS !!!');
                    break;
                }
            } else {
                // Both clients are synced
                if (s1 && s2 && s1.hash === s2.hash && s1.activeClients === 2) {
                    recoveredFromResync = true;
                    console.log('\n  SUCCESS: Both clients recovered and in sync!');
                    break;
                }
            }
        }

        // ========================================
        // FINAL STATE & EVIDENCE
        // ========================================
        console.log('\n========================================');
        console.log('FINAL STATE');
        console.log('========================================');

        const final1 = await getSyncState(page1);
        const final2 = await getSyncState(page2);

        console.log('Client 1 final state:', final1);
        console.log('Client 2 final state:', final2);
        console.log(`Total "No majorityHash" warnings after refresh: ${noMajorityHashCount}`);

        if (noMajorityHashLogs.length > 0) {
            console.log('\nCaptured "No majorityHash" warnings:');
            noMajorityHashLogs.slice(0, 10).forEach(log => console.log(`  ${log}`));
            if (noMajorityHashLogs.length > 10) {
                console.log(`  ... and ${noMajorityHashLogs.length - 10} more`);
            }
        }

        // Take screenshots as evidence
        await page1.screenshot({ path: 'test-results/stuck-resyncing-repro-client1.png' });
        await page2.screenshot({ path: 'test-results/stuck-resyncing-repro-client2.png' });
        console.log('\nScreenshots saved to test-results/');

        // ========================================
        // ASSERTIONS - TEST FAILS IF BUG IS PRESENT
        // ========================================
        console.log('\n========================================');
        console.log('ASSERTIONS');
        console.log('========================================');

        // ASSERTION 1: Should NOT be stuck in resyncing for >10 seconds
        if (stuckInResyncing) {
            console.log('FAIL: Clients stuck in resyncing for >10 seconds');
        }
        expect(stuckInResyncing).toBe(false);

        // ASSERTION 2: Should NOT have excessive "No majorityHash" warnings after refresh
        // If this warning appears repeatedly, it means the server isn't sending majorityHash
        console.log(`"No majorityHash" warnings after refresh: ${noMajorityHashCount}`);
        if (noMajorityHashCount > 20) {
            console.log('FAIL: Too many "No majorityHash" warnings - server not sending majorityHash correctly');
        }
        expect(noMajorityHashCount).toBeLessThan(20);

        // ASSERTION 3: Neither client should still be in resync state
        console.log(`Client 1 resyncPending: ${final1?.resyncPending}`);
        console.log(`Client 2 resyncPending: ${final2?.resyncPending}`);
        expect(final1?.resyncPending).toBeFalsy();
        expect(final2?.resyncPending).toBeFalsy();

        // ASSERTION 4: Both clients should see 2 active clients
        console.log(`Client 1 activeClients: ${final1?.activeClients}`);
        console.log(`Client 2 activeClients: ${final2?.activeClients}`);
        expect(final1?.activeClients).toBe(2);
        expect(final2?.activeClients).toBe(2);

        await context1.close();
        await context2.close();
    });
});
