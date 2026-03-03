# LizMeter Roadmap

## Planned Features

### 🏙️ Town / Avatar Room
A personal cyber-office canvas scene where your avatar lives while you work.

**Concept**
- Top-down animated room rendered on an HTML canvas
- Avatar walks around when idle, sits at desk when a timer is running
- Room reflects your current work state (fireflies when idle, scan lines + terminal glow when working)
- Customisable avatar name and colour tint

**What was explored**
- Canvas rendering loop at 12 FPS with wall-clock drift correction
- `TileSheet` loader for grid-based sprite sheets (`tileLoader.ts`)
- Player spritesheet with idle / run animations
- Cyber-office wall tileset (`cyber-office-walls.png`) — 256 px tiles, 5 × 3 grid
- Tile catalogue documented in `cyber-walls.ts` with named constants per tile
- Pure canvas room drawing (dark floor grid, neon LED strips, glass panel accent, corner markers)

**Blocked on**
- A proper seamless top-down tileset (the AI-generated set was wall props, not grid-connectable tiles)
- Floor tile artwork to fill the interior
- More avatar animation frames (attack, sit, emote)

**Files to restore** (deleted in clean-up, recreate from scratch or restore from git history)
- `src/renderer/src/components/TownPage.tsx`
- `src/renderer/src/components/TownPage.module.scss`
- `src/renderer/src/utils/tileLoader.ts`
- `src/renderer/src/assets/town/` — tileset PNGs + `tiles.ts` / `cyber-walls.ts`
