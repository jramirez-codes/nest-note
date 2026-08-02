/**
 * A generic card list for one non-task kind (ideas, build steps, and any
 * future/unknown kind). Cards are grouped by kind upstream and each group rendered
 * through here, so a brand-new kind appears immediately with no bespoke code — this
 * is what keeps the dashboard's card engine scalable.
 *
 * The group renders exactly as the Tasks list does: a fixed-height, internally-
 * scrolling box holding IDEA_PAGE_SIZE rows with a pager beneath, so the section is
 * the same size whether the notebook holds six ideas or sixty rather than growing
 * without bound. The height is measured from the first row (so it tracks the live
 * font scale) and held even on a short last page, so the page doesn't resize as you
 * step through it. The pager is always mounted, down to a single card, so the card
 * reads the same whatever the notebook holds.
 *
 * When a group carries tags (chiefly ideas), a horizontal tag-filter bar sits under
 * the header: tapping a tag narrows the list to cards carrying it, tapping it again
 * (or "All") clears the filter. Filtering is purely client-side over the already-
 * loaded cards. Tapping a row opens that card as a full read-only page via
 * onOpenIdea — that page, not the row, is where a card's full text lives.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type LayoutChangeEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Lightbulb } from 'lucide-react-native';
import type { ThemeColors } from '../../../theme/colors';
import type { DashboardCard } from '../../../server/controllers/aiController';
import { cardHasTag, compareCards, humanizeKind, IDEA_PAGE_SIZE, tagCounts } from '../cardModel';
import {
  type CardDragProps,
  DraggableCard,
  IdeaRow,
  Pager,
  SectionHeader,
} from '../DashboardCards';

function CardListSection({
  kind,
  cards,
  dragProps,
  liftedId,
  colors,
  onOpenIdea,
}: {
  kind: string;
  /** The kind's cards, unsorted — the section applies the standard card sort. */
  cards: DashboardCard[];
  dragProps: CardDragProps;
  liftedId: string | null;
  colors: ThemeColors;
  /** Open a card as a full read-only page (see IdeaPageOverlay). */
  onOpenIdea?: (card: DashboardCard) => void;
}) {
  // The distinct tags across this group, most-used first — the filter bar's chips.
  const tags = useMemo(() => tagCounts(cards), [cards]);
  // The active tag filter, or null for "All". Cleared implicitly when the tag it
  // named disappears from the group (see the guard in the filtered memo below).
  const [activeTag, setActiveTag] = useState<string | null>(null);

  const group = useMemo(() => {
    const filtered =
      activeTag && tags.some(t => t.tag.toLowerCase() === activeTag.toLowerCase())
        ? cards.filter(c => cardHasTag(c, activeTag))
        : cards;
    return filtered.slice().sort(compareCards);
  }, [cards, tags, activeTag]);

  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(group.length / IDEA_PAGE_SIZE));
  // Clamp rather than resync via effect (matches the Tasks and Archived pagers):
  // avoids a stale-page flash when dismissing the last card on the last page.
  const safePage = Math.min(page, pageCount - 1);
  const paged = group.slice(safePage * IDEA_PAGE_SIZE, safePage * IDEA_PAGE_SIZE + IDEA_PAGE_SIZE);

  // One row's height, measured from the first row (the one with no divider above it)
  // so the fixed box height tracks the live font scale. Latched to the first
  // measurement, which every row in the group matches: IdeaRow draws a fixed number
  // of lines per kind — one for an idea, two for a build step (the idea's name and
  // the feature being validated) — and a group holds exactly one kind.
  const [rowHeight, setRowHeight] = useState<number | null>(null);
  const handleFirstRowLayout = useCallback((e: LayoutChangeEvent) => {
    // Read the height synchronously — the event is pooled and `e.nativeEvent` goes
    // null after this handler returns, but the setState updater below can run again
    // later (e.g. Strict Mode's double-invoke), so it must close over a plain number.
    const height = e.nativeEvent.layout.height;
    setRowHeight(prev => prev ?? height);
  }, []);

  // Any change to the filter deals a different set of cards, so start it at the
  // first page — an index into the old set means nothing against the new one.
  useEffect(() => setPage(0), [activeTag]);

  return (
    <View className="mb-6">
      <SectionHeader
        icon={Lightbulb}
        title={humanizeKind(kind)}
        count={group.length}
        colors={colors}
      />

      {tags.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.filterBar}>
          <FilterChip label="All" active={activeTag === null} onPress={() => setActiveTag(null)} />
          {tags.map(({ tag, count }) => (
            <FilterChip
              key={tag}
              label={tag}
              count={count}
              hash
              active={activeTag?.toLowerCase() === tag.toLowerCase()}
              onPress={() => setActiveTag(prev => (prev === tag ? null : tag))}
            />
          ))}
        </ScrollView>
      )}

      {/* One cohesive card: the rows are its body, the pager its footer. */}
      <View className="overflow-hidden rounded-2xl border border-surface1 bg-surface">
        <ScrollView
          nestedScrollEnabled
          scrollEnabled={!liftedId}
          style={
            // Fixed, not max — the box holds this height even when a page has fewer
            // than IDEA_PAGE_SIZE cards, so it doesn't resize page to page. +1px per
            // hairline divider between rows (there's none above the first row).
            rowHeight
              ? { height: rowHeight * IDEA_PAGE_SIZE + (IDEA_PAGE_SIZE - 1) }
              : undefined
          }>
          {paged.map((card, i) => (
            <View key={card.id} onLayout={i === 0 ? handleFirstRowLayout : undefined}>
              {i > 0 && <View className="ml-11 h-px bg-surface1/60" />}
              <DraggableCard card={card} {...dragProps}>
                <IdeaRow
                  card={card}
                  colors={colors}
                  dimmed={liftedId === card.id}
                  onPress={onOpenIdea}
                />
              </DraggableCard>
            </View>
          ))}
        </ScrollView>
        {/* Always mounted, even at a single page (unlike the Tasks pager, like the
            Archived one): these lists are the whole of the Ideas view, so the card
            keeps one shape — footer and all — however few cards are in it. */}
        <Pager
          page={safePage}
          pageCount={pageCount}
          onChange={setPage}
          colors={colors}
          alwaysShow
        />
      </View>
    </View>
  );
}

// One pill in the tag-filter bar: a selectable, optionally hashed label with a count.
// Active = filled accent; inactive = outlined surface, matching the rest of the pad.
function FilterChip({
  label,
  count,
  hash = false,
  active,
  onPress,
}: {
  label: string;
  count?: number;
  hash?: boolean;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      className={`flex-row items-center gap-1 rounded-full border px-3 py-1.5 ${
        active ? 'border-accent bg-accent' : 'border-surface1 bg-surface'
      }`}>
      {hash && (
        <Text className={`text-xs font-bold ${active ? 'text-background' : 'text-faint'}`}>#</Text>
      )}
      <Text className={`text-xs font-semibold ${active ? 'text-background' : 'text-muted'}`}>
        {label}
      </Text>
      {typeof count === 'number' && (
        <Text className={`text-[10px] font-bold ${active ? 'text-background/70' : 'text-faint'}`}>
          {count}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  filterBar: { gap: 8, paddingHorizontal: 2, paddingBottom: 12 },
});

export default React.memo(CardListSection);
