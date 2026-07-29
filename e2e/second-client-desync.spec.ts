/**
 * E2E test for second client immediate desync
 *
 * Bug: "super easy to reproduce - literally just load 2 clients and 2nd one is desync'ed almost immediately"
 *
 * This test:
 * 1. Opens the cell-eater game in browser 1
 * 2. Waits for it to connect
 * 3. Opens the same room in browser 2
 * 4. Waits for both to be connected
 * 5. Checks if hash/entity count match
 */
import { test, expect, chromium, Browser, Page } from '@playwright/test';

// NOTE: Don't use .html extension - the server does a 301 redirect that drops query params
const GAME_URL = 'http://localhost:3001/examples/cell-eater';
// Use a very unique room ID to avoid any contamination from other sessions
const ROOM_ID = 'e2e-isolated-desync-' + Date.now() + '-' + Math.random().toString(36).slice(2);

test.describe('Second Client Desync Bug', () => {
    let browser: Browser;
    let page1: Page;
    let page2: Page;

    test.beforeAll(async () => {
        browser = await chromium.launch({ headless: !process.env.HEADED });
    });

    test.afterAll(async () => {
        await browser.close();
    });

    test('second client should have matching state immediately after join', async () => {
        // Create two separate browser contexts (like incognito windows)
        const context1 = await browser.newContext();
        const context2 = await browser.newContext();

        page1 = await context1.newPage();
        page2 = await context2.newPage();

        // Collect console logs for debugging
        const logs1: string[] = [];
        const logs2: string[] = [];

        page1.on('console', msg => {
            const text = msg.text();
            logs1.push(`[${msg.type()}] ${text}`);
            if (text.includes('hash') || text.includes('sync') || text.includes('delta') || text.includes('snapshot')) {
                console.log('[PAGE1]', text);
            }
        });

        page2.on('console', msg => {
            const text = msg.text();
            logs2.push(`[${msg.type()}] ${text}`);
            if (text.includes('hash') || text.includes('sync') || text.includes('delta') || text.includes('snapshot')) {
                console.log('[PAGE2]', text);
            }
        });

        const url = `${GAME_URL}?room=${ROOM_ID}`;
        console.log('Test URL:', url);

        // ========================================
        // STEP 1: Open first client
        // ========================================
        console.log('\n=== Opening Page1 (first client) ===');
        console.log('Expected room ID:', ROOM_ID);
        await page1.goto(url);

        // Verify the URL has the room parameter
        const actualUrl = page1.url();
        console.log('Actual URL:', actualUrl);

        // Check what room the game connected to
        await page1.waitForFunction(() => {
            const g = (window as any).game;
            return g && g.getRoomId;
        }, { timeout: 10000 });

        const connectedRoomId = await page1.evaluate(() => {
            const game = (window as any).game;
            return game?.getRoomId?.() || 'unknown';
        });
        console.log('Connected to room:', connectedRoomId);
        if (connectedRoomId !== ROOM_ID) {
            console.log('!!! BUG: Room ID mismatch! Expected:', ROOM_ID, 'Got:', connectedRoomId);
        }

        // Wait for game to be fully connected
        await page1.waitForFunction(() => {
            const g = (window as any).game;
            return g && g.world && (g as any).currentFrame > 60; // Wait at least 1 second
        }, { timeout: 15000 });

        console.log('Page1: Connected and running');

        // Check immediately after connection - should have only 1 client (itself)
        const immediateState = await page1.evaluate(() => {
            const game = (window as any).game;
            if (!game) return null;
            return {
                clientId: game.getClientId?.() || 'unknown',
                clients: game.getClients?.() || [],
                activeClients: game.getActiveClients?.() || [],
            };
        });
        console.log('Page1 IMMEDIATELY after connection:', immediateState);
        if (immediateState && immediateState.clients.length > 1) {
            console.log('!!! WARNING: Page1 has > 1 client immediately after joining fresh room!');
            console.log('!!! This suggests a phantom client from prior session/room state');
        }

        // Get initial state from page1
        const getState = async (page: Page) => {
            return await page.evaluate(() => {
                const game = (window as any).game;
                if (!game) return null;
                return {
                    frame: (game as any).currentFrame || 0,
                    hash: game.world?.getStateHash?.() || 0,
                    hashHex: (game.world?.getStateHash?.() || 0).toString(16).padStart(8, '0'),
                    entityCount: game.world?.entityCount || 0,
                    clientId: game.getClientId?.() || 'unknown',
                    clients: game.getClients?.() || [],
                    isAuthority: game.checkIsAuthority?.() || false,
                };
            });
        };

        const state1Initial = await getState(page1);
        console.log('Page1 initial state:', state1Initial);

        // ========================================
        // STEP 2: Open second client
        // ========================================
        console.log('\n=== Opening Page2 (second client) ===');
        await page2.goto(url);

        // Wait for page2 to connect
        await page2.waitForFunction(() => {
            const g = (window as any).game;
            return g && g.world && (g as any).currentFrame > 60;
        }, { timeout: 15000 });

        console.log('Page2: Connected and running');

        // Check Page2's authority status immediately
        const page2AuthStatus = await page2.evaluate(() => {
            const game = (window as any).game;
            return {
                localClientId: game.getClientId?.(),
                authorityClientId: (game as any).authorityClientId,
                isAuthority: game.checkIsAuthority?.(),
                activeClients: game.getActiveClients?.(),
            };
        });
        console.log('Page2 authority status immediately after join:', page2AuthStatus);

        // Also check Page1's authority status
        const page1AuthStatus = await page1.evaluate(() => {
            const game = (window as any).game;
            return {
                localClientId: game.getClientId?.(),
                authorityClientId: (game as any).authorityClientId,
                isAuthority: game.checkIsAuthority?.(),
                activeClients: game.getActiveClients?.(),
            };
        });
        console.log('Page1 authority status after Page2 joins:', page1AuthStatus);

        if (page1AuthStatus.isAuthority && page2AuthStatus.isAuthority) {
            console.log('!!! BUG CONFIRMED: BOTH clients think they are authority !!!');
        }

        // ========================================
        // STEP 3: Check for early desync (the reported bug)
        // ========================================
        // The user reports "2nd client is desync'ed almost immediately"
        // Let's check state IMMEDIATELY after page2 connects
        console.log('\n=== Checking for IMMEDIATE desync after page2 joins ===');

        // Sample states rapidly right after join
        for (let i = 0; i < 5; i++) {
            await page1.waitForTimeout(100);
            const s1 = await getState(page1);
            const s2 = await getState(page2);
            const hashMatch = s1?.hash === s2?.hash;
            console.log(`Immediate sample ${i}: Page1 frame=${s1?.frame} hash=${s1?.hashHex} | Page2 frame=${s2?.frame} hash=${s2?.hashHex} | match=${hashMatch}`);
        }

        // Wait for sync to stabilize
        console.log('\n=== Waiting 3 seconds for sync to stabilize ===');
        await page1.waitForTimeout(3000);

        // ========================================
        // STEP 4: Compare states
        // ========================================
        console.log('\n=== Comparing states ===');

        // Get states multiple times to see if they converge
        for (let i = 0; i < 5; i++) {
            const s1 = await getState(page1);
            const s2 = await getState(page2);

            console.log(`\nSample ${i + 1}:`);
            console.log(`  Page1: frame=${s1?.frame} hash=${s1?.hashHex} entities=${s1?.entityCount} clients=${s1?.clients?.length}`);
            console.log(`  Page2: frame=${s2?.frame} hash=${s2?.hashHex} entities=${s2?.entityCount} clients=${s2?.clients?.length}`);

            if (s1 && s2) {
                const hashMatch = s1.hash === s2.hash;
                const entityMatch = s1.entityCount === s2.entityCount;
                console.log(`  Hash match: ${hashMatch}, Entity count match: ${entityMatch}`);
            }

            await page1.waitForTimeout(500);
        }

        // ========================================
        // STEP 5: Final assertion
        // ========================================
        console.log('\n=== Final state comparison ===');
        const state1 = await getState(page1);
        const state2 = await getState(page2);

        console.log('Page1 final:', state1);
        console.log('Page2 final:', state2);

        // Take screenshots for evidence
        await page1.screenshot({ path: 'test-results/page1-final.png' });
        await page2.screenshot({ path: 'test-results/page2-final.png' });
        console.log('Screenshots saved to test-results/');

        // THE CRITICAL ASSERTIONS
        // If the bug exists, these will FAIL
        expect(state1).not.toBeNull();
        expect(state2).not.toBeNull();

        if (state1 && state2) {
            console.log('\n=== DESYNC CHECK ===');
            console.log(`Page1: ${state1.entityCount} entities, hash ${state1.hashHex}`);
            console.log(`Page2: ${state2.entityCount} entities, hash ${state2.hashHex}`);

            const entityDiff = Math.abs(state1.entityCount - state2.entityCount);
            const hashMatch = state1.hash === state2.hash;

            if (!hashMatch) {
                console.log('\n!!! DESYNC DETECTED !!!');
                console.log(`Entity count difference: ${entityDiff}`);
                console.log(`Hash mismatch: ${state1.hashHex} vs ${state2.hashHex}`);
            }

            // Assert entity counts match (within tolerance of 1 for frame timing)
            expect(entityDiff).toBeLessThanOrEqual(1);

            // Assert hashes match (the main desync check)
            expect(state1.hash).toBe(state2.hash);
        }

        await context1.close();
        await context2.close();
    });
});
