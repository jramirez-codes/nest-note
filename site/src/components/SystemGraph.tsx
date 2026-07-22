/**
 * Hero visual: the whole system as one live node graph.
 *
 * The landing page's conceit is that the page itself is a node-editor canvas,
 * and this is the master graph the rest of the page zooms into: the pad feeds
 * the orchestrator, the orchestrator files into subjects and surfaces cards on
 * the dashboard, and subjects that earn it compile into MCP servers. Every
 * section below this hero corresponds to one of these nodes.
 *
 * It renders in three layouts, picked from the host element's width: a
 * left-to-right BAND for the full-width strip under the hero demo video, the
 * original two-column WIDE when it only gets a column, and a single-column
 * NARROW on phones. Host height per layout lives in system-graph.css.
 *
 * Unlike the inert TrustGraph, this one is *lightly* playful: nodes can be
 * dragged (they stay where you drop them), and hovering a node warms the edges
 * touching it. Pan and zoom stay off, and `preventScrolling` stays false, so
 * the canvas never traps the page scroll — the one interaction rule every
 * graph on this site shares. On narrow screens dragging is disabled too, so a
 * thumb on a node still scrolls the page.
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
  useNodesState,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Database,
  Laptop,
  LayoutDashboard,
  Library,
  NotebookPen,
  Server,
  WifiOff,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { usePalette, usePrefersReducedMotion } from '../lib/palette';
import '@xyflow/react/dist/style.css';
import '../styles/graph-node.css';
import '../styles/system-graph.css';

type HandleSpec = { type: 'source' | 'target'; position: Position; id?: string };

type SysData = {
  kicker: string;
  icon: LucideIcon;
  title: string;
  detail?: string;
  tone?: 'accent' | 'plain';
  typing?: boolean;
  handles: HandleSpec[];
};

type ChipData = { label: string; icon: LucideIcon };

/** What the pad node is "writing", on loop. Ends on /ingest — the edge the
 *  packet then travels. The sync is thematic, not frame-accurate. */
const PHRASES = ['# thursday', 'ship the storage migration', '- [ ] backfill card_payloads', '/ingest'];

function TypeLine() {
  const reduced = usePrefersReducedMotion();
  const [phrase, setPhrase] = useState(0);
  const [chars, setChars] = useState(0);

  useEffect(() => {
    if (reduced) return;
    if (chars < PHRASES[phrase].length) {
      const t = setTimeout(() => setChars(c => c + 1), 60);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => {
      setPhrase(p => (p + 1) % PHRASES.length);
      setChars(0);
    }, 1500);
    return () => clearTimeout(t);
  }, [chars, phrase, reduced]);

  if (reduced) return <span className="sg-typed">/ingest</span>;
  return (
    <span className="sg-typed" aria-hidden="true">
      {PHRASES[phrase].slice(0, chars)}
      <span className="sg-caret" />
    </span>
  );
}

function SysNode({ data }: NodeProps<Node<SysData>>) {
  const Icon = data.icon;
  return (
    <div className={`gn-node gn-${data.tone ?? 'plain'}`}>
      {data.handles.map(h => (
        <Handle key={`${h.type}-${h.id ?? h.position}`} type={h.type} position={h.position} id={h.id} />
      ))}
      <span className="gn-kicker"><Icon size={12} aria-hidden="true" />{data.kicker}</span>
      <strong>{data.title}</strong>
      {data.detail && <span className="gn-detail">{data.detail}</span>}
      {data.typing && <TypeLine />}
    </div>
  );
}

/**
 * An edge with a glowing packet riding it on loop. BaseEdge draws the same
 * path the default edge would; the label moves into an EdgeLabelRenderer div
 * (BaseEdge doesn't render labels); the packet is an SMIL animateMotion — no
 * per-frame JS, and it follows the path even mid-drag.
 */
function PacketEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, label, data }: EdgeProps) {
  const reduced = usePrefersReducedMotion();
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  return (
    <>
      <BaseEdge id={id} path={path} />
      {label && (
        <EdgeLabelRenderer>
          <div
            className="sg-edge-label"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
      {!reduced && (
        <circle className="sg-packet" r="3.5">
          <animateMotion
            dur="3.2s"
            begin={(data?.begin as string) ?? '0s'}
            repeatCount="indefinite"
            path={path}
          />
        </circle>
      )}
    </>
  );
}

/** A loose fact pinned to the canvas — a toy to drag, not part of the flow. */
function ChipNode({ data }: NodeProps<Node<ChipData>>) {
  const Icon = data.icon;
  return (
    <div className="gn-chip">
      <Icon size={11} aria-hidden="true" />
      {data.label}
    </div>
  );
}

const nodeTypes = { sys: SysNode, chip: ChipNode };
const edgeTypes = { packet: PacketEdge };

/** Wide: the trunk runs pad → orchestrator, then fans to subjects/dashboard,
 *  and subjects continue down into the MCP server. Mirrors the page order. */
const WIDE: Node<SysData | ChipData>[] = [
  {
    id: 'pad',
    type: 'sys',
    position: { x: 0, y: 0 },
    data: {
      kicker: 'you write',
      icon: NotebookPen,
      title: 'The pad',
      detail: 'markdown pages you swipe through',
      tone: 'accent',
      typing: true,
      handles: [{ type: 'source', position: Position.Bottom }],
    },
  },
  {
    id: 'orchestrator',
    type: 'sys',
    position: { x: 150, y: 150 },
    data: {
      kicker: 'it organizes',
      icon: Workflow,
      title: 'The orchestrator',
      detail: 'files every page into subjects',
      tone: 'accent',
      handles: [
        { type: 'target', position: Position.Top },
        { type: 'source', position: Position.Bottom },
      ],
    },
  },
  {
    id: 'subjects',
    type: 'sys',
    position: { x: 0, y: 310 },
    data: {
      kicker: 'they grow',
      icon: Library,
      title: 'Subjects',
      detail: 'notebooks that accumulate',
      handles: [
        { type: 'target', position: Position.Top },
        { type: 'source', position: Position.Bottom },
      ],
    },
  },
  {
    id: 'dashboard',
    type: 'sys',
    position: { x: 310, y: 310 },
    data: {
      kicker: 'you steer',
      icon: LayoutDashboard,
      title: 'The dashboard',
      detail: 'tasks, proposals, archive',
      handles: [{ type: 'target', position: Position.Top }],
    },
  },
  {
    id: 'mcp',
    type: 'sys',
    position: { x: 150, y: 460 },
    data: {
      kicker: 'claude queries',
      icon: Server,
      title: 'MCP server',
      detail: 'compiled from a subject’s notes',
      tone: 'accent',
      handles: [{ type: 'target', position: Position.Top }],
    },
  },
  { id: 'chip-offline', type: 'chip', position: { x: 330, y: 20 }, data: { label: 'offline-first', icon: WifiOff }, className: 'sg-chip' },
  { id: 'chip-sqlite', type: 'chip', position: { x: -110, y: 180 }, data: { label: 'one sqlite file', icon: Database }, className: 'sg-chip' },
  { id: 'chip-laptop', type: 'chip', position: { x: 400, y: 470 }, data: { label: 'runs on your laptop', icon: Laptop }, className: 'sg-chip' },
];

/** Band: the same story told left to right — the trunk runs pad →
 *  orchestrator → subjects → MCP server, with the dashboard fanned below.
 *  Used when the graph gets the full frame width. */
const BAND: Node<SysData | ChipData>[] = [
  {
    ...(WIDE[0] as Node<SysData>),
    position: { x: 0, y: 75 },
    data: { ...(WIDE[0] as Node<SysData>).data, handles: [{ type: 'source', position: Position.Right }] },
  },
  {
    ...(WIDE[1] as Node<SysData>),
    position: { x: 300, y: 75 },
    data: {
      ...(WIDE[1] as Node<SysData>).data,
      handles: [
        { type: 'target', position: Position.Left },
        { type: 'source', position: Position.Right },
      ],
    },
  },
  {
    ...(WIDE[2] as Node<SysData>),
    position: { x: 620, y: 0 },
    data: {
      ...(WIDE[2] as Node<SysData>).data,
      handles: [
        { type: 'target', position: Position.Left },
        { type: 'source', position: Position.Right },
      ],
    },
  },
  {
    ...(WIDE[3] as Node<SysData>),
    position: { x: 620, y: 160 },
    data: { ...(WIDE[3] as Node<SysData>).data, handles: [{ type: 'target', position: Position.Left }] },
  },
  {
    ...(WIDE[4] as Node<SysData>),
    position: { x: 950, y: 0 },
    data: { ...(WIDE[4] as Node<SysData>).data, handles: [{ type: 'target', position: Position.Left }] },
  },
  { id: 'chip-offline', type: 'chip', position: { x: 55, y: -5 }, data: { label: 'offline-first', icon: WifiOff }, className: 'sg-chip' },
  { id: 'chip-sqlite', type: 'chip', position: { x: 300, y: 200 }, data: { label: 'one sqlite file', icon: Database }, className: 'sg-chip' },
  { id: 'chip-laptop', type: 'chip', position: { x: 960, y: 160 }, data: { label: 'runs on your laptop', icon: Laptop }, className: 'sg-chip' },
];

/** Narrow: a single readable column; the dashboard bows out of the trunk. */
const NARROW: Node<SysData | ChipData>[] = [
  { ...(WIDE[0] as Node<SysData>), position: { x: 0, y: 0 } },
  {
    ...(WIDE[1] as Node<SysData>),
    position: { x: 0, y: 145 },
    data: {
      ...(WIDE[1] as Node<SysData>).data,
      handles: [
        { type: 'target', position: Position.Top },
        { type: 'source', position: Position.Bottom },
        { type: 'source', position: Position.Right, id: 'side' },
      ],
    },
  },
  { ...(WIDE[2] as Node<SysData>), position: { x: 0, y: 290 } },
  {
    ...(WIDE[3] as Node<SysData>),
    position: { x: 96, y: 580 },
    data: { ...(WIDE[3] as Node<SysData>).data, handles: [{ type: 'target', position: Position.Right }] },
  },
  { ...(WIDE[4] as Node<SysData>), position: { x: 0, y: 435 } },
];

const EDGES: Edge[] = [
  { id: 'pad-orch', source: 'pad', target: 'orchestrator', label: '/ingest', type: 'packet', data: { begin: '0s' }, className: 'gn-edge gn-edge-trunk' },
  { id: 'orch-sub', source: 'orchestrator', target: 'subjects', label: 'files pages', className: 'gn-edge' },
  { id: 'orch-dash', source: 'orchestrator', target: 'dashboard', label: 'tasks · proposals', className: 'gn-edge' },
  { id: 'sub-mcp', source: 'subjects', target: 'mcp', label: 'after 4 mentions', type: 'packet', data: { begin: '1.6s' }, className: 'gn-edge gn-edge-trunk' },
];

/** Same story, but the dashboard edge leaves from the trunk's side handle.
 *  Smoothstep, not bezier: a bezier between two Right handles bulges far past
 *  the node bounds fitView measures, and gets clipped at the canvas edge. */
const NARROW_EDGES: Edge[] = EDGES.map(e =>
  e.id === 'orch-dash' ? { ...e, sourceHandle: 'side', label: 'tasks', type: 'smoothstep' } : e,
);

type Layout = 'band' | 'wide' | 'narrow';

const NODESETS: Record<Layout, Node<SysData | ChipData>[]> = { band: BAND, wide: WIDE, narrow: NARROW };

const layoutFor = (width: number): Layout => (width < 460 ? 'narrow' : width < 760 ? 'wide' : 'band');

export default function SystemGraph() {
  const palette = usePalette();
  const host = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<Layout>('band');
  const [hot, setHot] = useState<string | null>(null);

  // Breakpoint from the element, not the viewport — the graph's width is
  // decided by the surrounding grid, not the screen.
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setLayout(layoutFor(entry.contentRect.width)));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const [nodes, setNodes, onNodesChange] = useNodesState(NODESETS.band);

  // useNodesState captures its initial value once; when the layout flips,
  // swap the node set explicitly (this also discards any dragged positions,
  // which is the right reset for a relayout).
  useEffect(() => {
    setNodes(NODESETS[layout]);
  }, [layout, setNodes]);

  // Hovering a node warms every edge touching it.
  const edges = useMemo(() => {
    const base = layout === 'narrow' ? NARROW_EDGES : EDGES;
    if (!hot) return base;
    return base.map(e =>
      e.source === hot || e.target === hot ? { ...e, className: `${e.className} is-hot` } : e,
    );
  }, [layout, hot]);

  const onEnter = useCallback((_: unknown, node: Node) => setHot(node.id), []);
  const onLeave = useCallback(() => setHot(null), []);

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
    <div className="sg-host" ref={host} style={style}>
      <ReactFlow
        key={layout}
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        colorMode={palette.dark ? 'dark' : 'light'}
        fitView
        fitViewOptions={{ padding: 0.1 }}
        proOptions={{ hideAttribution: true }}
        // Lightly playful: drag yes (desktop only), pan/zoom no. A dragged
        // node stays where it lands; nothing else about the canvas moves.
        nodesDraggable={layout !== 'narrow'}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        panOnScroll={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        onNodeMouseEnter={onEnter}
        onNodeMouseLeave={onLeave}
        aria-label="The system: pages from the pad flow into the orchestrator, which files them into subjects and surfaces tasks on the dashboard; subjects that earn it compile into MCP servers."
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
      </ReactFlow>
    </div>
  );
}
