import React, { useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { X } from 'lucide-react-native';
import { useTheme } from '../../theme/colors';
import type { IdeaChatTurn } from '../../server/ideaChat';
import ConfirmDialog from '../modals/ConfirmDialog';
import ChatMarkdown from './ChatMarkdown';

interface IdeaChatCardProps {
  /** The conversation so far; the last turn may still be streaming. */
  turns: IdeaChatTurn[];
  /** Throw the conversation away. Confirmed here before it's called. */
  onDelete: () => void;
}

/** The card's height before anyone drags it — enough for a question and a short
 *  answer, with the idea itself still readable underneath. */
export const DEFAULT_CARD_HEIGHT = 190;
/** Floor for a dragged card: a line of text under the delete button. */
export const MIN_CARD_HEIGHT = 56;

/**
 * The reply card in an idea page's header, under the tags: what Claude has said
 * back about this idea — usually a question it needs the user to answer before it
 * can go further, or a one-line note of what it just changed on the card.
 *
 * It shows the whole conversation rather than only the newest reply (scrolled to
 * the bottom), because a question only makes sense next to what was asked. How
 * much of it is on screen is the user's call: the card is capped by its parent,
 * which the page's header edge drags taller or shorter. The idea's body isn't
 * here — it's the page underneath, which updates in place as Claude edits the card.
 *
 * The card can also be thrown away, which is what the X in its corner does — the
 * transcript is the context every later turn is threaded with, so dropping it
 * starts the conversation over. Deliberate enough to be worth confirming.
 */
export default function IdeaChatCard({ turns, onDelete }: IdeaChatCardProps) {
  const colors = useTheme();
  const scroll = useRef<ScrollView>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (turns.length === 0) return null;

  return (
    // The parent caps the card's height — that cap is what the header edge drags
    // — so the card gives way to it (`shrink`, `max-h-full`) instead of
    // overflowing: a long thread scrolls inside rather than pushing the idea off
    // the page, and a short one still only takes the room it needs.
    <View className="max-h-full shrink rounded-xl border border-surface1 bg-surface/40 px-3 py-2">
      <ScrollView
        ref={scroll}
        // Keep the newest text in view as it streams in.
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
        showsVerticalScrollIndicator={false}>
        {turns.map((t, i) => (
          <View key={i} className={i > 0 ? 'mt-3' : undefined}>
            {/* What the user asked, kept small — the reply is the point. The
                first line clears the delete button parked in the corner. */}
            <Text className={`text-[12px] italic text-faint ${i === 0 ? 'pr-7' : ''}`}>{t.q}</Text>
            {t.a ? (
              // The reply is Markdown, drawn with the editor's widgets so a list,
              // a task or a code block reads the same here as it does in a card.
              <View className="mt-1">
                <ChatMarkdown text={t.a.trim()} />
              </View>
            ) : t.status === 'streaming' ? (
              <Text className="mt-1 text-[14px] text-muted">Thinking…</Text>
            ) : null}
            {t.status === 'error' && (
              <Text className="mt-1 text-[12px] text-red">{t.msg || 'Something went wrong.'}</Text>
            )}
          </View>
        ))}
      </ScrollView>

      {/* Parked over the card's top-right corner, the way the editor's cards carry
          their own action button. Opaque, so text scrolling past runs under it. */}
      <Pressable
        onPress={() => setConfirmDelete(true)}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Delete Claude's replies"
        className="absolute right-1.5 top-1.5 h-[22px] w-[22px] items-center justify-center rounded-lg border border-surface1 bg-surface active:opacity-70">
        <X size={13} color={colors.faint} strokeWidth={2.5} />
      </Pressable>

      <ConfirmDialog
        visible={confirmDelete}
        title="Delete replies"
        message="Throw away this conversation? Claude loses the thread and starts fresh on the next question. The idea itself isn't changed."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        destructive
        onConfirm={() => {
          setConfirmDelete(false);
          onDelete();
        }}
        onCancel={() => setConfirmDelete(false)}
      />
    </View>
  );
}
