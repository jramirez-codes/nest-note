/**
 * A generic card grid for one non-task kind (ideas, and any future/unknown kind).
 * Cards are grouped by kind upstream and each group rendered through here, so a
 * brand-new kind appears immediately with no bespoke code — this is what keeps the
 * dashboard's card engine scalable.
 *
 * When a group carries tags (chiefly ideas), a horizontal tag-filter bar sits under
 * the header: tapping a tag narrows the grid to cards carrying it, tapping it again
 * (or "All") clears the filter. Filtering is purely client-side over the already-
 * loaded cards. Tapping a card opens it as a full read-only page via onOpenIdea.
 */
import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Lightbulb } from 'lucide-react-native';
import type { ThemeColors } from '../../../theme/colors';
import type { DashboardCard } from '../../../server/controllers/aiController';
import { cardHasTag, compareCards, humanizeKind, tagCounts } from '../cardModel';
import { type CardDragProps, DraggableCard, IdeaCard, SectionHeader } from '../DashboardCards';

function CardGridSection({
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

      <View className="flex-row flex-wrap justify-between">
        {group.map(card => (
          <DraggableCard key={card.id} card={card} {...dragProps}>
            <IdeaCard card={card} dimmed={liftedId === card.id} onPress={onOpenIdea} />
          </DraggableCard>
        ))}
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

export default React.memo(CardGridSection);
