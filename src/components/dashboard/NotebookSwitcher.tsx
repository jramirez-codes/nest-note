import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  Check,
  ChevronDown,
  Folder,
  Layers,
  PenLine,
  Search,
  type LucideIcon,
} from 'lucide-react-native';
import type { ThemeColors } from '../../theme/colors';

/**
 * One entry in the notebook picker. `key` is 'all' (the roll-up), 'sandbox' (the
 * single local pad), or a subject slug. Counts are the open tasks + notifications
 * that notebook owns, shown inline so the list itself reads as a map of the world.
 */
export interface NotebookOption {
  key: string;
  label: string;
  summary?: string;
  kind: 'all' | 'local' | 'server';
  tasks: number;
  notifs: number;
}

const nbIcon = (kind: NotebookOption['kind']): LucideIcon =>
  kind === 'all' ? Layers : kind === 'local' ? PenLine : Folder;

// A one-line summary of what a notebook holds, e.g. "2 tasks · 1 alert", falling
// back to the subject's own summary (or a hint for the special entries).
function nbSubtitle(o: NotebookOption): string {
  const parts: string[] = [];
  if (o.tasks) parts.push(`${o.tasks} task${o.tasks === 1 ? '' : 's'}`);
  if (o.notifs) parts.push(`${o.notifs} alert${o.notifs === 1 ? '' : 's'}`);
  if (parts.length) return parts.join(' · ');
  if (o.kind === 'local') return 'Local scratch pad';
  if (o.kind === 'all') return 'Everything filed';
  return o.summary || 'No open items';
}

// Renders a label with the typed query substring highlighted in the accent color,
// so the autocomplete visibly matches what the user typed.
function HighlightedLabel({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) {
    return (
      <Text className="text-sm font-semibold text-text" numberOfLines={1}>
        {text}
      </Text>
    );
  }
  return (
    <Text className="text-sm font-semibold text-text" numberOfLines={1}>
      {text.slice(0, i)}
      <Text className="text-accent">{text.slice(i, i + q.length)}</Text>
      {text.slice(i + q.length)}
    </Text>
  );
}

/**
 * The notebook picker pinned to the top of the dashboard: a tap-to-open control
 * showing the current notebook, and a dropdown with a search field that
 * autocompletes the notebook list as the user types. The dropdown is anchored
 * under the trigger (measured in window coords) inside a transparent Modal, so it
 * floats cleanly over the scrolling content and gets native keyboard handling.
 */
export function NotebookSwitcher({
  options,
  selected,
  onSelect,
  colors,
}: {
  options: NotebookOption[];
  selected: NotebookOption;
  onSelect: (key: string) => void;
  colors: ThemeColors;
}) {
  const triggerRef = useRef<View>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [anchor, setAnchor] = useState({ x: 0, y: 0, width: 0, height: 0 });

  const openMenu = useCallback(() => {
    triggerRef.current?.measureInWindow((x, y, width, height) => {
      setAnchor({ x, y, width, height });
      setQuery('');
      setOpen(true);
    });
  }, []);
  const close = useCallback(() => setOpen(false), []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(o => o.label.toLowerCase().includes(q));
  }, [options, query]);

  const TriggerIcon = nbIcon(selected.kind);

  return (
    <>
      <Pressable
        ref={triggerRef}
        onPress={openMenu}
        accessibilityRole="button"
        accessibilityLabel={`Notebook: ${selected.label}`}
        className="flex-row items-center rounded-2xl border border-surface1 bg-surface px-3.5 py-3 active:opacity-80">
        <View className="mr-3 h-9 w-9 items-center justify-center rounded-xl bg-accent/20">
          <TriggerIcon size={18} color={colors.accent} strokeWidth={2} />
        </View>
        <View className="flex-1 pr-2">
          <Text className="text-base font-bold text-text" numberOfLines={1}>
            {selected.label}
          </Text>
          <Text className="mt-0.5 text-xs text-muted" numberOfLines={1}>
            {nbSubtitle(selected)}
          </Text>
        </View>
        <ChevronDown size={20} color={colors.faint} strokeWidth={2} />
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={close} statusBarTranslucent>
        {/* Full-screen scrim: a tap anywhere outside the card dismisses the menu. */}
        <Pressable className="flex-1" style={styles.scrim} onPress={close}>
          <View
            style={[
              styles.dropdownAnchor,
              { top: anchor.y + anchor.height + 6, left: anchor.x, width: anchor.width },
            ]}>
            {/* Inner Pressable swallows taps so they don't reach the scrim. */}
            <Pressable
              onPress={() => {}}
              className="overflow-hidden rounded-2xl border border-surface1 bg-surface">
              {/* Search field. */}
              <View className="flex-row items-center gap-2 border-b border-surface1 px-3 py-2.5">
                <Search size={16} color={colors.faint} strokeWidth={2} />
                <TextInput
                  autoFocus
                  value={query}
                  onChangeText={setQuery}
                  placeholder="Search notebooks…"
                  placeholderTextColor={colors.faint}
                  className="flex-1 p-0 text-sm text-text"
                  returnKeyType="done"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
              <ScrollView
                keyboardShouldPersistTaps="handled"
                style={styles.dropdownList}
                contentContainerStyle={styles.dropdownListContent}>
                {filtered.length === 0 ? (
                  <Text className="px-3 py-4 text-center text-sm text-muted">No notebooks match.</Text>
                ) : (
                  filtered.map(o => {
                    const RowIcon = nbIcon(o.kind);
                    const isSel = o.key === selected.key;
                    return (
                      <Pressable
                        key={o.key}
                        onPress={() => {
                          onSelect(o.key);
                          close();
                        }}
                        className="flex-row items-center px-2.5 py-2.5 active:bg-surface1/50">
                        <View className="mr-3 h-8 w-8 items-center justify-center rounded-lg bg-background">
                          <RowIcon size={16} color={isSel ? colors.accent : colors.muted} strokeWidth={2} />
                        </View>
                        <View className="flex-1 pr-2">
                          <HighlightedLabel text={o.label} query={query} />
                          <Text className="mt-0.5 text-xs text-muted" numberOfLines={1}>
                            {nbSubtitle(o)}
                          </Text>
                        </View>
                        {o.kind === 'local' && (
                          <View className="mr-2 rounded-full bg-overlay0/30 px-2 py-0.5">
                            <Text className="text-[10px] font-semibold uppercase tracking-wide text-muted">
                              Local
                            </Text>
                          </View>
                        )}
                        {isSel && <Check size={16} color={colors.accent} strokeWidth={2.5} />}
                      </Pressable>
                    );
                  })
                )}
              </ScrollView>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  scrim: { backgroundColor: 'rgba(0,0,0,0.45)' },
  dropdownAnchor: { position: 'absolute' },
  dropdownList: { maxHeight: 320 },
  dropdownListContent: { paddingVertical: 4 },
});
