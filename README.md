# Modu Engine

**Local-first Multiplayer Game Engine.** Your game runs instantly on the client. When you go online, it just syncs.

## Why Modu?

- **Instant Play** — No "connecting..." screens. Game runs locally immediately, multiplayer syncs in the background.
- **One Codebase** — Same code works for 1 player or 100. No separate single/multiplayer modes.
- **Zero Sync Code** — Deterministic simulation means all clients agree automatically. No netcode to write.
- **No Server Logic** — Server just relays inputs. Your game code runs on clients only.

## Quick Start

```html
<canvas id="game" width="800" height="600"></canvas>
<script src="https://cdn.moduengine.com/modu.min.js"></script>
<script>
const game = createGame();
game.addPlugin(Simple2DRenderer, document.getElementById('game'));

game.defineEntity('player')
    .with(Transform2D)
    .with(Sprite, { shape: SHAPE_CIRCLE, radius: 20 })
    .with(Player)
    .register();

const input = game.addPlugin(InputPlugin, canvas);
input.action('move', { type: 'vector', bindings: ['wasd'] });

game.addSystem(() => {
    for (const p of game.query('player')) {
        const dir = game.world.getInput(p.get(Player).clientId)?.move;
        if (dir) p.setVelocity(dir.x * 5, dir.y * 5);
    }
});

game.connect('my-room', {
    onConnect(id) {
        game.spawn('player', { x: dRandom() * 800, y: dRandom() * 600, clientId: id });
    }
});
</script>
```

## Game API

The Game class provides three ways to start your game:

### Mode 1: Online-only (default)
```javascript
game.connect(roomId, {
    onRoomCreate() { spawnFood(); },
    onConnect(clientId) { spawnPlayer(clientId); }
});
// Auto-starts locally, then connects to server
```

### Mode 2: Local-first with seamless transition
```javascript
game.init({
    onRoomCreate() { spawnFood(); },
    onConnect(clientId) { spawnPlayer(clientId); }
});
game.start();  // Play locally immediately
// Later, when user clicks "Go Online"...
game.connect(roomId);  // Server state replaces local state
```

### Mode 3: Offline only
```javascript
game.init({ onRoomCreate, onConnect });
game.start();  // Never call connect() - pure single-player
```

## How It Works

1. Player presses a key - input captured locally
2. Input sent to server - server assigns sequence number
3. Broadcast to all clients - everyone gets same inputs in same order
4. Same simulation runs - identical state everywhere

The server never runs game logic. It's just a message broker. Determinism ensures all clients agree.

## Examples

Run the demos:

```bash
npm run build:browser
npx http-server -p 3000
```

- [cell-eater.html](examples/cell-eater.html) — Eat to grow
- [snake.html](examples/snake.html) — Classic snake
- [2d-shooter.html](examples/2d-shooter.html) — Top-down shooter

## Testing

```bash
npm test          # unit tests (vitest)
```

Unit tests run in-process and need nothing else. They cover fixed-point math,
hashing, state deltas, partitioning, and multi-client convergence in both 2D
and 3D — that several independent simulations fed the same ordered inputs reach
identical state hashes.

```bash
npm run test:e2e            # browser tests (playwright), headless
HEADED=1 npm run test:e2e   # same, with visible browsers
```

The e2e specs drive two real browsers against a served example and compare each
client's world state hash, so they need more setup:

- The browser bundle and a static server on `:3001` are handled for you
  (`pretest:e2e` builds the bundle; the Playwright config starts the server).
- A **modu-network cluster must be running separately** — a central service and
  at least one node from the sibling `modu-network` repo. See that repo's
  Testing section; no database is required.
- First run only: `npx playwright install chromium`.

> **Note:** these specs are bug reproductions for desync and refresh/resync
> scenarios, and several currently fail. They are kept because they encode real
> scenarios worth fixing, not because they are expected to be green.

## Documentation

**[docs.moduengine.com](https://docs.moduengine.com)**

## License

MIT
