/**
 * E2E test for refresh causing permanent desync
 *
 * Bug scenario:
 * 1. Open 2 browser clients to cell-eater game
 * 2. Wait for them to sync (both show same hash, 100% sync)
 * 3. Refresh ONE of the clients
 * 4. The refreshed client is PERMANENTLY desynced
 *
 * Evidence from screenshot:
 * - Left client (374f7812): Entities=859, Hash=bc260c5f, Sync=100.0%
 * - Right client (cd2a85bb): Entities=860, Hash=25fdf531, Sync=resyncing...
 * - Entity counts differ by 1 (859 vs 860)
 * - Console shows "DESYNC DETECTED at frame 234"
 */
import { test, expect, chromium, Browser, Page } from '@playwright/test';

// NOTE: Don't use .html extension - the server does a 301 redirect that drops query params
const GAME_URL = 'http://localhost:3001/examples/cell-eater';
// Use a unique room ID to avoid contamination from other sessions
const ROOM_ID = 'e2e-refresh-desync-' + Date.now() + '-' + Math.random().toString(36).slice(2);

test.describe('Refresh Causes Permanent Desync Bug', () => {
    let browser: Browser;
    let page1: Page;
    let page2: Page;

    test.beforeAll(async () => {
        browser = await chromium.launch({ headless: !process.env.HEADED });
    });

    test.afterAll(async () => {
        await browser.close();
    });

    test('refreshing one client should NOT cause permanent desync', async () => {
        // Create two separate browser contexts (like incognito windows)
        const context1 = await browser.newContext();
        const context2 = await browser.newContext();

        page1 = await context1.newPage();
        page2 = await context2.newPage();

        // Collect console logs for debugging - look for DESYNC messages
        let desyncMessages: string[] = [];

        page1.on('console', msg => {
            const text = msg.text();
            if (text.includes('DESYNC') || text.includes('ecs')) {
                console.log('[PAGE1]', text);
            }
            if (text.includes('DESYNC')) {
                desyncMessages.push(`[PAGE1] ${text}`);
            }
        });

        page2.on('console', msg => {
            const text = msg.text();
            if (text.includes('DESYNC') || text.includes('ecs') || text.includes('After catchup') || text.includes('snapshot')) {
                console.log('[PAGE2]', text);
            }
            if (text.includes('DESYNC')) {
                desyncMessages.push(`[PAGE2] ${text}`);
            }
        });

        const url = `${GAME_URL}?room=${ROOM_ID}`;
        console.log('Test URL:', url);

        // Helper to get game state
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
                    isAuthority: game.checkIsAuthority?.() || false,
                    activeClients: game.getActiveClients?.() || [],
                };
            });
        };

        // Helper to get detailed entity data for comparison
        const getDetailedEntityData = async (page: Page) => {
            return await page.evaluate(() => {
                const game = (window as any).game;
                if (!game || !game.world) return null;

                const entities: any[] = [];
                const allEntities = game.world.getAllEntities();

                for (const entity of allEntities) {
                    const data: any = {
                        eid: entity.eid,
                        type: entity.type,
                        components: {}
                    };

                    // Get all components for this entity
                    for (const comp of entity.getComponents()) {
                        const compData: any = {};
                        for (const fieldName of comp.fieldNames) {
                            const val = (entity.get(comp) as any)[fieldName];
                            compData[fieldName] = val;
                        }
                        data.components[comp.name] = compData;
                    }

                    entities.push(data);
                }

                // Sort by eid for deterministic comparison
                entities.sort((a, b) => a.eid - b.eid);

                // Get allocator state
                const allocatorState = game.world?.idAllocator?.getState?.() || null;

                return {
                    frame: (game as any).currentFrame || 0,
                    hash: game.world?.getStateHash?.() || 0,
                    hashHex: (game.world?.getStateHash?.() || 0).toString(16).padStart(8, '0'),
                    rng: (window as any).Modu?.saveRandomState?.() || null,
                    allocator: allocatorState,
                    entities
                };
            });
        };

        // Helper to compare and log differences between two detailed states
        const compareStates = (name1: string, state1: any, name2: string, state2: any) => {
            if (!state1 || !state2) {
                console.log('Cannot compare - one or both states are null');
                return;
            }

            console.log(`\n=== DETAILED STATE COMPARISON ===`);
            console.log(`${name1}: frame=${state1.frame} hash=${state1.hashHex} entities=${state1.entities.length}`);
            console.log(`${name2}: frame=${state2.frame} hash=${state2.hashHex} entities=${state2.entities.length}`);
            console.log(`RNG ${name1}: s0=${state1.rng?.s0} s1=${state1.rng?.s1}`);
            console.log(`RNG ${name2}: s0=${state2.rng?.s0} s1=${state2.rng?.s1}`);

            // Compare allocator state - this is likely the bug!
            console.log(`\n=== ALLOCATOR STATE ===`);
            console.log(`${name1} allocator: nextIndex=${state1.allocator?.nextIndex} freeList=[${state1.allocator?.freeList?.slice(0,20).join(',')}${state1.allocator?.freeList?.length > 20 ? '...' : ''}] (${state1.allocator?.freeList?.length} items)`);
            console.log(`${name2} allocator: nextIndex=${state2.allocator?.nextIndex} freeList=[${state2.allocator?.freeList?.slice(0,20).join(',')}${state2.allocator?.freeList?.length > 20 ? '...' : ''}] (${state2.allocator?.freeList?.length} items)`);

            // Check for generation differences
            if (state1.allocator?.generations && state2.allocator?.generations) {
                const genDiffs: string[] = [];
                const maxIdx = Math.max(state1.allocator.generations.length, state2.allocator.generations.length);
                for (let i = 0; i < maxIdx && genDiffs.length < 10; i++) {
                    const g1 = state1.allocator.generations[i] || 0;
                    const g2 = state2.allocator.generations[i] || 0;
                    if (g1 !== g2) {
                        genDiffs.push(`idx=${i}: ${name1}=${g1} ${name2}=${g2}`);
                    }
                }
                if (genDiffs.length > 0) {
                    console.log(`GENERATION DIFFS: ${genDiffs.join(', ')}`);
                }
            }

            // Build maps by eid for comparison
            const map1 = new Map(state1.entities.map((e: any) => [e.eid, e]));
            const map2 = new Map(state2.entities.map((e: any) => [e.eid, e]));

            // Find entities only in one side
            const onlyIn1: number[] = [];
            const onlyIn2: number[] = [];
            const inBoth: number[] = [];

            for (const eid of map1.keys()) {
                if (map2.has(eid)) {
                    inBoth.push(eid);
                } else {
                    onlyIn1.push(eid);
                }
            }
            for (const eid of map2.keys()) {
                if (!map1.has(eid)) {
                    onlyIn2.push(eid);
                }
            }

            if (onlyIn1.length > 0) {
                console.log(`\nEntities ONLY in ${name1}:`, onlyIn1);
                for (const eid of onlyIn1) {
                    const e = map1.get(eid);
                    console.log(`  eid=${eid} type=${e.type}`, JSON.stringify(e.components));
                }
            }
            if (onlyIn2.length > 0) {
                console.log(`\nEntities ONLY in ${name2}:`, onlyIn2);
                for (const eid of onlyIn2) {
                    const e = map2.get(eid);
                    console.log(`  eid=${eid} type=${e.type}`, JSON.stringify(e.components));
                }
            }

            // Compare entities in both
            let diffsFound = 0;
            const MAX_DIFFS = 10;
            console.log(`\nComparing ${inBoth.length} shared entities...`);

            for (const eid of inBoth.sort((a, b) => a - b)) {
                const e1 = map1.get(eid);
                const e2 = map2.get(eid);

                // Compare each component
                const allCompNames = new Set([...Object.keys(e1.components), ...Object.keys(e2.components)]);

                for (const compName of allCompNames) {
                    const c1 = e1.components[compName] || {};
                    const c2 = e2.components[compName] || {};

                    const allFields = new Set([...Object.keys(c1), ...Object.keys(c2)]);
                    for (const field of allFields) {
                        const v1 = c1[field];
                        const v2 = c2[field];

                        if (v1 !== v2 && diffsFound < MAX_DIFFS) {
                            console.log(`  DIFF: eid=${eid} type=${e1.type} ${compName}.${field}: ${name1}=${v1} ${name2}=${v2}`);
                            diffsFound++;
                        }
                    }
                }
            }

            if (diffsFound >= MAX_DIFFS) {
                console.log(`  ... and more diffs (showing first ${MAX_DIFFS})`);
            }
            if (diffsFound === 0) {
                console.log(`  No component data differences found in shared entities!`);
            }

            console.log(`=== END COMPARISON ===\n`);
        };

        // Helper to wait for game to be ready
        const waitForGame = async (page: Page, name: string, minFrames: number = 60) => {
            await page.waitForFunction((min) => {
                const g = (window as any).game;
                return g && g.world && (g as any).currentFrame > min;
            }, minFrames, { timeout: 20000 });
            console.log(`${name}: Game ready`);
        };

        // ========================================
        // STEP 1: Open first client
        // ========================================
        console.log('\n=== STEP 1: Opening Page1 (first client) ===');
        await page1.goto(url);
        await waitForGame(page1, 'Page1');

        // ========================================
        // STEP 2: Open second client
        // ========================================
        console.log('\n=== STEP 2: Opening Page2 (second client) ===');
        await page2.goto(url);
        await waitForGame(page2, 'Page2');

        // Wait for initial sync
        console.log('\n=== STEP 3: Waiting for initial sync ===');
        await page1.waitForTimeout(2000);

        const state1Before = await getState(page1);
        const state2Before = await getState(page2);
        console.log('State BEFORE refresh:');
        console.log('  Page1:', state1Before);
        console.log('  Page2:', state2Before);
        console.log(`  Hash match: ${state1Before?.hash === state2Before?.hash}`);

        // ========================================
        // STEP 4: Perform MULTIPLE refreshes to try to trigger the bug
        // The bug might be intermittent so we try several times
        // ========================================
        const NUM_REFRESH_ATTEMPTS = 5;
        let bugTriggered = false;
        let failingAttempt = -1;

        for (let attempt = 0; attempt < NUM_REFRESH_ATTEMPTS; attempt++) {
            console.log(`\n=== REFRESH ATTEMPT ${attempt + 1}/${NUM_REFRESH_ATTEMPTS} ===`);
            desyncMessages = []; // Clear desync messages for this attempt

            // Refresh Page2
            await page2.reload();
            await waitForGame(page2, 'Page2 after refresh');

            // Wait a moment for rejoin
            await page1.waitForTimeout(500);

            // Check for desync over 5 seconds
            // CRITICAL: Only compare when frames match (otherwise comparison is meaningless)
            let desyncDetected = false;
            let consecutiveDesyncs = 0;
            let checksWithMatchingFrames = 0;

            for (let check = 0; check < 15; check++) {
                await page1.waitForTimeout(400);

                const s1 = await getState(page1);
                const s2 = await getState(page2);

                if (s1 && s2) {
                    // Only compare if frames match
                    if (s1.frame !== s2.frame) {
                        // Frames differ - skip this check (can't compare meaningfully)
                        if (check % 3 === 0) {
                            console.log(`  [${check}] FRAME MISMATCH: Page1 f=${s1.frame} Page2 f=${s2.frame} (skipping)`);
                        }
                        continue;
                    }

                    checksWithMatchingFrames++;
                    const hashMatch = s1.hash === s2.hash;
                    const entityDiff = Math.abs(s1.entityCount - s2.entityCount);

                    if (!hashMatch) {
                        consecutiveDesyncs++;
                        console.log(`  [${check}] DESYNC (f=${s1.frame}): Page1=${s1.hashHex} e=${s1.entityCount} | Page2=${s2.hashHex} e=${s2.entityCount} | diff=${entityDiff}`);

                        // If we have 3+ consecutive same-frame desyncs, this is likely permanent
                        if (consecutiveDesyncs >= 3) {
                            desyncDetected = true;
                            console.log(`  !!! PERSISTENT DESYNC DETECTED after ${consecutiveDesyncs} consecutive same-frame checks !!!`);
                        }
                    } else {
                        consecutiveDesyncs = 0;
                        if (check % 3 === 0) {
                            console.log(`  [${check}] SYNC (f=${s1.frame}): hash=${s1.hashHex} entities=${s1.entityCount}`);
                        }
                    }
                }
            }

            console.log(`  Total checks with matching frames: ${checksWithMatchingFrames}`);

            // Also check if any DESYNC messages appeared in console
            if (desyncMessages.length > 0) {
                console.log(`  Console DESYNC messages: ${desyncMessages.length}`);
                desyncMessages.forEach(m => console.log(`    ${m}`));
            }

            if (desyncDetected) {
                bugTriggered = true;
                failingAttempt = attempt + 1;
                console.log(`\n!!! BUG REPRODUCED on attempt ${failingAttempt} !!!`);

                // Capture detailed state for comparison
                console.log('\n=== CAPTURING DETAILED STATE FOR COMPARISON ===');
                const detailed1 = await getDetailedEntityData(page1);
                const detailed2 = await getDetailedEntityData(page2);
                compareStates('Page1', detailed1, 'Page2', detailed2);

                break;
            }
        }

        // Take final screenshots
        await page1.screenshot({ path: 'test-results/refresh-desync-page1-final.png' });
        await page2.screenshot({ path: 'test-results/refresh-desync-page2-final.png' });

        // ========================================
        // FINAL STATE CHECK (wait for frames to align)
        // ========================================
        console.log('\n=== FINAL STATE ===');

        // Wait for frames to align before comparing
        let finalHashMatch = false;
        let finalEntityDiff = 0;
        let state1Final: any = null;
        let state2Final: any = null;

        for (let attempt = 0; attempt < 10; attempt++) {
            await page1.waitForTimeout(200);
            state1Final = await getState(page1);
            state2Final = await getState(page2);

            if (state1Final && state2Final && state1Final.frame === state2Final.frame) {
                finalHashMatch = state1Final.hash === state2Final.hash;
                finalEntityDiff = Math.abs(state1Final.entityCount - state2Final.entityCount);

                console.log(`  Aligned at frame ${state1Final.frame}:`);
                console.log('  Page1:', state1Final);
                console.log('  Page2:', state2Final);
                break;
            }
        }

        expect(state1Final).not.toBeNull();
        expect(state2Final).not.toBeNull();

        if (state1Final && state2Final) {
            console.log('\n=== FINAL COMPARISON ===');
            console.log(`  Page1: frame=${state1Final.frame} ${state1Final.entityCount} entities, hash ${state1Final.hashHex}`);
            console.log(`  Page2: frame=${state2Final.frame} ${state2Final.entityCount} entities, hash ${state2Final.hashHex}`);
            console.log(`  Hash match: ${finalHashMatch}`);
            console.log(`  Entity diff: ${finalEntityDiff}`);

            if (bugTriggered) {
                console.log(`\n!!! BUG REPRODUCED: PERMANENT DESYNC AFTER REFRESH (attempt ${failingAttempt}) !!!`);
            }

            // Assertions - these will FAIL if the bug is present
            expect(finalHashMatch, `Final hashes should match: ${state1Final.hashHex} vs ${state2Final.hashHex}`).toBe(true);
            expect(finalEntityDiff, `Entity counts should match: ${state1Final.entityCount} vs ${state2Final.entityCount}`).toBe(0);
        }

        await context1.close();
        await context2.close();
    });
});
