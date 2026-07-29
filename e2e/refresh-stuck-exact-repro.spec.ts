/**
 * E2E Test: Exact reproduction of user's "stuck resyncing after refresh" bug
 *
 * USER'S EXACT BUG (from screenshots):
 *
 * Screenshot 1 (before refresh):
 * - Left client: Hash=8370745a, Sync=100.0%, Entities=870
 * - Right client: Hash=832df78b, Sync=resyncing..., Entities=871
 * - Console: "[state-sync] DESYNC DETECTED at frame 33"
 * - Console: "No majorityHash in tick 100 (expected with 2 clients)"
 *
 * Screenshot 2 (after refreshing both):
 * - Left client: Hash=513bf5c3, Sync=resyncing..., Entities=974
 * - Right client: Hash=15651dfa, Sync=resyncing..., Entities=975
 * - BOTH stuck at "resyncing..."
 * - Console on both: "No majorityHash in tick X (expected with 2 clients)"
 * - Entity counts differ by ~1
 *
 * CURRENT STATUS:
 * The codebase has a race condition bug that prevents clients from syncing in the first place:
 * - "[modu-network] RESYNC received but no onResyncSnapshot callback registered!"
 * - The RESYNC message arrives BEFORE the callback is registered after connect()
 * - This means clients never see each other (activeClients=0 or 1 instead of 2)
 * - Without initial sync, the "No majorityHash" warning never appears (requires 2+ activeClients)
 *
 * To reproduce the user's exact bug, we would need to:
 * 1. Fix the callback registration race condition so initial sync works
 * 2. Then test the refresh scenario
 *
 * This test documents what CURRENTLY happens vs what the user reported.
 */
import { test, expect, chromium, Browser, Page } from '@playwright/test';

const GAME_URL = 'http://localhost:3001/examples/cell-eater';

test.describe('EXACT BUG REPRO: Refresh causes stuck resyncing with No majorityHash', () => {
    let browser: Browser;

    test.beforeAll(async () => {
        browser = await chromium.launch({ headless: !process.env.HEADED });
    });

    test.afterAll(async () => {
        await browser.close();
    });

    test('refresh both clients -> stuck at resyncing with No majorityHash warnings', async () => {
        // Create unique room ID
        const roomId = 'exact-repro-' + Date.now() + '-' + Math.random().toString(36).slice(2);
        const url = `${GAME_URL}?room=${roomId}`;

        console.log('\n========================================');
        console.log('EXACT BUG REPRODUCTION TEST');
        console.log('Room:', roomId);
        console.log('URL:', url);
        console.log('========================================\n');

        const context1 = await browser.newContext();
        const context2 = await browser.newContext();

        let page1 = await context1.newPage();
        let page2 = await context2.newPage();

        // Track console messages
        const logs1: string[] = [];
        const logs2: string[] = [];
        let noMajorityHashCount1 = 0;
        let noMajorityHashCount2 = 0;
        let desyncCount1 = 0;
        let desyncCount2 = 0;

        const setupLogging = (page: Page, name: string, logs: string[], countRef: { hash: number; desync: number }) => {
            page.on('console', msg => {
                const text = msg.text();
                if (text.includes('No majorityHash')) {
                    countRef.hash++;
                    logs.push(`[${name}] ${text}`);
                    console.log(`[${name}] WARNING: ${text}`);
                }
                if (text.includes('DESYNC DETECTED')) {
                    countRef.desync++;
                    logs.push(`[${name}] ${text}`);
                    console.log(`[${name}] DESYNC: ${text}`);
                }
                // Log important state sync events
                if (text.includes('[state-sync]') || text.includes('Snapshot') || text.includes('resync')) {
                    console.log(`[${name}] ${text}`);
                }
            });
        };

        const counts1 = { hash: 0, desync: 0 };
        const counts2 = { hash: 0, desync: 0 };
        setupLogging(page1, 'CLIENT1', logs1, counts1);
        setupLogging(page2, 'CLIENT2', logs2, counts2);

        // Helper to get sync state matching what the debug UI shows
        const getSyncState = async (page: Page) => {
            return await page.evaluate(() => {
                const game = (window as any).game;
                if (!game) return null;

                const hash = game.world?.getStateHash?.() || 0;
                const hashHex = hash.toString(16).padStart(8, '0');
                const entityCount = game.world?.entityCount || 0;
                const activeClients = game.getActiveClients?.() || [];
                const syncStats = (game as any).getSyncStats?.() || { syncPercent: 100, isDesynced: false, resyncPending: false };
                const clientId = game.getClientId?.() || '';

                // Determine sync status as shown in debug UI
                let syncStatus: string;
                if (syncStats.resyncPending) {
                    syncStatus = 'resyncing...';
                } else if (syncStats.isDesynced) {
                    syncStatus = 'DESYNCED';
                } else {
                    syncStatus = `${syncStats.syncPercent.toFixed(1)}%`;
                }

                return {
                    frame: (game as any).currentFrame || 0,
                    hash: hashHex,
                    entityCount,
                    activeClients: activeClients.length,
                    activeClientIds: activeClients.map((c: string) => c.slice(0, 8)),
                    syncStatus,
                    isDesynced: syncStats.isDesynced,
                    resyncPending: syncStats.resyncPending,
                    syncPercent: syncStats.syncPercent,
                    clientId: clientId.slice(0, 8),
                };
            });
        };

        // Helper to wait for game to be running and connected
        const waitForGame = async (page: Page, minFrame: number = 30) => {
            await page.waitForFunction((minF) => {
                const g = (window as any).game;
                return g && g.world && (g as any).currentFrame > minF;
            }, minFrame, { timeout: 30000 });
        };

        // ========================================
        // PHASE 1: Connect both clients
        // ========================================
        console.log('PHASE 1: Connecting both clients...');

        await page1.goto(url);
        await waitForGame(page1, 30);  // Wait longer for first client to stabilize
        console.log('Client 1 connected');

        // Wait longer for first client to fully establish room
        // This helps avoid the race condition where RESYNC arrives before callback is registered
        console.log('Waiting 5 seconds for first client to stabilize...');
        await page1.waitForTimeout(5000);

        await page2.goto(url);
        await waitForGame(page2, 30);
        console.log('Client 2 connected');

        // Wait a bit for sync to establish
        await page2.waitForTimeout(3000);

        // Try to force a resync if clients aren't synced
        // This works around the race condition where RESYNC arrives before callback is registered
        console.log('Attempting to trigger resync on client 2...');
        await page2.evaluate(() => {
            const game = (window as any).game;
            if (game && game.connection && game.connection.requestResync) {
                console.log('[TEST] Manually requesting resync');
                game.connection.requestResync();
            }
        });
        await page2.waitForTimeout(2000);

        // ========================================
        // PHASE 2: Wait for INITIAL SYNC (100%)
        // This is critical - user's screenshot showed 100% sync BEFORE the bug
        // ========================================
        console.log('\nPHASE 2: Waiting for initial sync (100%)...');

        let initialSyncAchieved = false;
        for (let i = 0; i < 60; i++) {  // Wait up to 60 seconds for initial sync
            await page1.waitForTimeout(1000);

            const s1 = await getSyncState(page1);
            const s2 = await getSyncState(page2);

            console.log(`[Second ${i + 1}]`);
            console.log(`  Client1: Hash=${s1?.hash} Sync=${s1?.syncStatus} Entities=${s1?.entityCount} activeClients=${s1?.activeClients}`);
            console.log(`  Client2: Hash=${s2?.hash} Sync=${s2?.syncStatus} Entities=${s2?.entityCount} activeClients=${s2?.activeClients}`);

            // Check if we've achieved the user's "before" state:
            // - Both clients see 2 active clients
            // - Sync is 100% (not resyncing)
            if (s1 && s2 &&
                s1.activeClients === 2 && s2.activeClients === 2 &&
                s1.syncStatus === '100.0%' && s2.syncStatus === '100.0%') {
                console.log('\n*** INITIAL SYNC ACHIEVED ***');
                console.log(`  Client1: Hash=${s1.hash} Entities=${s1.entityCount}`);
                console.log(`  Client2: Hash=${s2.hash} Entities=${s2.entityCount}`);
                initialSyncAchieved = true;
                break;
            }

            // Also consider if just one has 100% and both see 2 clients (user's screenshot 1)
            if (s1 && s2 &&
                s1.activeClients === 2 && s2.activeClients === 2 &&
                (s1.syncStatus === '100.0%' || s2.syncStatus === '100.0%')) {
                console.log('\n*** PARTIAL SYNC ACHIEVED (at least one at 100%) ***');
                initialSyncAchieved = true;
                break;
            }
        }

        // Take screenshot of initial state
        await page1.screenshot({ path: 'test-results/exact-repro-before-refresh-client1.png' });
        await page2.screenshot({ path: 'test-results/exact-repro-before-refresh-client2.png' });

        if (!initialSyncAchieved) {
            console.log('\nWARNING: Could not achieve initial sync. Proceeding with refresh test anyway...');
            const s1 = await getSyncState(page1);
            const s2 = await getSyncState(page2);
            console.log('Current state:');
            console.log(`  Client1: Hash=${s1?.hash} Sync=${s1?.syncStatus} Entities=${s1?.entityCount} activeClients=${s1?.activeClients}`);
            console.log(`  Client2: Hash=${s2?.hash} Sync=${s2?.syncStatus} Entities=${s2?.entityCount} activeClients=${s2?.activeClients}`);
        }

        // ========================================
        // PHASE 3: REFRESH BOTH CLIENTS
        // This is the trigger for the bug
        // ========================================
        console.log('\nPHASE 3: Refreshing BOTH clients simultaneously...');

        // Reset counters for post-refresh monitoring
        counts1.hash = 0;
        counts1.desync = 0;
        counts2.hash = 0;
        counts2.desync = 0;

        // Refresh both at the same time
        await Promise.all([
            page1.reload(),
            page2.reload()
        ]);

        // Re-setup logging (listeners are lost on reload)
        setupLogging(page1, 'CLIENT1-POST', logs1, counts1);
        setupLogging(page2, 'CLIENT2-POST', logs2, counts2);

        // Wait for reconnection
        console.log('Waiting for reconnection...');
        await Promise.all([
            waitForGame(page1, 10),
            waitForGame(page2, 10)
        ]);
        console.log('Both clients reconnected\n');

        // ========================================
        // PHASE 4: Monitor for BUG SYMPTOMS
        // Expected: "resyncing..." state with "No majorityHash" warnings
        // ========================================
        console.log('PHASE 4: Monitoring for bug symptoms (20 seconds)...');
        console.log('Expected: Sync=resyncing... with "No majorityHash in tick X" warnings\n');

        let stuckSeconds = 0;
        let maxStuckSeconds = 0;

        for (let i = 0; i < 20; i++) {
            await page1.waitForTimeout(1000);

            const s1 = await getSyncState(page1);
            const s2 = await getSyncState(page2);

            console.log(`[Second ${i + 1} after refresh]`);
            console.log(`  Client1: Hash=${s1?.hash} Sync=${s1?.syncStatus} Entities=${s1?.entityCount} activeClients=${s1?.activeClients}`);
            console.log(`  Client2: Hash=${s2?.hash} Sync=${s2?.syncStatus} Entities=${s2?.entityCount} activeClients=${s2?.activeClients}`);
            console.log(`  "No majorityHash" warnings: Client1=${counts1.hash} Client2=${counts2.hash}`);

            // Check for the exact bug symptoms
            const client1Stuck = s1?.syncStatus === 'resyncing...' || s1?.syncStatus === 'DESYNCED';
            const client2Stuck = s2?.syncStatus === 'resyncing...' || s2?.syncStatus === 'DESYNCED';

            if (client1Stuck || client2Stuck) {
                stuckSeconds++;
                if (stuckSeconds > maxStuckSeconds) {
                    maxStuckSeconds = stuckSeconds;
                }
                console.log(`  STATUS: Stuck in resyncing/desynced (${stuckSeconds} consecutive seconds)`);

                // Check for entity count difference (user saw 974 vs 975)
                if (s1 && s2) {
                    const entityDiff = Math.abs(s1.entityCount - s2.entityCount);
                    if (entityDiff > 0) {
                        console.log(`  Entity diff: ${entityDiff} (${s1.entityCount} vs ${s2.entityCount})`);
                    }
                }
            } else {
                stuckSeconds = 0;  // Reset if they recovered
            }

            // If we see the exact bug pattern, note it
            if ((client1Stuck || client2Stuck) && (counts1.hash > 0 || counts2.hash > 0)) {
                console.log('\n  !!! BUG PATTERN DETECTED: Stuck + No majorityHash warnings !!!');
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

        console.log('Client 1 final:', JSON.stringify(final1, null, 2));
        console.log('Client 2 final:', JSON.stringify(final2, null, 2));
        console.log(`\n"No majorityHash" warnings after refresh: Client1=${counts1.hash} Client2=${counts2.hash}`);
        console.log(`Max consecutive seconds stuck: ${maxStuckSeconds}`);

        // Take final screenshots
        await page1.screenshot({ path: 'test-results/exact-repro-after-refresh-client1.png' });
        await page2.screenshot({ path: 'test-results/exact-repro-after-refresh-client2.png' });

        // ========================================
        // REPORT REPRODUCTION STATUS
        // ========================================
        console.log('\n========================================');
        console.log('BUG REPRODUCTION STATUS');
        console.log('========================================');

        const totalNoMajorityHashWarnings = counts1.hash + counts2.hash;
        const bothStuck = final1?.syncStatus !== '100.0%' && final2?.syncStatus !== '100.0%';
        const entityDiff = final1 && final2 ? Math.abs(final1.entityCount - final2.entityCount) : 0;

        console.log(`1. Initial sync achieved: ${initialSyncAchieved ? 'YES' : 'NO'}`);
        console.log(`2. Stuck after refresh: ${bothStuck ? 'YES' : 'NO'}`);
        console.log(`3. "No majorityHash" warnings: ${totalNoMajorityHashWarnings}`);
        console.log(`4. Entity count difference: ${entityDiff}`);

        if (bothStuck && totalNoMajorityHashWarnings > 0) {
            console.log('\n*** BUG REPRODUCED: Both clients stuck with No majorityHash warnings ***');
        } else if (bothStuck) {
            console.log('\n*** PARTIAL REPRO: Clients stuck but no "No majorityHash" warnings ***');
        } else if (totalNoMajorityHashWarnings > 0) {
            console.log('\n*** PARTIAL REPRO: Got warnings but clients not stuck ***');
        } else {
            console.log('\n*** BUG NOT REPRODUCED in this run ***');
        }

        // ========================================
        // ASSERTIONS (for test pass/fail)
        // ========================================
        // These assertions are designed to FAIL when the bug is present
        // (which proves we reproduced it)

        // The bug means: clients get stuck in resyncing with No majorityHash warnings
        // If bug is present, this test should FAIL
        console.log('\n========================================');
        console.log('ASSERTIONS (test fails if bug is present)');
        console.log('========================================');

        // Check 1: Should NOT be stuck in resyncing after 20 seconds
        if (final1?.syncStatus === 'resyncing...' || final2?.syncStatus === 'resyncing...') {
            console.log('FAIL: At least one client still stuck in resyncing');
        }
        expect(final1?.syncStatus === 'resyncing...' || final2?.syncStatus === 'resyncing...').toBe(false);

        // Check 2: Should NOT have excessive "No majorityHash" warnings
        if (totalNoMajorityHashWarnings > 5) {
            console.log(`FAIL: Too many "No majorityHash" warnings (${totalNoMajorityHashWarnings})`);
        }
        expect(totalNoMajorityHashWarnings).toBeLessThan(5);

        // Check 3: Both should see 2 active clients
        if (final1?.activeClients !== 2 || final2?.activeClients !== 2) {
            console.log(`FAIL: Active clients mismatch (${final1?.activeClients}, ${final2?.activeClients})`);
        }
        expect(final1?.activeClients).toBe(2);
        expect(final2?.activeClients).toBe(2);

        await context1.close();
        await context2.close();
    });
});
