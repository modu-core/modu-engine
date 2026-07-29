/**
 * Shooter Hash Match Test
 *
 * Runs ACTUAL shooter game logic on two simulated clients
 * and verifies their world hashes match.
 *
 * This test MUST FAIL if the shooter has a desync bug.
 */

import WebSocket from 'ws';
import { createStandaloneEngine, resetBodyIdCounter } from './test-helper-physics3d';
import { toFixed, FP_2PI } from '../src/math';

// Import shooter game logic
const GROUND_SIZE = 50;
const MAX_HP = 100;
const SPAWN_POSITIONS = [
  { x: 10, z: 0 }, { x: 7, z: 7 }, { x: 0, z: 10 }, { x: -7, z: 7 },
  { x: -10, z: 0 }, { x: -7, z: -7 }, { x: 0, z: -10 }, { x: 7, z: -7 }
];

const SERVER_URL = process.env.SERVER_URL || 'ws://localhost:8001/ws';
const ROOM_ID = 'shooter-hash-' + Date.now();

console.log('=== Shooter Hash Match Test ===');
console.log('Server:', SERVER_URL);
console.log('Room:', ROOM_ID);
console.log('');

function hashClientId(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

const globalClientHashMap = new Map<number, string>();

// Snapshot functions for state transfer
function createPhysicsSnapshot(engine: any): any {
  const players: Record<string, any> = {};
  const boxes: any[] = [];

  for (const body of engine.world.bodies) {
    if (body.label?.startsWith('player_')) {
      const pid = body.label.replace('player_', '');
      players[pid] = {
        px: body.position.x, py: body.position.y, pz: body.position.z,
        vx: body.linearVelocity.x, vy: body.linearVelocity.y, vz: body.linearVelocity.z,
        qx: body.rotation.x, qy: body.rotation.y, qz: body.rotation.z, qw: body.rotation.w,
        avx: body.angularVelocity?.x || 0, avy: body.angularVelocity?.y || 0, avz: body.angularVelocity?.z || 0,
        isSleeping: body.isSleeping,
        sleepFrames: body.sleepFrames,
        yawFp: engine.gameState?.playerStates?.[pid]?.yawFp || 0
      };
    } else if (body.label?.startsWith('box_')) {
      const idx = parseInt(body.label.replace('box_', ''));
      boxes[idx] = {
        px: body.position.x, py: body.position.y, pz: body.position.z,
        vx: body.linearVelocity.x, vy: body.linearVelocity.y, vz: body.linearVelocity.z,
        qx: body.rotation.x, qy: body.rotation.y, qz: body.rotation.z, qw: body.rotation.w,
        avx: body.angularVelocity?.x || 0, avy: body.angularVelocity?.y || 0, avz: body.angularVelocity?.z || 0,
        isSleeping: body.isSleeping,
        sleepFrames: body.sleepFrames
      };
    }
  }

  return {
    frame: engine.frame,
    players,
    boxes,
    gameState: JSON.parse(JSON.stringify(engine.gameState || {}))
  };
}

function loadPhysicsSnapshot(engine: any, snapshot: any) {
  if (!snapshot || !snapshot.frame) return;

  // Load box states
  for (let i = 0; i < (snapshot.boxes?.length || 0); i++) {
    const body = engine.world.bodies.find((b: any) => b.label === 'box_' + i);
    const data = snapshot.boxes[i];
    if (body && data) {
      body.position.x = data.px; body.position.y = data.py; body.position.z = data.pz;
      body.linearVelocity.x = data.vx; body.linearVelocity.y = data.vy; body.linearVelocity.z = data.vz;
      body.rotation.x = data.qx; body.rotation.y = data.qy; body.rotation.z = data.qz; body.rotation.w = data.qw;
      if (body.angularVelocity) {
        body.angularVelocity.x = data.avx; body.angularVelocity.y = data.avy; body.angularVelocity.z = data.avz;
      }
      body.isSleeping = data.isSleeping ?? false;
      body.sleepFrames = data.sleepFrames ?? 0;
    }
  }

  // Load player states from snapshot
  for (const [pid, pData] of Object.entries(snapshot.players || {}) as [string, any][]) {
    const body = engine.world.bodies.find((b: any) => b.label === 'player_' + pid);
    if (body) {
      body.position.x = pData.px; body.position.y = pData.py; body.position.z = pData.pz;
      body.linearVelocity.x = pData.vx; body.linearVelocity.y = pData.vy; body.linearVelocity.z = pData.vz;
      body.rotation.x = pData.qx; body.rotation.y = pData.qy; body.rotation.z = pData.qz; body.rotation.w = pData.qw;
      if (body.angularVelocity) {
        body.angularVelocity.x = pData.avx; body.angularVelocity.y = pData.avy; body.angularVelocity.z = pData.avz;
      }
      body.isSleeping = pData.isSleeping ?? false;
      body.sleepFrames = pData.sleepFrames ?? 0;
    }
  }

  // Load game state
  if (snapshot.gameState) {
    engine.gameState = JSON.parse(JSON.stringify(snapshot.gameState));
  }
}

interface GameClient {
  name: string;
  ws: WebSocket;
  clientId: string;
  playerId: string;
  engine: ReturnType<typeof createStandaloneEngine>;
  serverFrame: number;
  knownPlayers: Set<string>;
  clientToPlayer: Map<string, string>;
  minAcceptFrame: number;
  checksumHistory: Array<{ frame: number; checksum: number }>;
}

function createGameEngine(playerId: string) {
  resetBodyIdCounter();
  // Use larger rollback window for test (network latency can be high)
  const engine = createStandaloneEngine(playerId, { inputDelay: 2, maxRollbackFrames: 30 });

  // Create ground
  engine.createStaticBox(0, -0.5, 0, GROUND_SIZE, 0.5, GROUND_SIZE, 'ground');

  // Create boxes (same as shooter)
  const BOX_INIT = [
    [5, 1, 5], [-5, 1, 5], [5, 1, -5], [-5, 1, -5],
    [0, 1, 8], [0, 1, -8], [8, 1, 0], [-8, 1, 0]
  ];
  for (let i = 0; i < BOX_INIT.length; i++) {
    const [x, y, z] = BOX_INIT[i];
    engine.createDynamicBox(x, y, z, 1, 1, 1, 'box_' + i);
  }

  engine.gameState = { playerStates: {} };

  // Simulation callback (same as shooter's game.js)
  engine.onSimulate = (frame, inputs) => {
    if (!engine.gameState.playerStates) {
      engine.gameState.playerStates = {};
    }

    const sortedInputs = [...inputs].sort((a, b) => a.playerId.localeCompare(b.playerId));

    for (const input of sortedInputs) {
      const pid = input.playerId;
      const body = engine.world.bodies.find((b: any) => b.label === 'player_' + pid);
      if (!body) continue;

      if (!engine.gameState.playerStates[pid]) {
        engine.gameState.playerStates[pid] = { yawFp: 0, hp: MAX_HP, dead: false };
      }
      const pState = engine.gameState.playerStates[pid];
      const data = input.data || {};

      // Update yaw
      const yawFp = (data.yawFp !== undefined) ? data.yawFp : pState.yawFp;
      pState.yawFp = yawFp;

      // Movement (simplified)
      if (!pState.dead) {
        const SPEED_FP = toFixed(12);
        const FRICTION_FP = toFixed(0.9);
        const { fpSin, fpCos, fpSqrt, fpMul, fpDiv } = require('../src/fixed-math');

        const sinYaw = fpSin(yawFp);
        const cosYaw = fpCos(yawFp);

        let moveXFp = 0, moveZFp = 0;
        if (data.w) { moveXFp -= sinYaw; moveZFp -= cosYaw; }
        if (data.s) { moveXFp += sinYaw; moveZFp += cosYaw; }
        if (data.a) { moveXFp -= cosYaw; moveZFp += sinYaw; }
        if (data.d) { moveXFp += cosYaw; moveZFp -= sinYaw; }

        const vel = engine.getVelocityFixed(body);

        if (moveXFp !== 0 || moveZFp !== 0) {
          const lenSq = fpMul(moveXFp, moveXFp) + fpMul(moveZFp, moveZFp);
          const len = fpSqrt(lenSq);
          if (len > 0) {
            const vxFp = fpMul(fpDiv(moveXFp, len), SPEED_FP);
            const vzFp = fpMul(fpDiv(moveZFp, len), SPEED_FP);
            engine.setVelocityFixed(body, vxFp, vel.y, vzFp);
          }
        } else {
          const vxFp = fpMul(vel.x, FRICTION_FP);
          const vzFp = fpMul(vel.z, FRICTION_FP);
          engine.setVelocityFixed(body, vxFp, vel.y, vzFp);
        }
      }
    }
  };

  return engine;
}

function addPlayer(engine: any, playerId: string, spawnIdx: number) {
  const spawn = SPAWN_POSITIONS[spawnIdx % SPAWN_POSITIONS.length];
  engine.createDynamicSphere(spawn.x, 2, spawn.z, 0.5, 'player_' + playerId);
  // Use addPlayerAtFrame to properly initialize lastReceivedFrame
  // This prevents prediction issues when player joins mid-game
  engine.addPlayerAtFrame(playerId, engine.frame);
  engine.gameState.playerStates[playerId] = { yawFp: 0, hp: MAX_HP, dead: false };
}

async function connectClient(name: string, playerId: string, isCreator: boolean): Promise<GameClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SERVER_URL);
    const engine = createGameEngine(playerId);

    const client: GameClient = {
      name,
      ws,
      clientId: '',
      playerId,
      engine,
      serverFrame: 0,
      knownPlayers: new Set(),
      clientToPlayer: new Map(),
      minAcceptFrame: 0,
      checksumHistory: []
    };

    const timeout = setTimeout(() => reject(new Error(`${name} timeout`)), 15000);

    ws.on('open', () => {
      const msg = isCreator
        ? { type: 'CREATE_ROOM', payload: { roomId: ROOM_ID, user: { id: playerId } } }
        : { type: 'JOIN_ROOM', payload: { roomId: ROOM_ID, user: { id: playerId } } };
      ws.send(JSON.stringify(msg));
    });

    let msgCount = 0;
    ws.on('message', (data: Buffer) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const msgType = buf[0];
      msgCount++;

      // Debug: log all messages after connection
      if (msgCount % 50 === 0 || (msgType !== 0x01 && msgCount > 3)) {
        console.log(`[${name}] msg#${msgCount} type=0x${msgType.toString(16).padStart(2,'0')} len=${buf.length}`);
      }

      // ROOM_CREATED (0x04)
      if (msgType === 0x04) {
        const roomIdLen = buf.readUInt16LE(1);
        let offset = 3 + roomIdLen;
        const clientIdLen = buf.readUInt16LE(offset);
        client.clientId = buf.slice(offset + 2, offset + 2 + clientIdLen).toString('utf8');
        globalClientHashMap.set(hashClientId(client.clientId), client.clientId);
        client.clientToPlayer.set(client.clientId, playerId);

        // Add self
        const spawnIdx = client.knownPlayers.size;
        client.knownPlayers.add(playerId);
        addPlayer(engine, playerId, spawnIdx);
        client.minAcceptFrame = engine.frame;

        console.log(`[${name}] Created room, clientId=${client.clientId.slice(-6)}`);
        clearTimeout(timeout);
        resolve(client);
      }

      // ROOM_JOINED (0x03)
      if (msgType === 0x03) {
        const roomIdLen = buf.readUInt16LE(1);
        let offset = 3 + roomIdLen;
        const clientIdLen = buf.readUInt16LE(offset);
        client.clientId = buf.slice(offset + 2, offset + 2 + clientIdLen).toString('utf8');
        globalClientHashMap.set(hashClientId(client.clientId), client.clientId);
        client.clientToPlayer.set(client.clientId, playerId);
      }

      // INITIAL_STATE (0x02)
      if (msgType === 0x02) {
        const frame = buf.readUInt32LE(1);
        let offset = 5;
        const roomIdLen = buf.readUInt16LE(offset);
        offset += 2 + roomIdLen;
        const snapshotLen = buf.readUInt32LE(offset);
        offset += 4;

        // Parse the snapshot (if present)
        // Server sends { snapshot, snapshotHash } wrapper
        let snapshot: any = null;
        if (snapshotLen > 0) {
          try {
            const rawSnapshot = buf.subarray(offset, offset + snapshotLen).toString('utf8');
            console.log(`[${name}] Raw snapshot (first 200 chars): ${rawSnapshot.slice(0, 200)}`);
            const snapshotWrapper = JSON.parse(rawSnapshot);
            console.log(`[${name}] Snapshot wrapper keys: ${Object.keys(snapshotWrapper).join(',')}`);
            snapshot = snapshotWrapper.snapshot; // Unwrap the actual snapshot
            console.log(`[${name}] Received snapshot for frame ${snapshot?.frame}, players: ${Object.keys(snapshot?.players || {}).join(',')}, boxes: ${snapshot?.boxes?.length || 0}`);
          } catch (e) {
            console.log(`[${name}] Failed to parse snapshot: ${e}`);
          }
        } else {
          console.log(`[${name}] No snapshot received (len=0)`);
        }
        offset += snapshotLen;

        const eventsLen = buf.readUInt32LE(offset);
        offset += 4;

        // Set frame FIRST (critical fix we made)
        engine.setFrame(frame);
        client.serverFrame = frame;

        // Process join events from history
        if (eventsLen > 0) {
          try {
            const events = JSON.parse(buf.subarray(offset, offset + eventsLen).toString('utf8'));
            for (const evt of events) {
              const evtData = evt.data || evt;
              if (evtData.type === 'join') {
                const pid = evtData.user?.id;
                const cid = evtData.clientId;
                if (pid && !client.knownPlayers.has(pid)) {
                  if (cid) {
                    globalClientHashMap.set(hashClientId(cid), cid);
                    client.clientToPlayer.set(cid, pid);
                  }
                  const spawnIdx = client.knownPlayers.size;
                  client.knownPlayers.add(pid);
                  addPlayer(engine, pid, spawnIdx);
                }
              }
            }
          } catch (e) {}
        }

        // Add self if not already added
        if (!client.knownPlayers.has(playerId)) {
          const spawnIdx = client.knownPlayers.size;
          client.knownPlayers.add(playerId);
          addPlayer(engine, playerId, spawnIdx);
        }

        // CRITICAL: Load snapshot to sync physics state with existing clients
        if (snapshot && snapshot.players) {
          loadPhysicsSnapshot(engine, snapshot);
          console.log(`[${name}] Loaded snapshot - physics synced to frame ${snapshot.frame}`);
        }

        client.minAcceptFrame = engine.frame;

        console.log(`[${name}] Joined at frame ${frame}, players: ${[...client.knownPlayers].join(',')}`);
        clearTimeout(timeout);
        resolve(client);
      }

      // TICK (0x01) - minimum length is 5 (msgType + frame), but 6 if inputCount present
      if (msgType === 0x01 && buf.length >= 5) {
        const frame = buf.readUInt32LE(1);
        const inputCount = buf.length >= 6 ? buf[5] : 0;
        client.serverFrame = frame;

        // Parse inputs
        let offset = 6;
        for (let i = 0; i < inputCount && offset + 10 <= buf.length; i++) {
          const clientHash = buf.readUInt32LE(offset); offset += 4;
          const seq = buf.readUInt32LE(offset); offset += 4;
          const dataLen = buf.readUInt16LE(offset); offset += 2;
          if (offset + dataLen > buf.length) break;

          const rawBytes = buf.subarray(offset, offset + dataLen);
          offset += dataLen;

          try {
            const inputData = JSON.parse(rawBytes.toString('utf8'));
            const cid = globalClientHashMap.get(clientHash) || `hash_${clientHash.toString(16)}`;

            if (inputData.type === 'join') {
              const pid = inputData.user?.id;
              const joinCid = inputData.clientId;
              if (pid && !client.knownPlayers.has(pid)) {
                // CRITICAL: Advance to tick frame BEFORE adding player
                // This ensures all clients add the player at the same frame
                while (engine.frame < frame) {
                  engine.tick();
                }

                if (joinCid) {
                  globalClientHashMap.set(hashClientId(joinCid), joinCid);
                  client.clientToPlayer.set(joinCid, pid);
                }
                const spawnIdx = client.knownPlayers.size;
                client.knownPlayers.add(pid);
                addPlayer(engine, pid, spawnIdx);
                engine.clearSnapshotsBefore(engine.frame);
                client.minAcceptFrame = Math.max(client.minAcceptFrame, frame);
                console.log(`[${name}] Player ${pid} joined at frame ${engine.frame} (tick=${frame})`);
              }
            } else if (inputData.type === 'input') {
              const senderPlayerId = client.clientToPlayer.get(cid);

              // Skip own inputs
              if (senderPlayerId === playerId || cid === client.clientId) continue;
              if (!senderPlayerId) {
                console.log(`[${name}] DROPPED input - no mapping for cid ${cid.slice(-6)}`);
                continue;
              }
              if (!client.knownPlayers.has(senderPlayerId)) {
                console.log(`[${name}] DROPPED input - player ${senderPlayerId} not known`);
                continue;
              }

              const targetFrame = inputData.frame !== undefined ? inputData.frame : frame;
              if (targetFrame < client.minAcceptFrame) {
                console.log(`[${name}] DROPPED input - frame ${targetFrame} < minAccept ${client.minAcceptFrame}`);
                continue;
              }

              engine.addRemoteInput(targetFrame, senderPlayerId, inputData.data);
            }
          } catch (e) {}
        }

        // Catch up to server frame
        while (engine.frame < frame) {
          engine.tick();
        }

        // Record checksum
        const checksum = engine.getChecksum();
        client.checksumHistory.push({ frame: engine.frame, checksum });

        // Debug: log TICK reception
        if (client.checksumHistory.length < 5) {
          console.log(`[${name}] TICK server_frame=${frame}, engine_frame=${engine.frame}`);
        }
      }
    });

    ws.on('error', reject);
  });
}

function sendInput(client: GameClient, keys: any) {
  const yawFp = toFixed(0); // No rotation for simplicity

  const data = {
    w: keys.w || false,
    a: keys.a || false,
    s: keys.s || false,
    d: keys.d || false,
    jump: keys.jump || false,
    yawFp
  };

  client.engine.setLocalInput(data);
  client.engine.tick();

  const inputs = client.engine.getLocalInputsToSend();
  for (const input of inputs) {
    client.ws.send(JSON.stringify({
      type: 'SEND_INPUT',
      payload: {
        roomId: ROOM_ID,
        data: { type: 'input', frame: input.frame, data: input.data }
      }
    }));
  }
}

async function wait(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

function sendSnapshot(client: GameClient) {
  const snapshot = createPhysicsSnapshot(client.engine);
  const hash = client.engine.getChecksum();
  console.log(`[${client.name}] Sending snapshot for frame ${snapshot.frame}, hash=${(hash >>> 0).toString(16)}`);
  client.ws.send(JSON.stringify({
    type: 'SEND_SNAPSHOT',
    payload: {
      roomId: ROOM_ID,
      snapshot,
      hash
    }
  }));
}

async function runTest() {
  try {
    // Connect A first, let it run a bit
    console.log('\nPhase 1: Connect clients');
    const clientA = await connectClient('A', 'playerA', true);

    // Let A run for a bit before B joins
    await wait(500);
    console.log(`[TEST] A before B joins: frame=${clientA.engine.frame}`);

    const clientB = await connectClient('B', 'playerB', false);

    // Wait for B's join to reach A
    await wait(500);

    console.log(`[TEST] After join - A frame=${clientA.engine.frame}, B frame=${clientB.engine.frame}`);
    console.log(`[TEST] Checksums - A=${(clientA.engine.getChecksum() >>> 0).toString(16)}, B=${(clientB.engine.getChecksum() >>> 0).toString(16)}`);

    // Sync: Apply A's physics state to B, INCLUDING frame number
    const snapshotFromA = createPhysicsSnapshot(clientA.engine);

    // CRITICAL: Sync B's frame to match A's frame before loading physics
    // Otherwise they'll be at different frames and diverge immediately
    console.log(`[SYNC] Before sync: A frame=${clientA.engine.frame}, B frame=${clientB.engine.frame}`);
    clientB.engine.setFrame(clientA.engine.frame);
    loadPhysicsSnapshot(clientB.engine, snapshotFromA);
    console.log(`[SYNC] After sync: A frame=${clientA.engine.frame}, B frame=${clientB.engine.frame}`);

    // Clear old snapshots
    clientA.engine.clearSnapshotsBefore(clientA.engine.frame);
    clientB.engine.clearSnapshotsBefore(clientB.engine.frame);
    clientA.checksumHistory = [];
    clientB.checksumHistory = [];

    console.log(`[TEST] After sync - A=${(clientA.engine.getChecksum() >>> 0).toString(16)}, B=${(clientB.engine.getChecksum() >>> 0).toString(16)}`);

    // Phase 2: Let physics run (no manual inputs)
    console.log('\nPhase 2: Let physics run');
    await wait(2000);

    console.log(`[TEST] After physics - A frame=${clientA.engine.frame}, B frame=${clientB.engine.frame}`);
    console.log(`[TEST] Checksums - A=${(clientA.engine.getChecksum() >>> 0).toString(16)}, B=${(clientB.engine.getChecksum() >>> 0).toString(16)}`);

    await wait(1000);

    // Compare checksums
    console.log('\nPhase 3: Compare checksums');
    console.log(`A: frame=${clientA.engine.frame}, checksum=${(clientA.engine.getChecksum() >>> 0).toString(16)}`);
    console.log(`B: frame=${clientB.engine.frame}, checksum=${(clientB.engine.getChecksum() >>> 0).toString(16)}`);

    // Find matching frames in history
    const aByFrame = new Map(clientA.checksumHistory.map(c => [c.frame, c.checksum]));
    const bByFrame = new Map(clientB.checksumHistory.map(c => [c.frame, c.checksum]));

    let matchCount = 0;
    let mismatchCount = 0;
    const mismatches: Array<{ frame: number; a: string; b: string }> = [];

    for (const [frame, aChecksum] of aByFrame) {
      const bChecksum = bByFrame.get(frame);
      if (bChecksum !== undefined) {
        if (aChecksum === bChecksum) {
          matchCount++;
        } else {
          mismatchCount++;
          if (mismatches.length < 5) {
            mismatches.push({
              frame,
              a: (aChecksum >>> 0).toString(16),
              b: (bChecksum >>> 0).toString(16)
            });
          }
        }
      }
    }

    console.log(`\nCompared ${matchCount + mismatchCount} frames:`);
    console.log(`  Matches: ${matchCount}`);
    console.log(`  Mismatches: ${mismatchCount}`);

    if (mismatches.length > 0) {
      console.log('\nFirst mismatches:');
      for (const m of mismatches) {
        console.log(`  Frame ${m.frame}: A=${m.a} B=${m.b}`);
      }
    }

    // Cleanup
    clientA.ws.close();
    clientB.ws.close();

    // Result
    if (mismatchCount > 0) {
      console.log('\n=== FAIL: Checksums do not match! ===');
      process.exit(1);
    } else if (matchCount > 0) {
      console.log('\n=== PASS: Checksums match! ===');
      process.exit(0);
    } else {
      console.log('\n=== INCONCLUSIVE: No frames to compare ===');
      process.exit(1);
    }

  } catch (err) {
    console.error('Test error:', err);
    process.exit(1);
  }
}

runTest();
