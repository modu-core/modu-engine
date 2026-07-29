/**
 * E2E test for "stuck resyncing after refresh" bug
 *
 * Bug scenario from user:
 * 1. Both clients are in a room
 * 2. User refreshes both browsers
 * 3. After refresh, both show "DESYNC DETECTED" and "No majorityHash"
 * 4. Entity counts differ by 1 (974 vs 975)
 * 5. Both stuck in "resyncing..." state forever
 */
import { test, expect, chromium, Browser, Page } from '@playwright/test';

const GAME_URL = 'http://localhost:3001/examples/cell-eater';
const ROOM_ID = 'e2e-refresh-stuck-' + Date.now() + '-' + Math.random().toString(36).slice(2);

test.describe('Refresh Both Stuck Resyncing Bug', () => {
    let browser: Browser;

    test.beforeAll(async () => {
        browser = await chromium.launch({ headless: !process.env.HEADED });
    });

    test.afterAll(async () => {
        await browser.close();
    });

    test('after refreshing both clients, they should recover sync', async () => {
        const context1 = await browser.newContext();
        const context2 = await browser.newContext();

        let page1 = await context1.newPage();
        let page2 = await context2.newPage();

        // Track warnings
        let noMajorityHashCount1 = 0;
        let noMajorityHashCount2 = 0;
        let desyncCount1 = 0;
        let desyncCount2 = 0;

        const setupConsoleLogging = (page: Page, name: string) => {
            page.on('console', msg => {
                const text = msg.text();
                if (text.includes('No majorityHash')) {
                    if (name === 'PAGE1') noMajorityHashCount1++;
                    else noMajorityHashCount2++;
                    console.log(`[${name}]`, text);
                }
                if (text.includes('DESYNC DETECTED')) {
                    if (name === 'PAGE1') desyncCount1++;
                    else desyncCount2++;
                    console.log(`[${name}] DESYNC:`, text);
                }
                if (text.includes('state-sync') && text.includes('frame=')) {
                    console.log(`[${name}]`, text);
                }
            });
        };

        setupConsoleLogging(page1, 'PAGE1');
        setupConsoleLogging(page2, 'PAGE2');

        const url = `${GAME_URL}?room=${ROOM_ID}`;
        console.log('Test URL:', url);

        const getState = async (page: Page) => {
            return await page.evaluate(() => {
                const game = (window as any).game;
                if (!game) return null;
                return {
                    frame: (game as any).currentFrame || 0,
                    hash: game.world?.getStateHash?.() || 0,
                    hashHex: (game.world?.getStateHash?.() || 0).toString(16).padStart(8, '0'),
                    entityCount: game.world?.entityCount || 0,
                    clientId: game.getClientId?.()?.slice(0, 8) || 'unknown',
                    activeClients: game.getActiveClients?.()?.length || 0,
                    isDesynced: (game as any).isDesynced || false,
                    resyncPending: (game as any).resyncPending || false,
                };
            });
        };

        const waitForGame = async (page: Page, minFrame: number = 30) => {
            await page.waitForFunction((minF) => {
                const g = (window as any).game;
                return g && g.world && (g as any).currentFrame > minF;
            }, minFrame, { timeout: 20000 });
        };

        // ========================================
        // PHASE 1: Initial connection
        // ========================================
        console.log('\n=== PHASE 1: Initial connection ===');
        await page1.goto(url);
        await waitForGame(page1);
        console.log('Page1: Connected');

        await page2.goto(url);
        await waitForGame(page2);
        console.log('Page2: Connected');

        // Let them run for 5 seconds to build up state
        console.log('Running for 5 seconds...');
        await page1.waitForTimeout(5000);

        let state1 = await getState(page1);
        let state2 = await getState(page2);
        console.log(`Before refresh: Page1 entities=${state1?.entityCount}, Page2 entities=${state2?.entityCount}`);
        console.log(`Before refresh: Page1 hash=${state1?.hashHex}, Page2 hash=${state2?.hashHex}`);

        // ========================================
        // PHASE 2: Refresh both clients simultaneously
        // ========================================
        console.log('\n=== PHASE 2: Refreshing both clients ===');

        // Reset warning counts for post-refresh
        noMajorityHashCount1 = 0;
        noMajorityHashCount2 = 0;
        desyncCount1 = 0;
        desyncCount2 = 0;

        // Refresh both at nearly the same time
        await Promise.all([
            page1.reload(),
            page2.reload()
        ]);

        // Re-setup logging after reload
        setupConsoleLogging(page1, 'PAGE1-REFRESH');
        setupConsoleLogging(page2, 'PAGE2-REFRESH');

        // Wait for both to reconnect
        console.log('Waiting for reconnection...');
        await Promise.all([
            waitForGame(page1, 10),
            waitForGame(page2, 10)
        ]);
        console.log('Both reconnected');

        // ========================================
        // PHASE 3: Monitor for 10 seconds after refresh
        // ========================================
        console.log('\n=== PHASE 3: Monitoring after refresh ===');

        for (let i = 0; i < 10; i++) {
            await page1.waitForTimeout(1000);

            state1 = await getState(page1);
            state2 = await getState(page2);

            console.log(`\n[Second ${i + 1} after refresh]`);
            console.log(`  Page1: frame=${state1?.frame} hash=${state1?.hashHex} entities=${state1?.entityCount} desynced=${state1?.isDesynced} resyncPending=${state1?.resyncPending}`);
            console.log(`  Page2: frame=${state2?.frame} hash=${state2?.hashHex} entities=${state2?.entityCount} desynced=${state2?.isDesynced} resyncPending=${state2?.resyncPending}`);
            console.log(`  noMajorityHash: Page1=${noMajorityHashCount1} Page2=${noMajorityHashCount2}`);
            console.log(`  desync events: Page1=${desyncCount1} Page2=${desyncCount2}`);

            // Check for stuck state
            if ((state1?.isDesynced && state1?.resyncPending) || (state2?.isDesynced && state2?.resyncPending)) {
                if (i > 3) {
                    console.log('  !!! STUCK IN RESYNCING STATE !!!');
                }
            }
        }

        // ========================================
        // ASSERTIONS
        // ========================================
        console.log('\n=== Final Assertions ===');

        const final1 = await getState(page1);
        const final2 = await getState(page2);

        console.log('Final Page1:', final1);
        console.log('Final Page2:', final2);
        console.log(`Total noMajorityHash after refresh: Page1=${noMajorityHashCount1} Page2=${noMajorityHashCount2}`);

        // Save screenshots
        await page1.screenshot({ path: 'test-results/refresh-both-page1.png' });
        await page2.screenshot({ path: 'test-results/refresh-both-page2.png' });

        // Key assertions:
        // 1. Neither should be stuck in resync
        expect(final1?.resyncPending).toBeFalsy();
        expect(final2?.resyncPending).toBeFalsy();

        // 2. Both should see 2 active clients
        expect(final1?.activeClients).toBe(2);
        expect(final2?.activeClients).toBe(2);

        // 3. Shouldn't have too many "No majorityHash" warnings after refresh
        const ALLOWED_WARNINGS = 10;
        expect(noMajorityHashCount1).toBeLessThan(ALLOWED_WARNINGS);
        expect(noMajorityHashCount2).toBeLessThan(ALLOWED_WARNINGS);

        // 4. Entity counts should match (or be very close)
        if (final1 && final2) {
            const entityDiff = Math.abs(final1.entityCount - final2.entityCount);
            console.log(`Entity count difference: ${entityDiff}`);
            expect(entityDiff).toBeLessThanOrEqual(2);
        }

        await context1.close();
        await context2.close();
    });
});
