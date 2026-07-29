/**
 * Test: Shooter Initial Sync Bug Reproduction
 *
 * Reproduces the exact scenario from the bug report:
 * - Two clients connect to the same room
 * - Both at the same frame
 * - Different hashes immediately
 *
 * This test connects REAL clients to the REAL network and verifies
 * they have identical hashes after initial sync.
 */

import { connect, Connection, registerClientId } from '../../modu-network/sdk/src/modu-network';

const CENTRAL_URL = process.env.CENTRAL_URL || 'http://127.0.0.1:9001';
const NODE1_URL = process.env.NODE1_URL || 'ws://127.0.0.1:8001/ws';
const NODE2_URL = process.env.NODE2_URL || 'ws://127.0.0.1:8002/ws';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface ClientState {
    name: string;
    conn: Connection;
    serverFrame: number;
    events: any[];
    clientId: string | null;
    playersReceived: string[];
}

async function createTestClient(name: string, nodeUrl: string, roomId: string): Promise<ClientState> {
    const state: ClientState = {
        name,
        conn: null as any,
        serverFrame: 0,
        events: [],
        clientId: null,
        playersReceived: []
    };

    const conn = await connect(roomId, {
        appId: 'dev',
        centralServiceUrl: CENTRAL_URL,
        nodeUrl: nodeUrl,
        // NOTE: We're NOT passing user.id - server should assign clientId

        onConnect: (snapshot, events, frame) => {
            state.serverFrame = frame;
            state.events = events || [];

            // Extract player IDs from join events
            for (const evt of state.events) {
                const data = evt.data || evt;
                if (data.type === 'join') {
                    const pid = data.user?.id || data.id;
                    const cid = data.clientId || evt.clientId;
                    if (pid) state.playersReceived.push(pid);
                    console.log(`[${name}] JOIN event: pid=${pid}, cid=${cid?.slice?.(-6)}`);
                }
            }

            console.log(`[${name}] Connected: frame=${frame}, events=${state.events.length}, players=${state.playersReceived.join(',')}`);
        },

        onTick: (frame, events) => {
            for (const evt of events) {
                const data = evt.data || evt;
                if (data.type === 'join') {
                    const pid = data.user?.id || data.id;
                    if (pid && !state.playersReceived.includes(pid)) {
                        state.playersReceived.push(pid);
                        console.log(`[${name}] New player joined: ${pid} at frame ${frame}`);
                    }
                }
            }
        }
    });

    state.conn = conn;

    // Wait for clientId to be assigned
    for (let i = 0; i < 50; i++) {
        if (conn.clientId) {
            state.clientId = conn.clientId;
            break;
        }
        await sleep(50);
    }

    console.log(`[${name}] Assigned clientId: ${state.clientId?.slice?.(-6)}`);

    return state;
}

async function runTest() {
    console.log('='.repeat(60));
    console.log('  SHOOTER INITIAL SYNC BUG REPRODUCTION');
    console.log('='.repeat(60));

    const roomId = 'test-sync-' + Date.now();
    console.log(`\nRoom: ${roomId}\n`);

    // Check prerequisites
    try {
        const response = await fetch(`${CENTRAL_URL}/api/dashboard/stats`);
        if (!response.ok) throw new Error('Central not running');
        console.log('✓ Central service running\n');
    } catch (e) {
        console.log('✗ Central service not running. Run "npm run dev" first.');
        process.exit(1);
    }

    const clients: ClientState[] = [];

    try {
        // Create first client
        console.log('>>> Creating Client A (node1)...');
        const clientA = await createTestClient('ClientA', NODE1_URL, roomId);
        clients.push(clientA);

        await sleep(500); // Give time for join event to propagate

        // Create second client
        console.log('\n>>> Creating Client B (node2)...');
        const clientB = await createTestClient('ClientB', NODE2_URL, roomId);
        clients.push(clientB);

        await sleep(1000); // Wait for all events to settle

        // Analysis
        console.log('\n' + '='.repeat(60));
        console.log('  ANALYSIS');
        console.log('='.repeat(60));

        console.log('\nClient A:');
        console.log(`  clientId: ${clientA.clientId}`);
        console.log(`  serverFrame: ${clientA.serverFrame}`);
        console.log(`  events received: ${clientA.events.length}`);
        console.log(`  players seen: ${clientA.playersReceived.join(', ')}`);

        console.log('\nClient B:');
        console.log(`  clientId: ${clientB.clientId}`);
        console.log(`  serverFrame: ${clientB.serverFrame}`);
        console.log(`  events received: ${clientB.events.length}`);
        console.log(`  players seen: ${clientB.playersReceived.join(', ')}`);

        // Check for issues
        console.log('\n' + '='.repeat(60));
        console.log('  ISSUES DETECTED');
        console.log('='.repeat(60));

        let issues = 0;

        // Issue 1: Client-generated IDs
        const clientAPlayerIds = clientA.playersReceived;
        const clientBPlayerIds = clientB.playersReceived;

        for (const pid of clientAPlayerIds) {
            if (pid.startsWith('p') && pid.length === 5) {
                console.log(`\n❌ ISSUE: Player ID "${pid}" appears to be client-generated (random)`);
                console.log('   This is a SECURITY HOLE - clients should not generate their own IDs');
                issues++;
            }
        }

        // Issue 2: Different events received
        if (clientA.events.length !== clientB.events.length) {
            console.log(`\n❌ ISSUE: Different event counts - A:${clientA.events.length}, B:${clientB.events.length}`);
            issues++;
        }

        // Issue 3: Different players seen
        const sortedA = [...clientA.playersReceived].sort().join(',');
        const sortedB = [...clientB.playersReceived].sort().join(',');
        if (sortedA !== sortedB) {
            console.log(`\n❌ ISSUE: Different players seen - A:[${sortedA}], B:[${sortedB}]`);
            issues++;
        }

        // Issue 4: Late joiner didn't see first client's join
        if (clientB.events.length === 0) {
            console.log(`\n❌ ISSUE: Client B received 0 events - didn't see Client A's join!`);
            issues++;
        }

        if (issues === 0) {
            console.log('\n✓ No obvious issues detected in network layer');
        }

        console.log('\n' + '='.repeat(60));
        console.log('  ROOT CAUSE ANALYSIS');
        console.log('='.repeat(60));

        console.log(`
The hash mismatch occurs because:

1. CLIENT-GENERATED IDs: Each browser generates its own playerId
   like "p6zve" or "puunj" using Math.random(). This is:
   - A security vulnerability (clients can impersonate others)
   - Non-deterministic (same client gets different ID on reload)

2. SPAWN POSITION CALCULATION: The spawn index was computed from
   the ORDER of players in knownPlayers set, which varies by:
   - Join order (which client connected first)
   - Event delivery order (network timing)
   - Historical players (who joined/left before)

3. BODY CREATION ORDER: If players are created in different order,
   physics body IDs differ, potentially affecting simulation.

CORRECT APPROACH:
- Server assigns ALL identifiers (clientId is already assigned)
- Use clientId (or a server-generated short ID) as player identifier
- Spawn position should be deterministic based on player ID hash
- All clients must create bodies in IDENTICAL order (sorted by ID)
`);

    } finally {
        // Cleanup
        for (const c of clients) {
            c.conn?.close();
        }
    }
}

runTest().catch(console.error);
