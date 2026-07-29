/**
 * E2E Test: User-reported "stuck resyncing after refresh" bug
 *
 * ============================================================================
 * USER'S EXACT BUG (from screenshots):
 * ============================================================================
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
 * Key observations from user's bug:
 * 1. Clients WERE able to sync initially (Sync: 100.0% was shown)
 * 2. activeClients WERE showing 2 (hence the "expected with 2 clients" message)
 * 3. After refresh, BOTH clients get stuck in "resyncing..." state
 * 4. "No majorityHash" warnings appear continuously
 *
 * ============================================================================
 * CURRENT CODEBASE STATUS:
 * ============================================================================
 *
 * The current codebase cannot reproduce the user's bug because of a DIFFERENT bug
 * that prevents initial sync from ever being achieved:
 *
 * BUG: Race condition in callback registration
 * - Message: "[modu-network] RESYNC received but no onResyncSnapshot callback registered!"
 * - Cause: ROOM_JOINED sets connected=true, then INITIAL_STATE arrives
 *          but onResyncSnapshot callback isn't registered yet (happens after connect() resolves)
 * - Result: Clients never properly sync, activeClients shows 0 or 1 instead of 2
 *
 * This test documents WHAT CURRENTLY HAPPENS vs WHAT USER REPORTED.
 */
import { test, expect, chromium, Browser, Page } from '@playwright/test';

const GAME_URL = 'http://localhost:3001/examples/cell-eater';

test.describe('User Bug Report: Stuck Resyncing After Refresh', () => {
    let browser: Browser;

    test.beforeAll(async () => {
        browser = await chromium.launch({ headless: !process.env.HEADED });
    });

    test.afterAll(async () => {
        await browser.close();
    });

    test('two clients should sync and stay synced after refresh', async () => {
        const roomId = 'user-bug-' + Date.now() + '-' + Math.random().toString(36).slice(2);
        const url = `${GAME_URL}?room=${roomId}`;

        console.log('\n' + '='.repeat(80));
        console.log('TEST: User-reported stuck resyncing bug');
        console.log('Room:', roomId);
        console.log('='.repeat(80) + '\n');

        const context1 = await browser.newContext();
        const context2 = await browser.newContext();

        const page1 = await context1.newPage();
        const page2 = await context2.newPage();

        // Track console messages
        const issues: string[] = [];
        let noMajorityHashCount = 0;
        let resyncCallbackMissing = 0;

        const setupLogging = (page: Page, name: string) => {
            page.on('console', msg => {
                const text = msg.text();

                // Track the race condition bug
                if (text.includes('RESYNC received but no onResyncSnapshot callback registered')) {
                    resyncCallbackMissing++;
                    issues.push(`[${name}] RACE CONDITION: ${text}`);
                    console.log(`[${name}] BUG: ${text}`);
                }

                // Track the user's reported warning
                if (text.includes('No majorityHash')) {
                    noMajorityHashCount++;
                    console.log(`[${name}] WARNING: ${text}`);
                }

                // Track desync events
                if (text.includes('DESYNC DETECTED')) {
                    console.log(`[${name}] DESYNC: ${text}`);
                }

                // Track resync events
                if (text.includes('resync') || text.includes('Resync')) {
                    console.log(`[${name}] RESYNC: ${text}`);
                }
            });
        };

        setupLogging(page1, 'CLIENT1');
        setupLogging(page2, 'CLIENT2');

        // Helper to get state matching debug UI
        const getState = async (page: Page) => {
            return await page.evaluate(() => {
                const game = (window as any).game;
                if (!game) return null;

                const hash = game.world?.getStateHash?.() || 0;
                const syncStats = (game as any).getSyncStats?.() || { syncPercent: 100, isDesynced: false, resyncPending: false };
                const activeClients = game.getActiveClients?.() || [];

                let syncStatus: string;
                if (syncStats.resyncPending) syncStatus = 'resyncing...';
                else if (syncStats.isDesynced) syncStatus = 'DESYNCED';
                else syncStatus = `${syncStats.syncPercent.toFixed(1)}%`;

                return {
                    hash: hash.toString(16).padStart(8, '0'),
                    entityCount: game.world?.entityCount || 0,
                    activeClients: activeClients.length,
                    syncStatus,
                    frame: (game as any).currentFrame || 0,
                };
            });
        };

        // Wait for game to be running
        const waitForGame = async (page: Page) => {
            await page.waitForFunction(() => {
                const g = (window as any).game;
                return g && g.world && (g as any).currentFrame > 30;
            }, { timeout: 30000 });
        };

        // ========================================
        // PHASE 1: Connect both clients
        // ========================================
        console.log('PHASE 1: Connecting clients...');

        await page1.goto(url);
        await waitForGame(page1);
        console.log('Client 1 connected');

        // Wait for first client to stabilize
        await page1.waitForTimeout(3000);

        await page2.goto(url);
        await waitForGame(page2);
        console.log('Client 2 connected');

        await page2.waitForTimeout(2000);

        // ========================================
        // PHASE 2: Check initial sync status
        // ========================================
        console.log('\nPHASE 2: Checking initial sync (15 seconds)...');
        console.log('USER EXPECTED: Sync=100.0%, activeClients=2 on both');

        let initialSyncAchieved = false;
        for (let i = 0; i < 15; i++) {
            await page1.waitForTimeout(1000);

            const s1 = await getState(page1);
            const s2 = await getState(page2);

            console.log(`[Second ${i + 1}]`);
            console.log(`  Client1: Hash=${s1?.hash} Sync=${s1?.syncStatus} Entities=${s1?.entityCount} activeClients=${s1?.activeClients}`);
            console.log(`  Client2: Hash=${s2?.hash} Sync=${s2?.syncStatus} Entities=${s2?.entityCount} activeClients=${s2?.activeClients}`);

            // Check if we've achieved user's "before" state
            if (s1 && s2 && s1.activeClients === 2 && s2.activeClients === 2) {
                console.log('\n*** INITIAL SYNC ACHIEVED: Both clients see 2 activeClients ***');
                initialSyncAchieved = true;
                break;
            }
        }

        // Take screenshot of initial state
        await page1.screenshot({ path: 'test-results/user-bug-initial-client1.png' });
        await page2.screenshot({ path: 'test-results/user-bug-initial-client2.png' });

        // ========================================
        // PHASE 3: Refresh both and observe
        // ========================================
        console.log('\nPHASE 3: Refreshing both clients...');
        console.log('USER EXPECTED AFTER REFRESH: Both stuck at "resyncing..." with "No majorityHash" warnings');

        // Reset counters
        noMajorityHashCount = 0;

        await Promise.all([
            page1.reload(),
            page2.reload()
        ]);

        // Re-setup logging
        setupLogging(page1, 'CLIENT1-POST');
        setupLogging(page2, 'CLIENT2-POST');

        await Promise.all([
            waitForGame(page1),
            waitForGame(page2)
        ]);
        console.log('Both clients reconnected');

        // ========================================
        // PHASE 4: Monitor for 15 seconds
        // ========================================
        console.log('\nPHASE 4: Monitoring for bug symptoms (15 seconds)...');

        let stuckCount = 0;
        for (let i = 0; i < 15; i++) {
            await page1.waitForTimeout(1000);

            const s1 = await getState(page1);
            const s2 = await getState(page2);

            const stuck = s1?.syncStatus === 'resyncing...' || s2?.syncStatus === 'resyncing...';
            if (stuck) stuckCount++;

            console.log(`[Second ${i + 1} after refresh]`);
            console.log(`  Client1: Hash=${s1?.hash} Sync=${s1?.syncStatus} Entities=${s1?.entityCount} activeClients=${s1?.activeClients}`);
            console.log(`  Client2: Hash=${s2?.hash} Sync=${s2?.syncStatus} Entities=${s2?.entityCount} activeClients=${s2?.activeClients}`);
            console.log(`  "No majorityHash" warnings: ${noMajorityHashCount}`);

            if (stuck && noMajorityHashCount > 0) {
                console.log('  >>> USER BUG PATTERN: Stuck + No majorityHash warnings');
            }
        }

        // Take final screenshots
        await page1.screenshot({ path: 'test-results/user-bug-final-client1.png' });
        await page2.screenshot({ path: 'test-results/user-bug-final-client2.png' });

        // ========================================
        // FINAL REPORT
        // ========================================
        console.log('\n' + '='.repeat(80));
        console.log('FINAL REPORT');
        console.log('='.repeat(80));

        const final1 = await getState(page1);
        const final2 = await getState(page2);

        console.log('\nFinal State:');
        console.log(`  Client1: Hash=${final1?.hash} Sync=${final1?.syncStatus} Entities=${final1?.entityCount} activeClients=${final1?.activeClients}`);
        console.log(`  Client2: Hash=${final2?.hash} Sync=${final2?.syncStatus} Entities=${final2?.entityCount} activeClients=${final2?.activeClients}`);

        console.log('\nBug Indicators:');
        console.log(`  Race condition bugs (RESYNC without callback): ${resyncCallbackMissing}`);
        console.log(`  "No majorityHash" warnings: ${noMajorityHashCount}`);
        console.log(`  Seconds stuck in resyncing: ${stuckCount}`);
        console.log(`  Initial sync achieved: ${initialSyncAchieved}`);

        if (issues.length > 0) {
            console.log('\nIssues detected:');
            issues.forEach(issue => console.log(`  - ${issue}`));
        }

        console.log('\n' + '='.repeat(80));
        console.log('COMPARISON WITH USER BUG');
        console.log('='.repeat(80));

        console.log('\nUSER REPORTED:');
        console.log('  - Initial sync: YES (Sync=100.0%, activeClients=2)');
        console.log('  - After refresh: Stuck at "resyncing..."');
        console.log('  - "No majorityHash" warnings: YES (repeated)');

        console.log('\nCURRENT BEHAVIOR:');
        console.log(`  - Initial sync: ${initialSyncAchieved ? 'YES' : 'NO - due to callback race condition'}`);
        console.log(`  - After refresh: ${stuckCount > 0 ? 'STUCK' : 'NOT STUCK'}`);
        console.log(`  - "No majorityHash" warnings: ${noMajorityHashCount > 0 ? 'YES' : 'NO - requires activeClients>=2'}`);

        if (!initialSyncAchieved) {
            console.log('\n*** CANNOT REPRODUCE USER BUG ***');
            console.log('The callback race condition prevents initial sync.');
            console.log('Fix the race condition first, then the user bug can be reproduced.');
        } else if (stuckCount > 5 && noMajorityHashCount > 0) {
            console.log('\n*** USER BUG REPRODUCED ***');
        }

        // ========================================
        // ASSERTIONS
        // ========================================
        // These should PASS if the bug is fixed

        // 1. Both clients should see each other
        expect(final1?.activeClients).toBe(2);
        expect(final2?.activeClients).toBe(2);

        // 2. Neither should be stuck in resyncing
        expect(final1?.syncStatus).not.toBe('resyncing...');
        expect(final2?.syncStatus).not.toBe('resyncing...');

        // 3. Should not have excessive warnings
        expect(noMajorityHashCount).toBeLessThan(10);

        await context1.close();
        await context2.close();
    });
});
