import { useTranslation } from 'react-i18next';

// The Ghost Feed's empty state deserves a face. This is a voxel ghost drawn as real
// pixels: one <rect> per cell on a 9x10 grid, a 1px gutter so the blocks read as blocks,
// three tonal bands so the body has top-light, and an offset dark copy behind it for the
// extruded side/bottom faces. Zero dependencies, zero images, zero network.
//
// The drift animation is a plain CSS keyframe, so the global
// `prefers-reduced-motion: reduce` rule in global.css already flattens it; both keyframe
// ends sit at translateY(0), so a reduced-motion viewer sees a perfectly still ghost.

/** '#' = body, 'o' = eye, '.' = empty. Nine columns wide, ten rows tall. */
const PIXELS = [
  '..#####..',
  '.#######.',
  '#########',
  '#########',
  '#oo###oo#',
  '#oo###oo#',
  '#########',
  '#########',
  '#########',
  '##.###.##',
] as const;

const CELL = 11;      // grid pitch
const BLOCK = 10;     // painted size, leaving a 1px gutter — the pixel-art seam
const OX = 6;         // grid origin
const OY = 8;
const DEPTH = 5;      // voxel extrusion offset

/** Top-light shading: the higher the row, the lighter the face. */
function bandFor(row: number): string {
  if (row <= 2) return 'var(--gm-top)';
  if (row <= 6) return 'var(--gm-mid)';
  return 'var(--gm-low)';
}

interface Cell { x: number; y: number; row: number; eye: boolean }

const CELLS: Cell[] = PIXELS.flatMap((line, row) =>
  [...line].flatMap((ch, col) =>
    ch === '.' ? [] : [{ x: OX + col * CELL, y: OY + row * CELL, row, eye: ch === 'o' }]),
);

export function GhostMascot({ size = 132 }: { size?: number }) {
  const { t } = useTranslation();
  return (
    <svg
      className="ghost-mascot"
      width={size}
      height={size * (152 / 118)}
      viewBox="0 0 118 152"
      role="img"
      aria-label={t('ghost.mascotAlt')}
    >
      {/* contact shadow — the ghost floats above it */}
      <ellipse className="gm-shadow" cx="61" cy="140" rx="34" ry="7" />
      <g className="gm-body">
        {/* extruded side + bottom faces */}
        <g transform={`translate(${DEPTH} ${DEPTH})`}>
          {CELLS.filter((c) => !c.eye).map((c) => (
            <rect key={`d-${c.x}-${c.y}`} x={c.x} y={c.y} width={BLOCK} height={BLOCK} fill="var(--gm-deep)" />
          ))}
        </g>
        {/* front faces */}
        {CELLS.map((c) => (
          <rect
            key={`f-${c.x}-${c.y}`}
            x={c.x} y={c.y} width={BLOCK} height={BLOCK}
            fill={c.eye ? 'var(--gm-eye)' : bandFor(c.row)}
          />
        ))}
      </g>
    </svg>
  );
}
