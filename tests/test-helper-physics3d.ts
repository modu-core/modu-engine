/**
 * Test Helper for 3D Physics Tests
 *
 * Provides convenience wrappers around physics3d for testing.
 * This replaces the deleted standalone.ts for test purposes.
 */

import {
    createWorld, addBody, stepWorld, removeBody,
    createBody, createBox, createSphere,
    World, RigidBody, BodyType, WorldState,
    resetBodyIdCounter, getBodyIdCounter, setBodyIdCounter,
    saveWorldState, loadWorldState
} from '../src/plugins/physics3d';
import { toFixed, vec3Zero, quatIdentity } from '../src/math';

/** Simple hash for 3D world state - for testing only */
function computeWorldChecksum(world: World): number {
    let hash = 0;
    for (const body of world.bodies) {
        hash = (hash * 31 + body.position.x) | 0;
        hash = (hash * 31 + body.position.y) | 0;
        hash = (hash * 31 + body.position.z) | 0;
        hash = (hash * 31 + body.linearVelocity.x) | 0;
        hash = (hash * 31 + body.linearVelocity.y) | 0;
        hash = (hash * 31 + body.linearVelocity.z) | 0;
    }
    return hash >>> 0;
}

export interface TestEngine {
    world: World;
    bodies: Map<string, RigidBody>;
    frame: number;
    gameState: any;
    onSimulate: (frame: number) => void;

    // Convenience methods
    createStaticBox(x: number, y: number, z: number, hw: number, hh: number, hd: number, id?: string): RigidBody;
    createDynamicBox(x: number, y: number, z: number, hw: number, hh: number, hd: number, id?: string): RigidBody;
    createDynamicSphere(x: number, y: number, z: number, radius: number, id?: string): RigidBody;
    tick(): void;
    saveState(): any;
    loadState(state: any): void;

    // Additional methods needed by determinism tests
    setLocalInput(input: any): void;
    getWorldSnapshot(): WorldState;
    loadWorldSnapshot(snapshot: WorldState): void;
    setFrame(frame: number): void;
    getChecksum(): number;
}

export interface TestEngineOptions {
    gravity?: number;
    inputDelay?: number;
    maxRollbackFrames?: number;
    physicsTimestep?: number;
}

/**
 * Create a test engine for physics testing.
 * This is a simple wrapper around physics3d for tests.
 */
export function createTestEngine(playerId: string, options: TestEngineOptions = {}): TestEngine {
    const gravity = options.gravity ?? -9.8;

    resetBodyIdCounter();

    const world = createWorld(toFixed(gravity));
    const bodies = new Map<string, RigidBody>();
    let frame = 0;
    // Note: currentInput is stored but not directly used in tick() because
    // this simple test helper relies on onSimulate callback to process inputs.
    // The game/test code sets onSimulate to handle input processing.
    let currentInput: any = {}; // eslint-disable-line @typescript-eslint/no-unused-vars
    let onSimulate: (frame: number) => void = () => {};
    let gameState: any = {};

    const engine: TestEngine = {
        world,
        bodies,
        get frame() { return frame; },
        set frame(f: number) { frame = f; },
        get gameState() { return gameState; },
        set gameState(gs: any) { gameState = gs; },
        get onSimulate() { return onSimulate; },
        set onSimulate(fn: (frame: number) => void) { onSimulate = fn; },

        createStaticBox(x: number, y: number, z: number, hw: number, hh: number, hd: number, id?: string): RigidBody {
            const body = createBody(
                BodyType.Static,
                createBox(toFixed(hw), toFixed(hh), toFixed(hd)),
                toFixed(x), toFixed(y), toFixed(z)
            );
            addBody(world, body);
            if (id) bodies.set(id, body);
            return body;
        },

        createDynamicBox(x: number, y: number, z: number, hw: number, hh: number, hd: number, id?: string): RigidBody {
            const body = createBody(
                BodyType.Dynamic,
                createBox(toFixed(hw), toFixed(hh), toFixed(hd)),
                toFixed(x), toFixed(y), toFixed(z)
            );
            addBody(world, body);
            if (id) bodies.set(id, body);
            return body;
        },

        createDynamicSphere(x: number, y: number, z: number, radius: number, id?: string): RigidBody {
            const body = createBody(
                BodyType.Dynamic,
                createSphere(toFixed(radius)),
                toFixed(x), toFixed(y), toFixed(z)
            );
            addBody(world, body);
            if (id) bodies.set(id, body);
            return body;
        },

        tick(): void {
            onSimulate(frame);
            stepWorld(world);
            frame++;
        },

        saveState(): any {
            return {
                worldState: saveWorldState(world),
                bodyIdCounter: getBodyIdCounter(),
                frame,
                gameState: JSON.parse(JSON.stringify(gameState))
            };
        },

        loadState(state: any): void {
            loadWorldState(world, state.worldState);
            setBodyIdCounter(state.bodyIdCounter);
            frame = state.frame;
            if (state.gameState) {
                gameState = JSON.parse(JSON.stringify(state.gameState));
            }
        },

        // Methods needed by determinism tests
        setLocalInput(input: any): void {
            currentInput = input;
        },

        getWorldSnapshot(): WorldState {
            return saveWorldState(world);
        },

        loadWorldSnapshot(snapshot: WorldState): void {
            loadWorldState(world, snapshot);
        },

        setFrame(f: number): void {
            frame = f;
        },

        getChecksum(): number {
            return computeWorldChecksum(world);
        }
    };

    return engine;
}

// Alias for backward compatibility with tests
export const createStandaloneEngine = createTestEngine;
export type StandaloneEngine = TestEngine;

// Re-export for convenience
export { resetBodyIdCounter, getBodyIdCounter, setBodyIdCounter } from '../src/plugins/physics3d';
export { toFixed, toFloat, vec3, quatFromAxisAngle, FP_ONE } from '../src/math';
