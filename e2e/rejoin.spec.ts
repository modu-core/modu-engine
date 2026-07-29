/**
 * E2E test for rejoin bug
 *
 * Reproduces: when client refreshes, activeClients gets out of sync
 */
import { test, expect, chromium, Browser, Page } from '@playwright/test';

const GAME_URL = 'http://localhost:3001/examples/cell-eater';
// Room ID is generated inside test to ensure uniqueness

test.describe('Rejoin Bug', () => {
    let browser: Browser;
    let page1: Page;
    let page2: Page;

    test.beforeAll(async () => {
        browser = await chromium.launch({ headless: !process.env.HEADED }); // Set to true for CI
    });

    test.afterAll(async () => {
        await browser.close();
    });

    test('rapid rejoin causes desync', async () => {
        // Open two browser contexts (like two separate browsers)
        const context1 = await browser.newContext();
        const context2 = await browser.newContext();

        page1 = await context1.newPage();
        page2 = await context2.newPage();

        // Collect console logs
        const logs1: string[] = [];
        const logs2: string[] = [];

        page1.on('console', msg => {
            const text = msg.text();
            if (text.includes('[ecs-debug]') || text.includes('[delta')) {
                logs1.push(text);
                console.log('[PAGE1]', text);
            }
        });

        page2.on('console', msg => {
            const text = msg.text();
            if (text.includes('[ecs-debug]') || text.includes('[delta')) {
                logs2.push(text);
                console.log('[PAGE2]', text);
            }
        });

        // Navigate to game with same room (generate unique room ID per test)
        const ROOM_ID = 'e2e-test-rejoin-' + Date.now() + '-' + Math.random().toString(36).slice(2);
        const url = `${GAME_URL}?room=${ROOM_ID}`;
        console.log('Opening:', url);

        await page1.goto(url);
        await page1.waitForTimeout(3000); // Wait for first client to connect

        await page2.goto(url);
        await page2.waitForTimeout(3000); // Wait for second client to connect

        console.log('\n=== Both clients connected ===');
        console.log('Page1 logs:', logs1);
        console.log('Page2 logs:', logs2);

        // Wait for game to be ready
        const waitForGame = async (page: Page, name: string) => {
            try {
                await page.waitForFunction(() => {
                    const g = (window as any).game;
                    // Check if game exists and has connected (currentFrame > 0)
                    return g && g.world && (g as any).currentFrame > 0;
                }, { timeout: 15000 });
                console.log(`${name}: Game ready`);
            } catch (e) {
                console.log(`${name}: Timeout waiting for game, checking state anyway`);
            }
        };

        // Get initial state from debug UI
        const getDebugState = async (page: Page) => {
            return await page.evaluate(() => {
                const game = (window as any).game;
                if (game) {
                    // Access private fields
                    const activeClients = (game as any).activeClients || [];
                    const connectedClients = (game as any).connectedClients || [];
                    return {
                        activeClients: activeClients.length,
                        activeClientsList: [...activeClients],
                        connectedClients: connectedClients.length,
                        entityCount: game.world?.entityCount || 0,
                        hash: game.world?.getStateHash?.()?.toString(16) || '0',
                        frame: (game as any).currentFrame || 0,
                        deltaBytesPerSecond: game.getDeltaBandwidth?.() || 0,
                        isAuthority: game.checkIsAuthority?.() || false
                    };
                }
                return null;
            });
        };

        // Sample delta bandwidth over time while simulating mouse movement
        const sampleDeltaBandwidth = async (page: Page, name: string, durationMs: number = 3000, intervalMs: number = 500) => {
            const samples: number[] = [];
            const startTime = Date.now();
            let moveCounter = 0;
            while (Date.now() - startTime < durationMs) {
                // Move mouse to generate gameplay activity
                const angle = (moveCounter++ / 20) * Math.PI * 2;
                const x = 700 + Math.cos(angle) * 200;
                const y = 450 + Math.sin(angle) * 200;
                await page.mouse.move(x, y);

                const delta = await page.evaluate(() => {
                    const game = (window as any).game;
                    return game?.getDeltaBandwidth?.() || 0;
                });
                samples.push(delta);
                console.log(`${name} delta: ${delta} B/s`);
                await page.waitForTimeout(intervalMs);
            }
            return {
                samples,
                max: Math.max(...samples),
                avg: samples.reduce((a, b) => a + b, 0) / samples.length
            };
        };

        await waitForGame(page1, 'Page1');
        await waitForGame(page2, 'Page2');

        // CRITICAL: Simulate mouse movement to generate actual gameplay
        // Without this, cells don't move and delta bandwidth is 0
        const simulateMouseMovement = async (page: Page, name: string) => {
            // Move mouse in a circle to simulate gameplay
            const centerX = 700;
            const centerY = 450;
            const radius = 200;
            for (let i = 0; i < 10; i++) {
                const angle = (i / 10) * Math.PI * 2;
                const x = centerX + Math.cos(angle) * radius;
                const y = centerY + Math.sin(angle) * radius;
                await page.mouse.move(x, y);
                await page.waitForTimeout(50);
            }
            console.log(`${name}: Simulated mouse movement`);
        };

        // Start mouse movement on both pages to generate activity
        await Promise.all([
            simulateMouseMovement(page1, 'Page1'),
            simulateMouseMovement(page2, 'Page2')
        ]);

        // Wait a bit for delta bandwidth to accumulate
        await page1.waitForTimeout(1500);

        const state1Before = await getDebugState(page1);
        const state2Before = await getDebugState(page2);
        console.log('State before rejoin:');
        console.log('  Page1:', state1Before);
        console.log('  Page2:', state2Before);

        // Get BASELINE delta bandwidth with both clients active (no rejoin yet)
        console.log('\n=== BASELINE: Sampling delta before any rejoin ===');
        const authPageBaseline = state1Before?.isAuthority ? page1 : page2;
        const baselineSamples = await sampleDeltaBandwidth(authPageBaseline, 'Baseline (2 clients, no rejoin)', 2000, 400);
        console.log(`BASELINE delta: max=${baselineSamples.max} avg=${baselineSamples.avg.toFixed(0)} B/s`);

        // Simulate rejoin: page2 refreshes
        console.log('\n=== Page2 refreshing (rejoin) ===');
        logs2.length = 0; // Clear logs

        await page2.reload();

        // Wait for Page2 to ACTUALLY connect (not just game loop start)
        // This means waiting for activeClients > 0
        await page2.waitForFunction(() => {
            const g = (window as any).game;
            if (!g) return false;
            const activeClients = (g as any).activeClients || [];
            return activeClients.length > 0 && (g as any).currentFrame > 30;
        }, { timeout: 20000 });
        console.log('Page2 after rejoin: Connected to server');

        // Also wait for Page1 to see Page2
        await page1.waitForFunction(() => {
            const g = (window as any).game;
            if (!g) return false;
            const activeClients = (g as any).activeClients || [];
            return activeClients.length >= 2;
        }, { timeout: 10000 });
        console.log('Page1: Sees 2 clients');

        console.log('Page2 logs after rejoin:', logs2);

        // Get state after rejoin
        const state1After = await getDebugState(page1);
        const state2After = await getDebugState(page2);
        console.log('\nState after rejoin:');
        console.log('  Page1:', state1After);
        console.log('  Page2:', state2After);

        // Wait for frames to align before comparing
        let alignedState1: any = null;
        let alignedState2: any = null;
        for (let i = 0; i < 20; i++) {
            await page1.waitForTimeout(100);
            const s1 = await getDebugState(page1);
            const s2 = await getDebugState(page2);
            if (s1 && s2 && s1.frame === s2.frame) {
                alignedState1 = s1;
                alignedState2 = s2;
                break;
            }
        }

        // Check for desync
        if (alignedState1 && alignedState2) {
            console.log('\n=== Desync Check (frame aligned) ===');
            console.log('activeClients match:', alignedState1.activeClients === alignedState2.activeClients);
            console.log('entityCount match:', alignedState1.entityCount === alignedState2.entityCount);
            console.log('hash match:', alignedState1.hash === alignedState2.hash);
            console.log('Page1 isAuthority:', alignedState1.isAuthority);
            console.log('Page1 delta:', alignedState1.deltaBytesPerSecond, 'B/s');
            console.log('Page2 delta:', alignedState2.deltaBytesPerSecond, 'B/s');

            // These should match
            expect(alignedState1.activeClients).toBe(alignedState2.activeClients);
            expect(alignedState1.hash).toBe(alignedState2.hash);
        } else {
            console.log('WARNING: Could not align frames for comparison, using latest states');
            if (state1After && state2After) {
                expect(state1After.activeClients).toBe(state2After.activeClients);
            }
        }

        // KEY TEST: Sample delta bandwidth on authority (Page1) after rejoin
        // The bug was that authority's delta spikes to >10kBps after client rejoins
        console.log('\n=== Sampling Authority Delta Bandwidth ===');
        const authPage = state1After?.isAuthority ? page1 : page2;
        const authName = state1After?.isAuthority ? 'Page1' : 'Page2';

        // Simulate continuous mouse movement while sampling to generate actual delta traffic
        const sampleWithMovement = async (page: Page, name: string, durationMs: number = 3000, intervalMs: number = 500) => {
            const samples: number[] = [];
            const startTime = Date.now();
            let moveCounter = 0;
            while (Date.now() - startTime < durationMs) {
                // Move mouse to generate gameplay
                const angle = (moveCounter++ / 20) * Math.PI * 2;
                const x = 700 + Math.cos(angle) * 200;
                const y = 450 + Math.sin(angle) * 200;
                await page.mouse.move(x, y);

                const delta = await page.evaluate(() => {
                    const game = (window as any).game;
                    return game?.getDeltaBandwidth?.() || 0;
                });
                samples.push(delta);
                console.log(`${name} delta: ${delta} B/s`);
                await page.waitForTimeout(intervalMs);
            }
            return {
                samples,
                max: Math.max(...samples),
                avg: samples.reduce((a, b) => a + b, 0) / samples.length
            };
        };

        const deltaSamples1 = await sampleWithMovement(authPage, `${authName} (authority) after 1st rejoin`);
        console.log(`Authority delta after 1st rejoin: max=${deltaSamples1.max} avg=${deltaSamples1.avg.toFixed(0)} B/s`);

        // Normal gameplay with 2 moving cells = ~11 kB/s (180 bytes/frame * 60fps)
        // The bug would show delta >> 50 kB/s (all entities in delta)
        const DELTA_THRESHOLD = 50000; // 50 kB/s - spike indicates all entities in delta

        // Do another rejoin
        console.log('\n=== Page2 refreshing again (second rejoin) ===');
        logs2.length = 0;

        await page2.reload();

        // Wait for proper connection
        await page2.waitForFunction(() => {
            const g = (window as any).game;
            if (!g) return false;
            const activeClients = (g as any).activeClients || [];
            return activeClients.length > 0 && (g as any).currentFrame > 30;
        }, { timeout: 20000 });
        console.log('Page2 after second rejoin: Connected to server');

        await page1.waitForFunction(() => {
            const g = (window as any).game;
            if (!g) return false;
            const activeClients = (g as any).activeClients || [];
            return activeClients.length >= 2;
        }, { timeout: 10000 });
        console.log('Page1: Sees 2 clients');

        console.log('Page2 logs after second rejoin:', logs2);

        // Wait for frames to align before final comparison
        let state1Final: any = null;
        let state2Final: any = null;
        for (let i = 0; i < 20; i++) {
            await page1.waitForTimeout(100);
            const s1 = await getDebugState(page1);
            const s2 = await getDebugState(page2);
            if (s1 && s2 && s1.frame === s2.frame) {
                state1Final = s1;
                state2Final = s2;
                break;
            }
        }

        console.log('\nFinal state (frame aligned):');
        console.log('  Page1:', state1Final);
        console.log('  Page2:', state2Final);

        if (state1Final && state2Final) {
            console.log('Page1 isAuthority:', state1Final.isAuthority);
            console.log('Page1 delta:', state1Final.deltaBytesPerSecond, 'B/s');
            console.log('Page2 delta:', state2Final.deltaBytesPerSecond, 'B/s');

            expect(state1Final.activeClients).toBe(state2Final.activeClients);
            expect(state1Final.hash).toBe(state2Final.hash);
        }

        // Sample delta after 2nd rejoin with movement
        console.log('\n=== Sampling Authority Delta After 2nd Rejoin ===');
        const deltaSamples2 = await sampleWithMovement(authPage, `${authName} (authority) after 2nd rejoin`);
        console.log(`Authority delta after 2nd rejoin: max=${deltaSamples2.max} avg=${deltaSamples2.avg.toFixed(0)} B/s`);

        // CRITICAL ASSERTION: Delta should NOT spike after rejoins
        console.log('\n=== DELTA BANDWIDTH BUG CHECK ===');
        console.log(`BASELINE max delta:   ${baselineSamples.max} B/s`);
        console.log(`1st rejoin max delta: ${deltaSamples1.max} B/s`);
        console.log(`2nd rejoin max delta: ${deltaSamples2.max} B/s`);
        console.log(`Threshold for bug:    ${DELTA_THRESHOLD} B/s`);

        // Calculate spike ratio compared to baseline
        const baselineMax = Math.max(baselineSamples.max, 1); // Avoid division by zero
        const spike1Ratio = deltaSamples1.max / baselineMax;
        const spike2Ratio = deltaSamples2.max / baselineMax;
        console.log(`\nSpike ratios vs baseline: 1st=${spike1Ratio.toFixed(2)}x, 2nd=${spike2Ratio.toFixed(2)}x`);

        if (deltaSamples1.max > DELTA_THRESHOLD || deltaSamples2.max > DELTA_THRESHOLD) {
            console.log('\n!!! HIGH DELTA BUG REPRODUCED !!!');
            console.log('Delta spiked significantly after rejoin - indicates all entities in delta');
        } else if (spike1Ratio > 5 || spike2Ratio > 5) {
            console.log('\n!!! POTENTIAL BUG: Delta 5x+ higher than baseline !!!');
        } else {
            console.log('\nDelta bandwidth is within acceptable range');
        }

        // Fail the test if delta is way above baseline or exceeds threshold
        expect(deltaSamples1.max).toBeLessThan(DELTA_THRESHOLD);
        expect(deltaSamples2.max).toBeLessThan(DELTA_THRESHOLD);
        expect(spike1Ratio).toBeLessThan(10); // Should not spike 10x
        expect(spike2Ratio).toBeLessThan(10);

        await context1.close();
        await context2.close();
    });
});
