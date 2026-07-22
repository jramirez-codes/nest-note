/**
 * "Your laptop is the backend", as an actual graph.
 *
 * This replaced a vertical stack of divs joined by ↓ characters, which sold the
 * architecture short: the shape of this system is the point. One hop leaves the
 * phone, everything downstream of it is on hardware the reader owns, and the
 * three capability flags each gate exactly one branch. A node graph shows all
 * of that at once; a list shows none of it.
 *
 * The canvas is deliberately inert — no panning, no zooming, no dragging. It is
 * a diagram that happens to be laid out by React Flow, not a toy. Most
 * importantly `preventScrolling={false}`: without it, a wheel event over the
 * diagram gets swallowed and the page stops scrolling, which on a landing page
 * is a dead end that people leave rather than debug.
 */
import {
  Background,
  BackgroundVariant,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AppWindow,
  Bot,
  Laptop,
  Smartphone,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react';
import { usePalette } from '../lib/palette';
import '@xyflow/react/dist/style.css';
import '../styles/graph-node.css';
import '../styles/trust-graph.css';

type DeviceData = {
  kicker: string;
  icon: LucideIcon;
  title: string;
  detail?: string;
  tone?: 'accent' | 'warn' | 'plain';
  /** Which sides expose handles, in the current layout. */
  source?: Position;
  target?: Position;
};

function DeviceNode({ data }: NodeProps<Node<DeviceData>>) {
  const Icon = data.icon;
  return (
    <div className={`gn-node gn-${data.tone ?? 'plain'}`}>
      {data.target && <Handle type="target" position={data.target} />}
      <span className="gn-kicker"><Icon size={12} aria-hidden="true" />{data.kicker}</span>
      <strong>{data.title}</strong>
      {data.detail && <span className="gn-detail">{data.detail}</span>}
      {data.source && <Handle type="source" position={data.source} />}
    </div>
  );
}

const nodeTypes = { device: DeviceNode };

/** Wide: phone on the left, laptop in the middle, its three powers fanned right. */
const WIDE: Node<DeviceData>[] = [
  {
    id: 'phone',
    type: 'device',
    position: { x: 0, y: 150 },
    data: {
      kicker: 'Android / iOS',
      icon: Smartphone,
      title: 'Your phone',
      detail: 'notes in one sqlite file',
      tone: 'accent',
      source: Position.Right,
    },
  },
  {
    id: 'server',
    type: 'device',
    position: { x: 400, y: 150 },
    data: {
      kicker: 'Go, ~1 binary',
      icon: Laptop,
      title: 'Your laptop',
      detail: 'the companion server',
      tone: 'accent',
      target: Position.Left,
      source: Position.Right,
    },
  },
  {
    id: 'claude',
    type: 'device',
    position: { x: 800, y: 30 },
    data: {
      kicker: '-allow-code',
      icon: Bot,
      title: 'Claude Code CLI',
      detail: 'your credentials',
      tone: 'warn',
      target: Position.Left,
    },
  },
  {
    id: 'shell',
    type: 'device',
    position: { x: 800, y: 150 },
    data: {
      kicker: '-allow-exec',
      icon: SquareTerminal,
      title: 'Your projects',
      detail: 'shell, as your user',
      tone: 'warn',
      target: Position.Left,
    },
  },
  {
    id: 'view',
    type: 'device',
    position: { x: 800, y: 270 },
    data: {
      kicker: '-allow-view',
      icon: AppWindow,
      title: 'localhost:3000',
      detail: 'mirrored into a card',
      tone: 'warn',
      target: Position.Left,
    },
  },
];

/** Narrow: the same graph, stacked, so it never squeezes below legibility. */
const NARROW: Node<DeviceData>[] = [
  { ...WIDE[0], position: { x: 0, y: 0 }, data: { ...WIDE[0].data, source: Position.Bottom } },
  {
    ...WIDE[1],
    position: { x: 0, y: 150 },
    data: { ...WIDE[1].data, target: Position.Top, source: Position.Bottom },
  },
  // The three flag-gated branches indent *right* of the trunk, so the column
  // reads as a hierarchy hanging off the laptop. Indenting them left (the first
  // attempt) put the trunk off to one side and read as two unrelated columns.
  { ...WIDE[2], position: { x: 56, y: 320 }, data: { ...WIDE[2].data, target: Position.Top } },
  { ...WIDE[3], position: { x: 56, y: 440 }, data: { ...WIDE[3].data, target: Position.Top } },
  { ...WIDE[4], position: { x: 56, y: 560 }, data: { ...WIDE[4].data, target: Position.Top } },
];

const EDGES: Edge[] = [
  {
    id: 'phone-server',
    source: 'phone',
    target: 'server',
    label: 'pinned TLS + token',
    animated: true,
    className: 'gn-edge gn-edge-trunk',
  },
  { id: 'server-claude', source: 'server', target: 'claude', label: '/ask  /code', className: 'gn-edge' },
  { id: 'server-shell', source: 'server', target: 'shell', label: '/run', className: 'gn-edge' },
  { id: 'server-view', source: 'server', target: 'view', label: '/view', className: 'gn-edge' },
];

export default function TrustGraph() {
  const palette = usePalette();
  const host = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);

  // Breakpoint comes from the element, not the viewport: this island sits in a
  // two-column split that collapses independently of window width.
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) =>
      setNarrow(entry.contentRect.width < 560),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const nodes = narrow ? NARROW : WIDE;

  // React Flow's own chrome is themed through its documented CSS variables, so
  // the diagram tracks the docs light/dark toggle like everything else.
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
    <div className="tg-host" ref={host} style={style}>
      <ReactFlow
        key={narrow ? 'narrow' : 'wide'}
        nodes={nodes}
        edges={EDGES}
        nodeTypes={nodeTypes}
        // Our CSS covers the parts of the diagram that carry meaning, but React
        // Flow also has internal defaults (selection box, controls, minimap)
        // keyed off this. Leaving it at 'light' makes those fight a dark page.
        colorMode={palette.dark ? 'dark' : 'light'}
        fitView
        fitViewOptions={{ padding: 0.12 }}
        proOptions={{ hideAttribution: true }}
        // Inert on purpose — see the file header.
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        panOnScroll={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        aria-label="Phone connects over a pinned-TLS tunnel to a Go server on your laptop, which reaches Claude Code, your projects, and local dev servers."
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
      </ReactFlow>
    </div>
  );
}
