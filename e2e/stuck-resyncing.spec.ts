/**
 * E2E test for "stuck in resyncing" bug
 *
 * Bug: Both clients get stuck in "resyncing..." state and never recover.
 *
 * Key error: "No majorityHash in tick X (expected with 2 clients)"
 *
 * This means the server isn't sending majorityHash in TICK messages even though
 * there are 2 clients. Without majorityHash, clients can't verify sync and get
 * stuck in resyncing loop.
 *
 * This test:
 * 1. Opens cell-eater game in browser 1 (first client)
 * 2. Opens same room in browser 2 (second client)
 * 3. Monitors for "No majorityHash" warnings
 * 4. Checks if either client enters "resyncing" state
 * 5. Verifies both clients can recover and maintain sync
 */
import { test, expect, chromium, Browser, Page } from '@playwright/test';

const GAME_URL = 'http://localhost:3001/examples/cell-eater';
const ROOM_ID = 'e2e-stuck-resyncing-' + Date.now() + '-' + Math.random().toString(36).slice(2);

test.describe('Stuck Resyncing Bug', () => {
    let browser: Browser;
    let page1: Page;
    let page2: Page;

    test.beforeAll(async () => {
        browser = await chromium.launch({ headless: !process.env.HEADED });
    });

    test.afterAll(async () => {
        await browser.close();
    });

    test('both clients should receive majorityHash and not get stuck in resyncing', async () => {
        const context1 = await browser.newContext();
        const context2 = await browser.newContext();

        page1 = await context1.newPage();
        page2 = await context2.newPage();

        // Track console messages for debugging
        const logs1: string[] = [];
        const logs2: string[] = [];
        let noMajorityHashCount1 = 0;
        let noMajorityHashCount2 = 0;
        let desyncDetected1 = false;
        let desyncDetected2 = false;

        page1.on('console', msg => {
            const text = msg.text();
            logs1.push(`[${msg.type()}] ${text}`);

            if (text.includes('No majorityHash')) {
                noMajorityHashCount1++;
                console.log('[PAGE1]', text);
            }
            if (text.includes('DESYNC DETECTED')) {
                desyncDetected1 = true;
                console.log('[PAGE1] DESYNC:', text);
            }
            if (text.includes('state-sync') || text.includes('majorityHash')) {
                console.log('[PAGE1]', text);
            }
        });

        page2.on('console', msg => {
            const text = msg.text();
            logs2.push(`[${msg.type()}] ${text}`);

            if (text.includes('No majorityHash')) {
                noMajorityHashCount2++;
                console.log('[PAGE2]', text);
            }
            if (text.includes('DESYNC DETECTED')) {
                desyncDetected2 = true;
                console.log('[PAGE2] DESYNC:', text);
            }
            if (text.includes('state-sync') || text.includes('majorityHash')) {
                console.log('[PAGE2]', text);
            }
        });

        const url = `${GAME_URL}?room=${ROOM_ID}`;
        console.log('Test URL:', url);

        // ========================================
        // STEP 1: Open first client
        // ========================================
        console.log('\n=== Opening Page1 (first client) ===');
        await page1.goto(url);

        // Wait for connection and first few ticks
        await page1.waitForFunction(() => {
            const g = (window as any).game;
            return g && g.world && (g as any).currentFrame > 30;
        }, { timeout: 15000 });

        console.log('Page1: Connected and running');

        // Get initial state
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

        // ========================================
        // STEP 2: Open second client
        // ========================================
        console.log('\n=== Opening Page2 (second client) ===');
        await page2.goto(url);

        // Wait for connection
        await page2.waitForFunction(() => {
            const g = (window as any).game;
            return g && g.world && (g as any).currentFrame > 30;
        }, { timeout: 15000 });

        console.log('Page2: Connected and running');

        // ========================================
        // STEP 3: Let both run for a while and monitor
        // ========================================
        console.log('\n=== Running both clients for 10 seconds ===');

        // Sample states every second
        for (let i = 0; i < 10; i++) {
            await page1.waitForTimeout(1000);

            const s1 = await getState(page1);
            const s2 = await getState(page2);

            console.log(`\n[Second ${i + 1}]`);
            console.log(`  Page1: frame=${s1?.frame} hash=${s1?.hashHex} entities=${s1?.entityCount} activeClients=${s1?.activeClients} desynced=${s1?.isDesynced} resyncPending=${s1?.resyncPending}`);
            console.log(`  Page2: frame=${s2?.frame} hash=${s2?.hashHex} entities=${s2?.entityCount} activeClients=${s2?.activeClients} desynced=${s2?.isDesynced} resyncPending=${s2?.resyncPending}`);
            console.log(`  noMajorityHash warnings: Page1=${noMajorityHashCount1} Page2=${noMajorityHashCount2}`);

            // Check for stuck resync state
            if (s1?.isDesynced && s1?.resyncPending && i > 5) {
                console.log('  WARNING: Page1 stuck in resyncing state!');
            }
            if (s2?.isDesynced && s2?.resyncPending && i > 5) {
                console.log('  WARNING: Page2 stuck in resyncing state!');
            }
        }

        // ========================================
        // STEP 4: Final state check
        // ========================================
        console.log('\n=== Final State Check ===');

        const final1 = await getState(page1);
        const final2 = await getState(page2);

        console.log('Page1 final:', final1);
        console.log('Page2 final:', final2);
        console.log(`Total "No majorityHash" warnings: Page1=${noMajorityHashCount1}, Page2=${noMajorityHashCount2}`);

        // Take screenshots
        await page1.screenshot({ path: 'test-results/stuck-resyncing-page1.png' });
        await page2.screenshot({ path: 'test-results/stuck-resyncing-page2.png' });

        // ========================================
        // ASSERTIONS
        // ========================================

        // CRITICAL: After initial startup (first ~200 frames), majorityHash should be received
        // The warning should NOT appear continuously
        // Allow some warnings during initial connection but not ongoing
        const ALLOWED_NO_MAJORITY_WARNINGS = 20; // Allow some during startup

        console.log(`\nAssertion check: noMajorityHash warnings should be < ${ALLOWED_NO_MAJORITY_WARNINGS}`);
        console.log(`  Page1 warnings: ${noMajorityHashCount1}`);
        console.log(`  Page2 warnings: ${noMajorityHashCount2}`);

        // This is the critical assertion - if majorityHash is working,
        // we shouldn't see continuous "No majorityHash" warnings
        expect(noMajorityHashCount1).toBeLessThan(ALLOWED_NO_MAJORITY_WARNINGS);
        expect(noMajorityHashCount2).toBeLessThan(ALLOWED_NO_MAJORITY_WARNINGS);

        // Neither client should be stuck in resync state at the end
        expect(final1?.resyncPending).toBeFalsy();
        expect(final2?.resyncPending).toBeFalsy();

        // Both clients should see 2 active clients
        expect(final1?.activeClients).toBe(2);
        expect(final2?.activeClients).toBe(2);

        // Entity counts should be close (within 2 for timing differences)
        if (final1 && final2) {
            const entityDiff = Math.abs(final1.entityCount - final2.entityCount);
            expect(entityDiff).toBeLessThanOrEqual(2);
        }

        await context1.close();
        await context2.close();
    });
});
