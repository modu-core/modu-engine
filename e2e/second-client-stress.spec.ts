/**
 * STRESS TEST: Second client join with many entities
 *
 * This test focuses on finding PERSISTENT desync, not transient timing issues.
 * It runs for a longer period and samples more carefully.
 */
import { test, expect, chromium, Browser, Page } from '@playwright/test';

const GAME_URL = 'http://localhost:3001/examples/cell-eater';
const ROOM_ID = 'e2e-stress-' + Date.now() + '-' + Math.random().toString(36).slice(2);

test.describe('Second Client Stress Test', () => {
    let browser: Browser;
    let page1: Page;
    let page2: Page;

    test.beforeAll(async () => {
        browser = await chromium.launch({ headless: !process.env.HEADED });
    });

    test.afterAll(async () => {
        await browser.close();
    });

    test('detect persistent desync after second client joins', async () => {
        test.setTimeout(180000); // 3 minutes

        const context1 = await browser.newContext();
        const context2 = await browser.newContext();

        page1 = await context1.newPage();
        page2 = await context2.newPage();

        // Track desync events
        const desyncEvents: string[] = [];

        page1.on('console', msg => {
            const text = msg.text();
            if (text.includes('DESYNC')) {
                console.log('[PAGE1]', text);
                desyncEvents.push('[PAGE1] ' + text);
            }
        });

        page2.on('console', msg => {
            const text = msg.text();
            if (text.includes('DESYNC') || text.includes('catchup') || text.includes('Snapshot loaded')) {
                console.log('[PAGE2]', text);
                if (text.includes('DESYNC')) {
                    desyncEvents.push('[PAGE2] ' + text);
                }
            }
        });

        const url = `${GAME_URL}?room=${ROOM_ID}`;
        console.log('Test URL:', url);

        // ========================================
        // STEP 1: Open first client
        // ========================================
        console.log('\n=== Opening Page1 ===');
        await page1.goto(url);

        await page1.waitForFunction(() => {
            const g = (window as any).game;
            return g && g.world && (g as any).currentFrame > 10;
        }, { timeout: 15000 });

        // Helper to get state at a SPECIFIC frame on both pages
        const getStatesAtSameFrame = async (): Promise<{
            s1: any;
            s2: any;
            frame: number;
        } | null> => {
            // Get Page1's current frame
            const frame1 = await page1.evaluate(() => (window as any).game?.frame || 0);

            // Wait for Page2 to reach the same frame (with timeout)
            const maxWait = 5000;
            const startTime = Date.now();
            let frame2 = 0;

            while (Date.now() - startTime < maxWait) {
                frame2 = await page2.evaluate(() => (window as any).game?.frame || 0);
                if (frame2 >= frame1) break;
                await page2.waitForTimeout(50);
            }

            // Now get states from both at their current frames
            const s1 = await page1.evaluate(() => {
                const game = (window as any).game;
                if (!game) return null;
                return {
                    frame: game.frame,
                    hash: game.world?.getStateHash?.() || 0,
                    hashHex: (game.world?.getStateHash?.() || 0).toString(16).padStart(8, '0'),
                    entityCount: game.world?.entityCount || 0,
                    activeClients: game.getActiveClients?.()?.length || 0,
                    isDesynced: (game as any).isDesynced || false,
                    resyncPending: (game as any).resyncPending || false,
                };
            });

            const s2 = await page2.evaluate(() => {
                const game = (window as any).game;
                if (!game) return null;
                return {
                    frame: game.frame,
                    hash: game.world?.getStateHash?.() || 0,
                    hashHex: (game.world?.getStateHash?.() || 0).toString(16).padStart(8, '0'),
                    entityCount: game.world?.entityCount || 0,
                    activeClients: game.getActiveClients?.()?.length || 0,
                    isDesynced: (game as any).isDesynced || false,
                    resyncPending: (game as any).resyncPending || false,
                };
            });

            if (!s1 || !s2) return null;

            return { s1, s2, frame: s1.frame };
        };

        // ========================================
        // STEP 2: Let Page1 run for a while
        // ========================================
        console.log('\n=== Letting Page1 run for 30 seconds ===');
        await page1.waitForTimeout(30000);

        const p1Before = await page1.evaluate(() => {
            const game = (window as any).game;
            return {
                frame: game.frame,
                entityCount: game.world?.entityCount || 0,
            };
        });
        console.log(`Page1 before P2 join: frame=${p1Before.frame} entities=${p1Before.entityCount}`);

        // ========================================
        // STEP 3: Open second client
        // ========================================
        console.log('\n=== Opening Page2 ===');
        await page2.goto(url);

        // Wait for Page2 to connect and complete catchup
        await page2.waitForFunction(() => {
            const g = (window as any).game;
            return g && g.world && (g as any).currentFrame > 10 && g.getActiveClients?.()?.length > 0;
        }, { timeout: 30000 });

        console.log('Page2 connected');

        // Wait a moment for catchup to complete
        await page2.waitForTimeout(2000);

        // ========================================
        // STEP 4: Monitor for PERSISTENT desync
        // ========================================
        console.log('\n=== Monitoring for 30 seconds ===');

        let consecutiveMismatches = 0;
        let totalSamples = 0;
        let matchingSamples = 0;

        for (let i = 0; i < 60; i++) { // 60 samples over ~30 seconds
            await page1.waitForTimeout(500);

            const result = await getStatesAtSameFrame();
            if (!result) continue;

            const { s1, s2 } = result;
            totalSamples++;

            const entityDiff = Math.abs(s1.entityCount - s2.entityCount);
            const hashMatch = s1.hash === s2.hash;

            if (hashMatch && entityDiff === 0) {
                matchingSamples++;
                consecutiveMismatches = 0;
            } else {
                consecutiveMismatches++;
            }

            // Log every 5th sample or if there's a mismatch
            if (i % 5 === 0 || !hashMatch || entityDiff > 0) {
                console.log(
                    `Sample ${i}: ` +
                    `P1[f=${s1.frame} e=${s1.entityCount} h=${s1.hashHex} ds=${s1.isDesynced}] ` +
                    `P2[f=${s2.frame} e=${s2.entityCount} h=${s2.hashHex} ds=${s2.isDesynced}] ` +
                    `match=${hashMatch} diff=${entityDiff}`
                );
            }

            // Check for persistent desync (5+ consecutive mismatches)
            if (consecutiveMismatches >= 5) {
                console.log(`\n!!! PERSISTENT DESYNC DETECTED (${consecutiveMismatches} consecutive mismatches) !!!`);

                // Get detailed info
                const details1 = await page1.evaluate(() => {
                    const game = (window as any).game;
                    const entities: { type: string; eid: number }[] = [];
                    for (const e of game.world.getAllEntities()) {
                        entities.push({ type: e.type, eid: e.eid });
                    }
                    return {
                        entityTypes: entities.reduce((acc: Record<string, number>, e) => {
                            acc[e.type] = (acc[e.type] || 0) + 1;
                            return acc;
                        }, {}),
                        activeClients: game.getActiveClients?.() || [],
                        isAuthority: game.checkIsAuthority?.() || false,
                    };
                });

                const details2 = await page2.evaluate(() => {
                    const game = (window as any).game;
                    const entities: { type: string; eid: number }[] = [];
                    for (const e of game.world.getAllEntities()) {
                        entities.push({ type: e.type, eid: e.eid });
                    }
                    return {
                        entityTypes: entities.reduce((acc: Record<string, number>, e) => {
                            acc[e.type] = (acc[e.type] || 0) + 1;
                            return acc;
                        }, {}),
                        activeClients: game.getActiveClients?.() || [],
                        isAuthority: game.checkIsAuthority?.() || false,
                    };
                });

                console.log('Page1 details:', JSON.stringify(details1, null, 2));
                console.log('Page2 details:', JSON.stringify(details2, null, 2));

                // Find entity type differences
                const allTypes = new Set([...Object.keys(details1.entityTypes), ...Object.keys(details2.entityTypes)]);
                for (const type of allTypes) {
                    const c1 = details1.entityTypes[type] || 0;
                    const c2 = details2.entityTypes[type] || 0;
                    if (c1 !== c2) {
                        console.log(`  Type "${type}": P1=${c1} P2=${c2} diff=${c1 - c2}`);
                    }
                }
            }
        }

        // ========================================
        // STEP 5: Final verdict
        // ========================================
        console.log('\n=== FINAL RESULTS ===');
        console.log(`Total samples: ${totalSamples}`);
        console.log(`Matching samples: ${matchingSamples}`);
        console.log(`Match rate: ${((matchingSamples / totalSamples) * 100).toFixed(1)}%`);
        console.log(`Desync events logged: ${desyncEvents.length}`);

        await page1.screenshot({ path: 'test-results/stress-page1.png' });
        await page2.screenshot({ path: 'test-results/stress-page2.png' });

        // Get final states
        const final = await getStatesAtSameFrame();
        if (final) {
            console.log(`Final P1: ${final.s1.entityCount} entities, hash=${final.s1.hashHex}`);
            console.log(`Final P2: ${final.s2.entityCount} entities, hash=${final.s2.hashHex}`);

            // Assert they eventually sync (with tolerance for very brief mismatches)
            expect(matchingSamples).toBeGreaterThan(totalSamples * 0.8); // 80%+ samples should match
        }

        await context1.close();
        await context2.close();
    });
});
