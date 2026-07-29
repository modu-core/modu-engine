/**
 * E2E test for resync flow after forced desync
 *
 * This test:
 * 1. Opens two clients
 * 2. Waits for them to sync
 * 3. Forces a desync by manipulating one client's state
 * 4. Verifies the client detects desync and requests resync
 * 5. Verifies the resync callback is called and state recovers
 */
import { test, expect, chromium, Browser, Page } from '@playwright/test';

const GAME_URL = 'http://localhost:3001/examples/cell-eater';
const ROOM_ID = 'e2e-force-desync-' + Date.now() + '-' + Math.random().toString(36).slice(2);

test.describe('Force Desync and Resync Test', () => {
    let browser: Browser;

    test.beforeAll(async () => {
        browser = await chromium.launch({ headless: !process.env.HEADED });
    });

    test.afterAll(async () => {
        await browser.close();
    });

    test('client should detect desync, request resync, and recover', async () => {
        const context1 = await browser.newContext();
        const context2 = await browser.newContext();

        const page1 = await context1.newPage();
        const page2 = await context2.newPage();

        // Track events on BOTH pages (with 2 clients, either could detect desync)
        let resyncRequested1 = false;
        let resyncSnapshotReceived1 = false;
        let desyncDetected1 = false;
        let resyncRequested2 = false;
        let resyncSnapshotReceived2 = false;
        let desyncDetected2 = false;

        const setupConsoleLogging = (page: Page, name: string) => {
            page.on('console', msg => {
                const text = msg.text();
                if (text.includes('state-sync') || text.includes('DESYNC') || text.includes('resync') || text.includes('majorityHash')) {
                    console.log(`[${name}]`, text);
                }
                if (name === 'PAGE1') {
                    if (text.includes('Requested resync')) resyncRequested1 = true;
                    if (text.includes('Calling onResyncSnapshot')) resyncSnapshotReceived1 = true;
                    if (text.includes('DESYNC DETECTED')) desyncDetected1 = true;
                }
                if (name === 'PAGE2') {
                    if (text.includes('Requested resync')) resyncRequested2 = true;
                    if (text.includes('Calling onResyncSnapshot')) resyncSnapshotReceived2 = true;
                    if (text.includes('DESYNC DETECTED')) desyncDetected2 = true;
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
        // PHASE 1: Connect both clients
        // ========================================
        console.log('\n=== PHASE 1: Connect both clients ===');
        await page1.goto(url);
        await waitForGame(page1);
        console.log('Page1: Connected');

        await page2.goto(url);
        await waitForGame(page2);
        console.log('Page2: Connected');

        // Wait for initial sync
        await page1.waitForTimeout(2000);

        let state1 = await getState(page1);
        let state2 = await getState(page2);
        console.log(`Initial sync: Page1 hash=${state1?.hashHex}, Page2 hash=${state2?.hashHex}`);
        // Note: Initial sync might not be perfect due to timing, so we don't assert here
        // The test focuses on forcing desync and verifying recovery

        // ========================================
        // PHASE 2: Force desync on Page2
        // ========================================
        console.log('\n=== PHASE 2: Force desync on Page2 ===');

        // Force desync by spawning extra entities only on Page2
        await page2.evaluate(() => {
            const game = (window as any).game;
            // Create fake entities to cause hash mismatch
            for (let i = 0; i < 5; i++) {
                const colorStr = '#ff0000';
                const color = game.internString('color', colorStr);
                game.spawn('food', {
                    x: Math.random() * 100 + 500,
                    y: Math.random() * 100 + 500,
                    color
                });
            }
            console.log('[TEST] Forced desync by spawning extra entities');
        });

        // Wait for desync detection (happens every 100 frames via majorityHash check)
        console.log('Waiting for desync detection...');
        await page2.waitForTimeout(6000);  // ~120 frames at 20fps

        // ========================================
        // PHASE 3: Check if resync was triggered
        // ========================================
        console.log('\n=== PHASE 3: Check resync flow ===');

        state1 = await getState(page1);
        state2 = await getState(page2);
        console.log(`After forced desync: Page1 hash=${state1?.hashHex} entities=${state1?.entityCount}, Page2 hash=${state2?.hashHex} entities=${state2?.entityCount}`);
        console.log(`Page1 desync state: isDesynced=${state1?.isDesynced} resyncPending=${state1?.resyncPending}`);
        console.log(`Page2 desync state: isDesynced=${state2?.isDesynced} resyncPending=${state2?.resyncPending}`);
        console.log(`Page1 events: desyncDetected=${desyncDetected1} resyncRequested=${resyncRequested1} resyncSnapshotReceived=${resyncSnapshotReceived1}`);
        console.log(`Page2 events: desyncDetected=${desyncDetected2} resyncRequested=${resyncRequested2} resyncSnapshotReceived=${resyncSnapshotReceived2}`);

        // ========================================
        // PHASE 4: Wait for recovery
        // ========================================
        console.log('\n=== PHASE 4: Wait for recovery ===');
        await page2.waitForTimeout(3000);

        state1 = await getState(page1);
        state2 = await getState(page2);
        console.log(`After recovery wait: Page1 hash=${state1?.hashHex} entities=${state1?.entityCount}, Page2 hash=${state2?.hashHex} entities=${state2?.entityCount}`);
        console.log(`Final Page2 state: isDesynced=${state2?.isDesynced} resyncPending=${state2?.resyncPending}`);

        // Take screenshots
        await page1.screenshot({ path: 'test-results/force-desync-page1.png' });
        await page2.screenshot({ path: 'test-results/force-desync-page2.png' });

        // ========================================
        // ASSERTIONS
        // ========================================
        console.log('\n=== Assertions ===');

        // With 2 clients and conflicting hashes, the majority hash tiebreaker
        // can pick either hash, so EITHER client could detect desync.
        // We test that the resync mechanism works regardless of which client detects it.

        const anyDesyncDetected = desyncDetected1 || desyncDetected2;
        const anyResyncRequested = resyncRequested1 || resyncRequested2;
        const anyResyncSnapshotReceived = resyncSnapshotReceived1 || resyncSnapshotReceived2;

        // 1. Desync should have been detected by at least one client
        console.log(`Assertion: anyDesyncDetected=${anyDesyncDetected} (page1=${desyncDetected1}, page2=${desyncDetected2})`);
        expect(anyDesyncDetected).toBe(true);

        // 2. Resync should have been requested by at least one client
        console.log(`Assertion: anyResyncRequested=${anyResyncRequested} (page1=${resyncRequested1}, page2=${resyncRequested2})`);
        expect(anyResyncRequested).toBe(true);

        // 3. Resync snapshot callback should have been called for at least one client
        console.log(`Assertion: anyResyncSnapshotReceived=${anyResyncSnapshotReceived} (page1=${resyncSnapshotReceived1}, page2=${resyncSnapshotReceived2})`);
        expect(anyResyncSnapshotReceived).toBe(true);

        // 4. After recovery, states should match
        // Allow some tolerance for frame timing
        if (state1 && state2) {
            const entityDiff = Math.abs(state1.entityCount - state2.entityCount);
            console.log(`Entity count difference: ${entityDiff}`);
            expect(entityDiff).toBeLessThanOrEqual(2);
        }

        // 5. Neither client should be stuck in resync
        expect(state1?.resyncPending).toBeFalsy();
        expect(state2?.resyncPending).toBeFalsy();

        await context1.close();
        await context2.close();
    });
});
