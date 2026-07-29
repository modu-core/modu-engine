/**
 * 3D multi-client convergence.
 *
 * The netcode assumes every client that applies the same ordered inputs to the
 * same starting state ends up with byte-identical state. Everything else -
 * majority-hash consensus, desync detection, resync - is built on that
 * assumption, so it needs a test that actually checks it.
 *
 * These tests stand up N *independent* physics worlds in one process (each one
 * standing in for a client), feed them an identical ordered input stream, and
 * assert their state hashes agree. Independent worlds are the point: a single
 * world stepped twice would pass trivially without proving anything about two
 * machines agreeing.
 *
 * This is the only 3D coverage that runs in CI. The previous 3D tests lived in
 * tests/, which vitest does not collect (it globs src/**\/*.test.ts) and which
 * still imported the pre-reorganisation ../src/physics3d path.
 */
import { describe, test, expect } from 'vitest';
import {
    createWorld, addBody, stepWorld, createBody, createBox, createSphere,
    BodyType, World, RigidBody, saveWorldState, loadWorldState, resetBodyIdCounter,
    applyImpulse,
} from './index';
import { toFixed, vec3 } from '../../math';
import { xxhash32String } from '../../hash/xxhash';

const CLIENT_COUNT = 4;
// Long enough for bodies to fall, collide and settle, but short enough that
// four full simulations stay well inside the default per-test timeout.
const FRAMES = 150;
// Physics over many bodies is genuinely slow; give these headroom so a loaded
// CI machine reports a real failure rather than a timeout.
const TIMEOUT_MS = 30000;

/**
 * Hash the full simulation state.
 *
 * Deliberately derived from saveWorldState() rather than read off the bodies
 * directly, so that a field which fails to serialise shows up as a divergence
 * here instead of silently differing after a snapshot round-trip.
 */
function hashWorld(world: World): number {
    const state = saveWorldState(world);
    const ordered = [...state.bodies].sort((a, b) => a.label.localeCompare(b.label));
    return xxhash32String(JSON.stringify(ordered));
}

/** One simulated client: its own world, built identically to every other. */
interface SimClient {
    name: string;
    world: World;
    bodies: Map<string, RigidBody>;
}

/**
 * Build a client. Every client runs this exact function, so any divergence in
 * the assertions below comes from the simulation, not from differing setup.
 */
function createClient(name: string): SimClient {
    // Body ids are handed out by a module-level counter and are part of the
    // hashed state, so it has to be reset per client for their ids to line up.
    resetBodyIdCounter();

    const world = createWorld(toFixed(-9.8));
    const bodies = new Map<string, RigidBody>();

    const ground = createBody(BodyType.Static, createBox(toFixed(50), toFixed(1), toFixed(50)),
        toFixed(0), toFixed(-1), toFixed(0), 'ground');
    addBody(world, ground);
    bodies.set('ground', ground);

    // A few dynamic bodies that will collide with the ground and each other.
    for (let i = 0; i < 6; i++) {
        const label = `box-${i}`;
        const body = createBody(BodyType.Dynamic, createBox(toFixed(1), toFixed(1), toFixed(1)),
            toFixed(i * 2 - 5), toFixed(6 + i * 3), toFixed(0), label);
        addBody(world, body);
        bodies.set(label, body);
    }

    for (let i = 0; i < 3; i++) {
        const label = `sphere-${i}`;
        const body = createBody(BodyType.Dynamic, createSphere(toFixed(1)),
            toFixed(i * 3 - 3), toFixed(20 + i * 2), toFixed(1), label);
        addBody(world, body);
        bodies.set(label, body);
    }

    return { name, world, bodies };
}

function createClients(count: number): SimClient[] {
    return Array.from({ length: count }, (_, i) => createClient(`client-${i}`));
}

/** An input in the shared ordered stream, addressed to one body. */
interface SimInput {
    frame: number;
    target: string;
    ix: number;
    iy: number;
    iz: number;
}

/**
 * Deterministic pseudo-random input stream.
 *
 * Built once and replayed identically into every client - this stands in for
 * the ordered input stream the authority broadcasts. Uses an LCG rather than
 * Math.random() so the stream is identical on every run and a failure is
 * reproducible.
 */
function buildInputStream(frames: number): SimInput[] {
    const inputs: SimInput[] = [];
    let seed = 12345;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);

    for (let frame = 0; frame < frames; frame++) {
        if (next() % 3 !== 0) continue;
        const targets = ['box-0', 'box-1', 'box-2', 'box-3', 'box-4', 'box-5', 'sphere-0', 'sphere-1', 'sphere-2'];
        inputs.push({
            frame,
            target: targets[next() % targets.length],
            ix: (next() % 200 - 100) / 100,
            iy: (next() % 100) / 100,
            iz: (next() % 200 - 100) / 100,
        });
    }
    return inputs;
}

/** Advance one client to `frames`, applying the shared inputs at their frames. */
function runClient(client: SimClient, inputs: SimInput[], frames: number): void {
    const byFrame = new Map<number, SimInput[]>();
    for (const input of inputs) {
        const list = byFrame.get(input.frame);
        if (list) list.push(input);
        else byFrame.set(input.frame, [input]);
    }

    for (let frame = 0; frame < frames; frame++) {
        for (const input of byFrame.get(frame) ?? []) {
            const body = client.bodies.get(input.target);
            if (body) {
                applyImpulse(body, vec3(toFixed(input.ix), toFixed(input.iy), toFixed(input.iz)));
            }
        }
        stepWorld(client.world);
    }
}

describe('3D multi-client convergence', () => {
    test(`${CLIENT_COUNT} clients replaying identical inputs reach identical state`, () => {
        const inputs = buildInputStream(FRAMES);
        const clients = createClients(CLIENT_COUNT);

        for (const client of clients) {
            runClient(client, inputs, FRAMES);
        }

        const hashes = clients.map(c => ({ name: c.name, hash: hashWorld(c.world) }));
        const reference = hashes[0].hash;

        for (const { name, hash } of hashes) {
            expect(hash, `${name} diverged from ${hashes[0].name}`).toBe(reference);
        }

        // Guard against the simulation collapsing to a trivial state (e.g. every
        // body asleep at the origin), which would make agreement meaningless.
        const state = saveWorldState(clients[0].world);
        expect(state.bodies.length).toBe(10);
        expect(state.bodies.some(b => b.py !== 0)).toBe(true);
    }, TIMEOUT_MS);

    test('clients stay converged when checked every frame, not just at the end', () => {
        // End-state agreement can hide a divergence that appears mid-run and
        // happens to reconverge, so compare at every step.
        const inputs = buildInputStream(120);
        const clients = createClients(3);
        const byFrame = new Map<number, SimInput[]>();
        for (const input of inputs) {
            const list = byFrame.get(input.frame);
            if (list) list.push(input);
            else byFrame.set(input.frame, [input]);
        }

        for (let frame = 0; frame < 120; frame++) {
            for (const client of clients) {
                for (const input of byFrame.get(frame) ?? []) {
                    const body = client.bodies.get(input.target);
                    if (body) applyImpulse(body, vec3(toFixed(input.ix), toFixed(input.iy), toFixed(input.iz)));
                }
                stepWorld(client.world);
            }

            const reference = hashWorld(clients[0].world);
            for (const client of clients.slice(1)) {
                expect(hashWorld(client.world), `${client.name} diverged at frame ${frame}`).toBe(reference);
            }
        }
    }, TIMEOUT_MS);

    test('a late joiner restoring a snapshot converges with clients that ran from the start', () => {
        // This is the late-join path: a client that loads a snapshot at frame N
        // and replays inputs from there must end up identical to one that
        // simulated all N frames itself.
        const inputs = buildInputStream(200);
        const [original, lateJoiner] = createClients(2);

        runClient(original, inputs, 100);

        // Late joiner adopts the snapshot instead of simulating the first 100 frames.
        loadWorldState(lateJoiner.world, saveWorldState(original.world));
        expect(hashWorld(lateJoiner.world)).toBe(hashWorld(original.world));

        // Re-point the late joiner's label map at its own restored bodies.
        lateJoiner.bodies.clear();
        for (const body of lateJoiner.world.bodies) {
            lateJoiner.bodies.set(body.label, body);
        }

        const remaining = inputs.filter(i => i.frame >= 100);
        const advance = (client: SimClient) => {
            const byFrame = new Map<number, SimInput[]>();
            for (const input of remaining) {
                const list = byFrame.get(input.frame);
                if (list) list.push(input);
                else byFrame.set(input.frame, [input]);
            }
            for (let frame = 100; frame < 200; frame++) {
                for (const input of byFrame.get(frame) ?? []) {
                    const body = client.bodies.get(input.target);
                    if (body) applyImpulse(body, vec3(toFixed(input.ix), toFixed(input.iy), toFixed(input.iz)));
                }
                stepWorld(client.world);
            }
        };

        advance(original);
        advance(lateJoiner);

        expect(hashWorld(lateJoiner.world)).toBe(hashWorld(original.world));
    }, TIMEOUT_MS);
});
