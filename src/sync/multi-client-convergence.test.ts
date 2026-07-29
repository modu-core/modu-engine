/**
 * 2D multi-client convergence at the Game/ECS level.
 *
 * Companion to plugins/physics3d/convergence.test.ts, which covers the same
 * invariant for the 3D physics world. This one exercises the layer the games
 * actually run on: entities, systems, spawning and the ordered input stream.
 *
 * The existing sync tests in this directory each pin one specific past bug
 * (late joiner, rejoin, resync). What was missing was the general claim they
 * all depend on: N clients that process the same ordered inputs agree, and
 * keep agreeing. The existing tests also stop at 2 clients, so a fault that
 * only appears once a third participant votes in the majority hash is invisible.
 *
 * ---------------------------------------------------------------------------
 * IMPORTANT: why clients run one at a time
 * ---------------------------------------------------------------------------
 * defineComponent() allocates ONE storage per component name, at module scope
 * (see componentRegistry in core/component.ts). Component data is therefore
 * shared by every World in the process and indexed by entity index - it is not
 * per-World state.
 *
 * Two Game instances alive at once whose entities land on the same indices
 * silently overwrite each other's component data. A test that builds N Games
 * and compares their hashes is not comparing N simulations; it is reading one
 * set of arrays N times, and it passes no matter what the engine does.
 *
 * So each simulated client is built, run to completion, and reduced to plain
 * recorded values (hashes, counts) before the next one starts. Only the
 * recordings are compared. The guard test at the bottom exists to catch any
 * regression back into the vacuous arrangement.
 */
import { describe, test, expect, vi } from 'vitest';
import { Game } from '../game';
import { Transform2D, Player } from '../components';

const CLIENT_COUNT = 4;
const WIDTH = 800;
const HEIGHT = 600;

function createMockConnection(clientId: string) {
    return {
        clientId,
        send: vi.fn(),
        sendSnapshot: vi.fn(),
        sendStateHash: vi.fn(),
        sendPartitionData: vi.fn(),
        requestResync: vi.fn(),
        leaveRoom: vi.fn(),
        totalBytesIn: 0,
        totalBytesOut: 0,
        bandwidthIn: 0,
        bandwidthOut: 0,
    };
}

const spawnPositionFor = (clientId: string) => {
    const seed = [...clientId].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7) >>> 0;
    return { x: seed % WIDTH, y: (seed >> 8) % HEIGHT };
};

/**
 * Build a client. Every simulated client is constructed by this same function
 * so that any divergence comes from input processing, not from setup drift.
 */
function createClient(clientId: string): Game {
    const game = new Game({ tickRate: 60 });
    (game as any).connection = createMockConnection(clientId);
    (game as any).localClientIdStr = clientId;

    game.defineEntity('cell').with(Transform2D).with(Player);
    game.defineEntity('food').with(Transform2D);

    (game as any).callbacks = {
        onConnect: (joinedId: string) => {
            // Spawn deterministically from the client id, not from any local
            // state - every client must place a joiner identically.
            const spawn = spawnPositionFor(joinedId);
            const cell = game.spawn('cell', spawn);
            cell.get(Player).clientId = (game as any).internClientId(joinedId);
        },
    };

    // Movement system: applies each client's queued input to its own cell.
    //
    // processInput() only files a 'move' into the world's input registry - it
    // does not itself change any component. Without a system consuming that
    // registry the moves are inert and every run trivially agrees.
    game.addSystem(() => {
        for (const entity of (game as any).world.query(Player, Transform2D)) {
            const input = (game as any).world.getInput(entity.get(Player).clientId);
            if (!input || input.type !== 'move') continue;

            const transform = entity.get(Transform2D);
            // Speed depends on the entity's current position, so the update is
            // order-dependent rather than a commutative sum. Wrap rather than
            // clamp: clamping saturates at the edges and erases differences.
            const speed = transform.x < WIDTH / 2 ? 2 : 1;
            transform.x = (transform.x + (input.dx ?? 0) * speed + WIDTH) % WIDTH;
            transform.y = (transform.y + (input.dy ?? 0) * speed + HEIGHT) % HEIGHT;
        }
    });

    // Fixed initial world, identical on every client.
    for (let i = 0; i < 40; i++) {
        game.spawn('food', { x: (i * 37) % WIDTH, y: (i * 53) % HEIGHT });
    }

    return game;
}

const hashOf = (game: Game): number => (game as any).world.getStateHash();
const entityCountOf = (game: Game): number => (game as any).world.entityCount;

/** One entry in the ordered stream the authority would broadcast. */
interface OrderedInput {
    seq: number;
    frame: number;
    clientId: string;
    data: any;
}

/**
 * Deterministic ordered input stream: joins at frame 0, then movement.
 *
 * At most one input per client per frame, which is what the tick loop actually
 * delivers. That limit is load-bearing rather than cosmetic - see replay().
 *
 * Seeded LCG rather than Math.random() so failures reproduce exactly.
 */
function buildInputStream(clientIds: string[], frames: number): OrderedInput[] {
    const inputs: OrderedInput[] = [];
    let seq = 0;
    let seed = 98765;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);

    for (const clientId of clientIds) {
        inputs.push({ seq: ++seq, frame: 0, clientId, data: { type: 'join', clientId } });
    }

    for (let frame = 0; frame < frames; frame++) {
        for (const clientId of clientIds) {
            if (next() % 4 !== 0) continue;
            inputs.push({
                seq: ++seq,
                frame,
                clientId,
                data: { type: 'move', dx: (next() % 7) - 3, dy: (next() % 7) - 3 },
            });
        }
    }
    return inputs;
}

/**
 * Feed the ordered stream into a client and tick it, as the net layer would.
 *
 * Inputs are dispatched on the frame they belong to. Two input-registry
 * semantics make that necessary rather than merely tidy:
 *
 *  - world.setInput() *overwrites* the entry for a client, so if several inputs
 *    from one client land before a single tick, only the last one is ever
 *    applied and the rest are silently discarded.
 *  - world.tick() does not clear the registry, so an input keeps being applied
 *    on every later tick until that client sends another one.
 *
 * A consequence worth knowing when writing assertions: an input at frame 0 has
 * no effect at all, because entities spawned during frame 0 are not visible to
 * queries until the following tick, by which point frame 1's input has already
 * replaced it in the registry.
 */
function replay(game: Game, inputs: OrderedInput[], frames: number, onFrame?: (game: Game) => void): void {
    const byFrame = new Map<number, OrderedInput[]>();
    for (const input of inputs) {
        const list = byFrame.get(input.frame);
        if (list) list.push(input);
        else byFrame.set(input.frame, [input]);
    }

    for (let frame = 0; frame < frames; frame++) {
        for (const input of byFrame.get(frame) ?? []) {
            (game as any).processInput(input);
        }
        (game as any).world.tick(frame);
        onFrame?.(game);
    }
}

/** What a finished client run is reduced to. The Game itself is discarded. */
interface RunRecord {
    clientId: string;
    finalHash: number;
    frameHashes: number[];
    entityCount: number;
    activeClients: number;
    cellPositions: string[];
}

/** Build, run and retire one client, keeping only plain recorded values. */
function runClient(clientId: string, inputs: OrderedInput[], frames: number): RunRecord {
    const game = createClient(clientId);
    const frameHashes: number[] = [];
    replay(game, inputs, frames, g => frameHashes.push(hashOf(g)));

    const cellPositions = [...(game as any).world.query(Player, Transform2D)]
        .map((e: any) => `${e.get(Transform2D).x},${e.get(Transform2D).y}`);

    return {
        clientId,
        finalHash: hashOf(game),
        frameHashes,
        entityCount: entityCountOf(game),
        activeClients: (game as any).activeClients.length,
        cellPositions,
    };
}

describe('2D multi-client convergence', () => {
    const clientIds = Array.from({ length: CLIENT_COUNT }, (_, i) => `client-${i}`);

    test(`${CLIENT_COUNT} clients replaying identical inputs reach identical state`, () => {
        const inputs = buildInputStream(clientIds, 120);
        const runs = clientIds.map(id => runClient(id, inputs, 120));

        const reference = runs[0];
        for (const run of runs) {
            expect(run.finalHash, `${run.clientId} diverged from ${reference.clientId}`)
                .toBe(reference.finalHash);
            expect(run.entityCount, `${run.clientId} entity count differs`)
                .toBe(reference.entityCount);
            expect(run.cellPositions, `${run.clientId} cell positions differ`)
                .toEqual(reference.cellPositions);
        }

        // All joiners must have been spawned and registered, otherwise the runs
        // could be agreeing on a state where nothing happened.
        expect(reference.entityCount).toBe(40 + CLIENT_COUNT);
        expect(reference.activeClients).toBe(CLIENT_COUNT);
        expect(reference.cellPositions.length).toBe(CLIENT_COUNT);

        // And the movement system must actually have moved somebody.
        const spawnPositions = clientIds.map(id => {
            const p = spawnPositionFor(id);
            return `${p.x},${p.y}`;
        });
        expect(
            reference.cellPositions.some(p => !spawnPositions.includes(p)),
            'no cell moved - inputs had no effect on state',
        ).toBe(true);
    });

    test('clients agree at every frame, not only at the end', () => {
        // A divergence that appears mid-run and happens to reconverge by the
        // final frame would slip past an end-state-only comparison.
        const inputs = buildInputStream(clientIds, 60);
        const runs = clientIds.map(id => runClient(id, inputs, 60));

        const reference = runs[0];
        expect(reference.frameHashes.length).toBe(60);

        for (const run of runs.slice(1)) {
            const firstDivergence = run.frameHashes.findIndex(
                (h, frame) => h !== reference.frameHashes[frame],
            );
            expect(firstDivergence, `${run.clientId} first diverged at frame ${firstDivergence}`)
                .toBe(-1);
        }

        // The per-frame hashes must not be constant, or "agreement at every
        // frame" would just mean nothing ever changed.
        expect(new Set(reference.frameHashes).size).toBeGreaterThan(1);
    });

    test('a late joiner adopting a snapshot converges with a client that ran from the start', () => {
        const inputs = buildInputStream(clientIds, 100);

        // Phase 1: the authority runs the full stream; keep its snapshot bytes
        // and final hash, then let it go.
        const authority = createClient('client-0');
        replay(authority, inputs, 100);
        const snapshot = (authority as any).getNetworkSnapshot();
        const authorityHash = hashOf(authority);
        const authorityEntities = entityCountOf(authority);

        // Phase 2: a fresh client adopts that snapshot instead of replaying
        // history. Nothing from phase 1 is alive at this point.
        const lateJoiner = createClient('client-late');
        (lateJoiner as any).loadNetworkSnapshot(snapshot);

        expect(hashOf(lateJoiner), 'late joiner did not match authority after loading snapshot')
            .toBe(authorityHash);
        expect(entityCountOf(lateJoiner)).toBe(authorityEntities);
    });

    test('runs with different inputs produce different state (guards the tests above)', () => {
        // The convergence assertions are only meaningful if this setup can
        // diverge at all. If the hash were insensitive to input - or, as an
        // earlier version of this file did, if several live Games shared one
        // component storage - every comparison above would pass regardless of
        // what the engine did. Reversing every movement delta must be visible.
        const inputs = buildInputStream(clientIds, 60);
        const negated = inputs.map(i =>
            i.data.type === 'move'
                ? { ...i, data: { ...i.data, dx: -i.data.dx, dy: -i.data.dy } }
                : i,
        );

        const normalRun = runClient('client-0', inputs, 60);
        const negatedRun = runClient('client-0', negated, 60);

        expect(negatedRun.finalHash, 'negating every input left the state hash unchanged')
            .not.toBe(normalRun.finalHash);
        expect(negatedRun.cellPositions).not.toEqual(normalRun.cellPositions);
    });
});
