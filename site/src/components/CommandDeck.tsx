/**
 * Slash commands as a node inspector: a rail of command names on the left,
 * and the selected command's "properties panel" on the right — what it does,
 * what it needs, and what typing it actually looks like on the pad.
 *
 * This replaced a static table. A table shows five rows at equal weight; the
 * inspector matches the page's node-editor conceit (select a node, read its
 * panel) and gives each command room for a realistic example. Tabs semantics,
 * arrow-key navigation included, so it reads to a screen reader as exactly
 * what it is.
 */
import { useRef, useState } from 'react';
import {
  Bot,
  Inbox,
  ListChecks,
  MessageCircleQuestionMark,
  MessagesSquare,
  type LucideIcon,
} from 'lucide-react';
import '../styles/command-deck.css';

type Command = {
  cmd: string;
  icon: LucideIcon;
  what: string;
  needs: string[];
  example: string;
  result: string;
};

const COMMANDS: Command[] = [
  {
    cmd: '/ask',
    icon: MessageCircleQuestionMark,
    what: 'Ask Claude a question from any page. The answer streams into a card, in place, and keeps streaming if you swipe away.',
    needs: ['paired server'],
    example: '/ask what does bm25 weight mean here',
    result: 'It ranks a row by how rare its matched terms are across the corpus, damped by length…',
  },
  {
    cmd: '/talk',
    icon: MessagesSquare,
    what: 'Open a conversation scoped to one subject. The subject’s notebook stays updated as you talk — knowledge lands in notes, not in a chat log.',
    needs: ['paired server', '-root'],
    example: '/talk storage-migration',
    result: 'storage-migration · 6 pages · notebook updating as you go',
  },
  {
    cmd: '/ingest',
    icon: Inbox,
    what: 'File the current page into your subjects and clear the sheet. This is the edge that feeds the orchestrator.',
    needs: ['paired server'],
    example: '/ingest',
    result: 'filed → storage-migration (+1 page) · pad cleared',
  },
  {
    cmd: '/agg-tasks',
    icon: ListChecks,
    what: 'Sweep a subject’s notebook and file one task card per action item found, so nothing you scribbled stays buried.',
    needs: ['paired server', '-root'],
    example: '/agg-tasks storage-migration',
    result: '3 tasks filed → dashboard',
  },
  {
    cmd: '/code',
    icon: Bot,
    what: 'Start a Claude Code agent in a project directory on the paired laptop and watch it work from your phone.',
    needs: ['-allow-code'],
    example: '/code fix the flaky pairing test',
    result: 'agent running in ~/ainotepad-data/projects/app …',
  },
];

export default function CommandDeck() {
  const [active, setActive] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  const move = (from: number, delta: number) => {
    const next = (from + delta + COMMANDS.length) % COMMANDS.length;
    setActive(next);
    tabs.current[next]?.focus();
  };

  const current = COMMANDS[active];
  const CurrentIcon = current.icon;

  return (
    <div className="cd">
      <div className="cd-rail" role="tablist" aria-label="Slash commands" aria-orientation="vertical">
        {COMMANDS.map((c, i) => (
          <button
            key={c.cmd}
            ref={el => {
              tabs.current[i] = el;
            }}
            role="tab"
            id={`cd-tab-${i}`}
            aria-selected={i === active}
            aria-controls="cd-panel"
            tabIndex={i === active ? 0 : -1}
            className={`cd-tab${i === active ? ' is-active' : ''}`}
            onClick={() => setActive(i)}
            onKeyDown={e => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowRight') move(i, 1);
              if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') move(i, -1);
            }}
          >
            <span className="cd-port" aria-hidden="true" />
            {c.cmd}
          </button>
        ))}
      </div>

      <div className="cd-panel" role="tabpanel" id="cd-panel" aria-labelledby={`cd-tab-${active}`}>
        <div className="cd-head">
          <span className="cd-title">
            <span className="cd-glyph" aria-hidden="true"><CurrentIcon size={15} /></span>
            <code className="cd-cmd">{current.cmd}</code>
          </span>
          <span className="cd-needs">
            {current.needs.map(n => (
              <span key={n} className="cd-need">{n}</span>
            ))}
          </span>
        </div>
        <p className="cd-what">{current.what}</p>
        <div className="cd-demo" aria-label="Example">
          <p className="cd-typed">{current.example}</p>
          <div className="cd-card">
            <span className="cd-dot" aria-hidden="true" />
            <span>{current.result}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
