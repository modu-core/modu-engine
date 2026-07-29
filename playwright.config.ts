import { defineConfig } from '@playwright/test';

/**
 * E2E configuration.
 *
 * The specs drive two real browsers against a served example (cell-eater) and
 * compare each client's world state hash, so they need three things running:
 *
 *   1. The browser bundle, at dist/  ..............  npm run build:browser
 *   2. A static server at :3001 rooted at the repo, so that /examples/* and the
 *      /dist/* bundle those pages load both resolve ...  started for you below
 *   3. A modu-network cluster (central + at least one node) that the pages
 *      connect to ....................................  see e2e/README.md
 *
 * Only (1) and (2) are automated here; the cluster lives in the sibling
 * modu-network repo and is started separately.
 *
 * Runs headless by default so this is usable in CI. Set HEADED=1 to watch.
 */
export default defineConfig({
    testDir: './e2e',
    timeout: 60000,
    // These specs drive a real shared cluster, so running files in parallel
    // makes them interfere with each other.
    workers: 1,
    fullyParallel: false,
    reporter: 'list',
    use: {
        headless: !process.env.HEADED,
        viewport: { width: 1280, height: 720 },
        baseURL: 'http://localhost:3001',
    },
    webServer: {
        // Served from the repo root: examples/*.html reference ../dist/modu.iife.js,
        // so both paths have to be reachable from a single root.
        command: 'npx http-server . -p 3001 --silent',
        url: 'http://localhost:3001/examples/cell-eater',
        reuseExistingServer: true,
        timeout: 30000,
    },
});
