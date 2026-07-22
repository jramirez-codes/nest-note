/**
 * 02 · Organize: the subject lifecycle, played as a live node graph.
 *
 * The old section told this story as four static cards beside a file tree;
 * this island *runs* it on loop instead. A rail of the four lifecycle steps
 * sits beside a React Flow canvas, and the active step drives what the canvas
 * shows: an /ingest packet rides into the subject, mention dots fill toward
 * the threshold, the proposal card materializes, the MCP server compiles in —
 * then the cycle resets. Nodes that haven't happened yet stay on the canvas
 * as dashed ghosts, so the whole arc is legible at any frame.
 *
 * Same interaction contract as every graph on this site: no pan, no zoom, no
 * drag, and `preventScrolling={false}` so the canvas never traps the page
 * scroll. The rail is a real tablist — click or arrow to jump the loop to a
 * step. With reduced motion nothing auto-advances: the graph rests on the
 * completed state, packets and the progress bar disappear, and the rail is
 * the only way to move.
 */
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Check, Lightbulb, NotebookPen, Server, type LucideIcon } from 'lucide-react';
import { usePalette, usePrefersReducedMotion } from '../lib/palette';
import '@xyflow/react/dist/style.css';
import '../styles/graph-node.css';
import '../styles/lifecycle-flow.css';

const STEPS = [
  {
    title: 'You mention it',
    body: 'Brain-dump a page and /ingest it, or /talk to a name. A subject is born as nothing but a label.',
  },
  {
    title: 'It keeps notes',
    body: 'Each subject owns a notebook of markdown pages. Knowledge accumulates across sessions instead of dying in one chat.',
  },
  {
    title: 'It crosses the threshold',
    body: 'After enough mentions — default 4 — the orchestrator proposes giving the subject a server of its own.',
  },
  {
    title: 'It compiles',
    body: 'Approved subjects are scaffolded, compiled and registered as real MCP servers. Claude queries your notes as a tool.',
  },
];

/** How long each step holds before the loop advances. */
const DUR = [3600, 4400, 4000, 4800];

/** Subject counters per step — the notebook filling toward the threshold. */
const MENTIONS = [1, 3, 4, 4];
const PAGES = [1, 5, 6, 6];

type HandleSpec = { type: 'source' | 'target'; position: Position };
type LfKind = 'pad' | 'subject' | 'proposal' | 'mcp';
type LfData = { kind: LfKind; stage: number; handles: HandleSpec[] };

/** The step each node joins the story; before that it renders as a ghost. */
const APPEARS: Record<LfKind, number> = { pad: 0, subject: 0, proposal: 2, mcp: 3 };

/** Kicker glyph per node kind — same visual grammar as the hero SystemGraph. */
const ICONS: Record<LfKind, LucideIcon> = {
  pad: NotebookPen,
  subject: BookOpen,
  proposal: Lightbulb,
  mcp: Server,
};

function LfNode({ data }: NodeProps<Node<LfData>>) {
  const { kind, stage, handles } = data;
  const Icon = ICONS[kind];
  const ghost = stage < APPEARS[kind];
  // Pulse once on the frame a node stops being a ghost.
  const fresh = APPEARS[kind] > 0 && stage === APPEARS[kind];
  const accent = kind === 'subject' || (kind === 'mcp' && !ghost);
  const cls = [
    'gn-node',
    'lf-node',
    accent ? 'gn-accent' : '',
    ghost ? 'lf-ghost' : '',
    fresh ? 'lf-fresh' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cls}>
      {handles.map(h => (
        <Handle key={`${h.type}-${h.position}`} type={h.type} position={h.position} />
      ))}
      {kind === 'pad' && (
        <>
          <span className="gn-kicker"><Icon size={12} aria-hidden="true" />you write</span>
          <strong>The pad</strong>
          <span className="gn-detail lf-mono">/ingest — file this page</span>
        </>
      )}
      {kind === 'subject' && (
        <>
          <span className="gn-kicker"><Icon size={12} aria-hidden="true" />subject</span>
          <strong>storage-migration</strong>
          <span className="lf-dots" aria-hidden="true">
            {[0, 1, 2, 3].map(i => (
              <i key={i} className={i < MENTIONS[stage] ? 'is-on' : ''} />
            ))}
          </span>
          <span className="gn-detail">
            {MENTIONS[stage]}/4 mentions · {PAGES[stage]} {PAGES[stage] === 1 ? 'page' : 'pages'}
          </span>
        </>
      )}
      {kind === 'proposal' && (
        <>
          <span className="gn-kicker"><Icon size={12} aria-hidden="true" />suggestion</span>
          <strong>Give it a server?</strong>
          {stage >= 3 ? (
            <span className="lf-approved"><Check size={12} aria-hidden="true" />approved</span>
          ) : (
            <span className="lf-choices" aria-hidden="true">
              <span>approve</span>
              <span>dismiss</span>
            </span>
          )}
        </>
      )}
      {kind === 'mcp' && (
        <>
          <span className="gn-kicker"><Icon size={12} aria-hidden="true" />mcp server</span>
          <strong>storage-migration</strong>
          <span className="gn-detail lf-mono">search_notes · list_pages</span>
          {!ghost && (
            <span className="lf-live">
              <i aria-hidden="true" />registered
            </span>
          )}
        </>
      )}
    </div>
  );
}

/**
 * An edge that knows where the loop is: ghost (dashed, dim) before its step,
 * carrying a packet during it, settled solid after. The packet is an SMIL
 * animateMotion, so there is no per-frame JS.
 */
function StageEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, label, data }: EdgeProps) {
  const reduced = usePrefersReducedMotion();
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const state = (data?.state as string) ?? 'ghost';
  return (
    <>
      <BaseEdge id={id} path={path} />
      {label && (
        <EdgeLabelRenderer>
          <div
            className={`lf-edge-label is-${state}`}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
      {state === 'active' && !reduced && (
        <circle className="lf-packet" r="3.5">
          <animateMotion dur="2.1s" repeatCount="indefinite" path={path} />
        </circle>
      )}
    </>
  );
}

const nodeTypes = { lf: LfNode };
const edgeTypes = { stage: StageEdge };

const node = (id: LfKind, x: number, y: number, handles: HandleSpec[]): Node<LfData> => ({
  id,
  type: 'lf',
  position: { x, y },
  data: { kind: id, stage: 0, handles },
});

/** Wide: the growth trunk runs down the left, the proposal branches right and
 *  feeds back into the compiled server — a small loop, read clockwise. */
const WIDE: Node<LfData>[] = [
  node('pad', 20, 0, [{ type: 'source', position: Position.Bottom }]),
  node('subject', 20, 150, [
    { type: 'target', position: Position.Top },
    { type: 'source', position: Position.Right },
  ]),
  node('proposal', 310, 140, [
    { type: 'target', position: Position.Left },
    { type: 'source', position: Position.Bottom },
  ]),
  node('mcp', 130, 350, [{ type: 'target', position: Position.Top }]),
];

/** Narrow: one column; the proposal indents right so it reads as a branch. */
const NARROW: Node<LfData>[] = [
  node('pad', 0, 0, [{ type: 'source', position: Position.Bottom }]),
  node('subject', 0, 140, [
    { type: 'target', position: Position.Top },
    { type: 'source', position: Position.Bottom },
  ]),
  node('proposal', 48, 330, [
    { type: 'target', position: Position.Top },
    { type: 'source', position: Position.Bottom },
  ]),
  node('mcp', 0, 480, [{ type: 'target', position: Position.Top }]),
];

/** `at` = the step this edge lights up; `through` = the last step it carries a
 *  packet. Past that it settles solid until the loop resets. */
const EDGE_DEFS = [
  { id: 'pad-subject', source: 'pad', target: 'subject', label: '/ingest', at: 0, through: 1 },
  { id: 'subject-proposal', source: 'subject', target: 'proposal', label: '4th mention', at: 2, through: 2 },
  { id: 'proposal-mcp', source: 'proposal', target: 'mcp', label: 'compile & register', at: 3, through: 3 },
];

export default function LifecycleFlow() {
  const palette = usePalette();
  const reduced = usePrefersReducedMotion();
  const host = useRef<HTMLDivElement>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const [narrow, setNarrow] = useState(false);
  const [stage, setStage] = useState(0);

  // Breakpoint from the element, not the viewport — the canvas lives in a
  // split whose collapse point the page grid decides.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < 460));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Reduced motion: rest on the completed picture instead of looping.
  useEffect(() => {
    if (reduced) setStage(3);
  }, [reduced]);

  // The loop. Clicking a rail step lands here too — stage changed, timer resets.
  useEffect(() => {
    if (reduced) return;
    const t = setTimeout(() => setStage(s => (s + 1) % STEPS.length), DUR[stage]);
    return () => clearTimeout(t);
  }, [stage, reduced]);

  const nodes = useMemo(
    () => (narrow ? NARROW : WIDE).map(n => ({ ...n, data: { ...n.data, stage } })),
    [narrow, stage],
  );

  const edges = useMemo<Edge[]>(
    () =>
      EDGE_DEFS.map(e => {
        const state = stage < e.at ? 'ghost' : stage <= e.through ? 'active' : 'done';
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          label: e.label,
          type: 'stage',
          className: `gn-edge lf-edge is-${state}`,
          data: { state },
        };
      }),
    [stage],
  );

  const move = (from: number, delta: number) => {
    const next = (from + delta + STEPS.length) % STEPS.length;
    setStage(next);
    tabs.current[next]?.focus();
  };

  const style = useMemo(
    () =>
      ({
        '--xy-edge-stroke': palette.surface2,
        '--xy-edge-stroke-selected': palette.mauve,
        '--xy-background-pattern-color': palette.surface0,
      }) as React.CSSProperties,
    [palette],
  );

  return (
    <div className="lf">
      <div className="lf-rail" role="tablist" aria-label="Subject lifecycle" aria-orientation="vertical">
        {STEPS.map((s, i) => (
          <button
            key={s.title}
            ref={el => {
              tabs.current[i] = el;
            }}
            role="tab"
            id={`lf-tab-${i}`}
            aria-selected={i === stage}
            aria-controls="lf-panel"
            tabIndex={i === stage ? 0 : -1}
            className={`lf-step${i === stage ? ' is-active' : ''}${i < stage ? ' is-done' : ''}`}
            onClick={() => setStage(i)}
            onKeyDown={e => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowRight') move(i, 1);
              if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') move(i, -1);
            }}
          >
            <span className="lf-num">{String(i + 1).padStart(2, '0')}</span>
            <span className="lf-step-copy">
              <strong>{s.title}</strong>
              <span>{s.body}</span>
            </span>
            {i === stage && !reduced && (
              <i className="lf-progress" style={{ animationDuration: `${DUR[i]}ms` }} aria-hidden="true" />
            )}
          </button>
        ))}
      </div>

      <div
        className="lf-canvas"
        ref={host}
        style={style}
        role="tabpanel"
        id="lf-panel"
        aria-labelledby={`lf-tab-${stage}`}
      >
        <ReactFlow
          key={narrow ? 'narrow' : 'wide'}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          colorMode={palette.dark ? 'dark' : 'light'}
          fitView
          fitViewOptions={{ padding: 0.12 }}
          proOptions={{ hideAttribution: true }}
          // Inert on purpose — the rail is the control surface, not the canvas.
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnDrag={false}
          panOnScroll={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          preventScrolling={false}
          aria-label="The subject lifecycle: ingested pages flow into a subject, mentions accumulate to a threshold, the orchestrator proposes a server, and on approval the subject compiles into a registered MCP server."
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
        </ReactFlow>
      </div>
    </div>
  );
}
