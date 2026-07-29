/**
 * E2E test for second client desync with MANY entities
 *
 * This test reproduces the realistic scenario where:
 * 1. First client runs for a while, accumulating 800+ entities
 * 2. Second client joins
 * 3. Desync occurs immediately
 *
 * The original test only waited for 60 entities - this test simulates real usage.
 */
import { test, expect, chromium, Browser, Page } from '@playwright/test';

const GAME_URL = 'http://localhost:3001/examples/cell-eater';
const ROOM_ID = 'e2e-many-entities-' + Date.now() + '-' + Math.random().toString(36).slice(2);

// Target entity count to simulate real usage (user saw 831-832)
const TARGET_ENTITY_COUNT = 200; // Lower than 800 for faster test, but still enough to reproduce

test.describe('Second Client Desync with Many Entities', () => {
    let browser: Browser;
    let page1: Page;
    let page2: Page;

    test.beforeAll(async () => {
        browser = await chromium.launch({ headless: !process.env.HEADED });
    });

    test.afterAll(async () => {
        await browser.close();
    });

    test('second client should sync correctly even with many entities', async () => {
        // Increase timeout for this longer test
        test.setTimeout(120000);

        const context1 = await browser.newContext();
        const context2 = await browser.newContext();

        page1 = await context1.newPage();
        page2 = await context2.newPage();

        // Collect console logs
        const logs1: string[] = [];
        const logs2: string[] = [];

        page1.on('console', msg => {
            const text = msg.text();
            logs1.push(`[${msg.type()}] ${text}`);
            if (text.includes('DESYNC') || text.includes('hash') || text.includes('activeClients')) {
                console.log('[PAGE1]', text);
            }
        });

        page2.on('console', msg => {
            const text = msg.text();
            logs2.push(`[${msg.type()}] ${text}`);
            if (text.includes('DESYNC') || text.includes('hash') || text.includes('activeClients') || text.includes('catchup')) {
                console.log('[PAGE2]', text);
            }
        });

        const url = `${GAME_URL}?room=${ROOM_ID}`;
        console.log('Test URL:', url);

        // ========================================
        // STEP 1: Open first client and let it run
        // ========================================
        console.log('\n=== Opening Page1 (first client) ===');
        await page1.goto(url);

        // Wait for game to connect
        await page1.waitForFunction(() => {
            const g = (window as any).game;
            return g && g.world && (g as any).currentFrame > 10;
        }, { timeout: 15000 });

        console.log('Page1: Connected');

        // Helper to get state
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
                    activeClients: game.getActiveClients?.() || [],
                    isAuthority: game.checkIsAuthority?.() || false,
                };
            });
        };

        // ========================================
        // STEP 2: Wait for many entities to spawn
        // ========================================
        console.log(`\n=== Waiting for ${TARGET_ENTITY_COUNT} entities ===`);

        // Wait until we have enough entities OR max wait time
        const maxWaitMs = 60000; // 60 seconds max
        const startWait = Date.now();

        await page1.waitForFunction(
            (targetCount: number) => {
                const g = (window as any).game;
                return g && g.world && g.world.entityCount >= targetCount;
            },
            TARGET_ENTITY_COUNT,
            { timeout: maxWaitMs }
        ).catch(() => {
            console.log('Timeout waiting for entities - continuing anyway');
        });

        const state1Before = await getState(page1);
        console.log(`Page1 before second join: ${state1Before?.entityCount} entities, hash=${state1Before?.hashHex}, frame=${state1Before?.frame}`);

        // ========================================
        // STEP 3: Open second client
        // ========================================
        console.log('\n=== Opening Page2 (second client) ===');
        await page2.goto(url);

        // Wait for page2 to connect and run catchup
        await page2.waitForFunction(() => {
            const g = (window as any).game;
            return g && g.world && (g as any).currentFrame > 10;
        }, { timeout: 30000 });

        console.log('Page2: Connected');

        // ========================================
        // STEP 4: Check for IMMEDIATE desync
        // ========================================
        console.log('\n=== Checking for immediate desync ===');

        // Sample states immediately after join
        for (let i = 0; i < 10; i++) {
            await page1.waitForTimeout(200);
            const s1 = await getState(page1);
            const s2 = await getState(page2);

            const hashMatch = s1?.hash === s2?.hash;
            const entityDiff = Math.abs((s1?.entityCount || 0) - (s2?.entityCount || 0));

            console.log(`Sample ${i}: P1[f=${s1?.frame} e=${s1?.entityCount} h=${s1?.hashHex}] P2[f=${s2?.frame} e=${s2?.entityCount} h=${s2?.hashHex}] match=${hashMatch} diff=${entityDiff}`);

            if (!hashMatch && entityDiff > 0) {
                console.log('!!! IMMEDIATE DESYNC DETECTED !!!');
            }
        }

        // ========================================
        // STEP 5: Wait for potential recovery
        // ========================================
        console.log('\n=== Waiting 5 seconds for potential sync recovery ===');
        await page1.waitForTimeout(5000);

        // ========================================
        // STEP 6: Final comparison
        // ========================================
        console.log('\n=== Final state comparison ===');

        // Sample multiple times at the end
        let anyMatch = false;
        for (let i = 0; i < 5; i++) {
            const s1 = await getState(page1);
            const s2 = await getState(page2);

            const hashMatch = s1?.hash === s2?.hash;
            const entityDiff = Math.abs((s1?.entityCount || 0) - (s2?.entityCount || 0));

            console.log(`Final ${i}: P1[e=${s1?.entityCount} h=${s1?.hashHex}] P2[e=${s2?.entityCount} h=${s2?.hashHex}] match=${hashMatch} diff=${entityDiff}`);

            if (hashMatch) {
                anyMatch = true;
            }

            await page1.waitForTimeout(500);
        }

        // Take screenshots
        await page1.screenshot({ path: 'test-results/many-entities-page1.png' });
        await page2.screenshot({ path: 'test-results/many-entities-page2.png' });

        // Get final states
        const state1 = await getState(page1);
        const state2 = await getState(page2);

        console.log('\n=== FINAL RESULTS ===');
        console.log(`Page1: ${state1?.entityCount} entities, hash=${state1?.hashHex}, activeClients=${state1?.activeClients?.length}`);
        console.log(`Page2: ${state2?.entityCount} entities, hash=${state2?.hashHex}, activeClients=${state2?.activeClients?.length}`);

        // THE ASSERTIONS
        expect(state1).not.toBeNull();
        expect(state2).not.toBeNull();

        if (state1 && state2) {
            const entityDiff = Math.abs(state1.entityCount - state2.entityCount);
            console.log(`Entity count difference: ${entityDiff}`);
            console.log(`Hash match: ${state1.hash === state2.hash}`);

            // Entity counts should match (within 1 for frame timing)
            expect(entityDiff).toBeLessThanOrEqual(1);

            // Hashes should match
            expect(state1.hash).toBe(state2.hash);
        }

        await context1.close();
        await context2.close();
    });
});
