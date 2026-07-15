import React from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft } from 'lucide-react-native';
import { useTheme } from '../../theme/colors';
import type { Note } from '../../types/note';
import type { DashboardCard } from '../../server/controllers/aiController';
import { prio } from '../dashboard/cardModel';
import NotePage from './NotePage';

interface IdeaPageOverlayProps {
  /** The card (an idea) being viewed as a full page. */
  card: DashboardCard;
  /** Exact page width so the editor fills the sheet. */
  width: number;
  /** Close the page and return to the dashboard. */
  onClose: () => void;
}

const noop = () => {};

/**
 * A card (an idea) opened from the dashboard's card grid, shown full-screen over
 * everything — the same shape as ArchivedPageOverlay, so opening an idea feels
 * identical to reopening an archived page. The difference is ownership: ideas are
 * server cards authored by Claude, so the page is READ-ONLY (no caret, no edits,
 * nothing to persist). The body — the "## Problem / ## Idea / ## Project plan /
 * ## Next steps" template — renders through the very same NotePage editor the pad
 * uses, so the Markdown looks exactly as it does on an archived page. The header
 * carries the kind, title, priority, and the idea's tags.
 */
export default function IdeaPageOverlay({ card, width, onClose }: IdeaPageOverlayProps) {
  const insets = useSafeAreaInsets();
  const colors = useTheme();
  const p = prio(card.priority);
  const tags = card.tags ?? [];
  const kindLabel = card.kind === 'idea' ? 'Idea' : card.kind;

  // The card presented as a Note so the shared editor can render its Markdown body.
  // Timestamps are best-effort (0 when absent) — read-only, so they're never written.
  const note: Note = {
    id: card.id,
    content: card.body ?? '',
    title: card.title,
    createdAt: Date.parse(card.created_at ?? '') || 0,
    updatedAt: Date.parse(card.updated_at ?? '') || 0,
  };

  return (
    <Modal visible animationType="slide" statusBarTranslucent onRequestClose={onClose}>
      <View
        className="flex-1 bg-background"
        style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}>
        {/* Header: back to the dashboard, the kind + title, and a priority pill. */}
        <View className="flex-row items-center px-3 pb-2 pt-1">
          <Pressable
            onPress={onClose}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Back to dashboard"
            className="mr-1 h-9 w-9 items-center justify-center rounded-full active:bg-surface">
            <ChevronLeft size={24} color={colors.text} strokeWidth={2} />
          </Pressable>
          <View className="flex-1 pr-2">
            <Text className="text-[11px] font-bold uppercase tracking-wider text-faint">
              {kindLabel}
            </Text>
            <Text numberOfLines={1} className="text-lg font-bold text-text">
              {card.title}
            </Text>
          </View>
          <View className={`flex-row items-center gap-1 rounded-full px-2.5 py-1 ${p.chip}`}>
            <View className={`h-1.5 w-1.5 rounded-full ${p.pip}`} />
            <Text className={`text-[10px] font-bold uppercase tracking-wide ${p.text}`}>
              {p.label}
            </Text>
          </View>
        </View>

        {/* Tags, when present — the same chips as the card, reading under the title. */}
        {tags.length > 0 && (
          <View className="flex-row flex-wrap items-center gap-1.5 px-3 pb-2">
            {tags.map(t => (
              <View
                key={t}
                className="flex-row items-center rounded-full bg-surface1/60 px-2 py-0.5">
                <Text className="text-[10px] font-bold text-faint">#</Text>
                <Text className="text-[10px] font-semibold text-muted">{t}</Text>
              </View>
            ))}
          </View>
        )}

        <NotePage
          note={note}
          width={width}
          isActive
          readOnly
          onChangeContent={noop}
          onSetTitle={noop}
          onIngested={noop}
          notebookId={card.source ?? ''}
        />
      </View>
    </Modal>
  );
}
