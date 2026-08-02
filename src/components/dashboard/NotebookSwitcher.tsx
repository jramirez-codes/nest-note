import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import {
  Check,
  ChevronDown,
  Folder,
  Layers,
  PenLine,
  Search,
  Trash2,
  type LucideIcon,
} from 'lucide-react-native';
import ConfirmDialog from '../modals/ConfirmDialog';
import { mocha } from '../../theme/catppuccin';
import type { ThemeColors } from '../../theme/colors';

/**
 * One entry in the notebook picker. `key` is 'all' (the roll-up), 'sandbox' (the
 * single local pad), or a subject slug. `tasks` is the open task count that
 * notebook owns, shown inline so the list itself reads as a map of the world.
 */
export interface NotebookOption {
  key: string;
  label: string;
  summary?: string;
  kind: 'all' | 'local' | 'server';
  tasks: number;
}

const nbIcon = (kind: NotebookOption['kind']): LucideIcon =>
  kind === 'all' ? Layers : kind === 'local' ? PenLine : Folder;

// A one-line summary of what a notebook holds, e.g. "2 tasks", falling back to
// the subject's own summary (or a hint for the special entries).
function nbSubtitle(o: NotebookOption): string {
  if (o.tasks) return `${o.tasks} task${o.tasks === 1 ? '' : 's'}`;
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

// How far a notebook row slides aside to park its delete action open, and how far
// the finger has to travel before releasing commits to that open position (rather
// than springing the row shut again).
const DELETE_WIDTH = 88;
const OPEN_THRESHOLD = DELETE_WIDTH / 2;

/**
 * Wraps one notebook row in a horizontal swipe that reveals a Delete action parked
 * behind its right edge — the same drag-to-destroy idiom the dashboard's cards use,
 * scaled down to a list row. The row itself is opaque and rides over the action, so
 * the action only shows as far as the row has been pulled aside.
 *
 * `open` is owned by the list rather than the row, so only one row can sit open at a
 * time and closing the menu resets them all; a swipe past the threshold asks for it
 * via `onOpenChange`, which takes `rowKey` so one stable callback serves every row —
 * the list re-renders on every keystroke in its search field, and a fresh callback
 * per render would rebuild these gestures out from under a finger. The gesture only
 * activates after a deliberate horizontal drag (and fails outright on a vertical one)
 * so scrolling the notebook list still works.
 */
function SwipeableRow({
  rowKey,
  open,
  onOpenChange,
  onDelete,
  children,
}: {
  rowKey: string;
  open: boolean;
  onOpenChange: (key: string, open: boolean) => void;
  onDelete: () => void;
  children: React.ReactNode;
}) {
  const tx = useSharedValue(0);
  const start = useSharedValue(0);

  // The list closes rows by flipping `open`; follow it here so a row shut by a tap
  // elsewhere animates back rather than snapping.
  useEffect(() => {
    if (!open) tx.value = withTiming(0, { duration: 160 });
  }, [open, tx]);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-12, 12])
        .failOffsetY([-10, 10])
        .onStart(() => {
          start.value = tx.value;
        })
        .onUpdate(e => {
          // Left-only: the row never pulls past its resting position to the right.
          tx.value = Math.min(0, Math.max(-DELETE_WIDTH, start.value + e.translationX));
        })
        .onEnd(() => {
          const shouldOpen = tx.value < -OPEN_THRESHOLD;
          tx.value = withTiming(shouldOpen ? -DELETE_WIDTH : 0, { duration: 160 });
          runOnJS(onOpenChange)(rowKey, shouldOpen);
        }),
    [onOpenChange, rowKey, start, tx],
  );

  const rowStyle = useAnimatedStyle(() => ({ transform: [{ translateX: tx.value }] }));

  return (
    <View collapsable={false}>
      {/* Parked behind the row, revealed only by the row sliding off it. */}
      <View style={styles.deleteAction} className="absolute bottom-0 right-0 top-0">
        <Pressable
          onPress={onDelete}
          accessibilityRole="button"
          accessibilityLabel="Delete notebook"
          className="h-full w-full items-center justify-center bg-danger active:opacity-80">
          <Trash2 size={16} color={mocha.crust} strokeWidth={2} />
          <Text className="mt-0.5 text-[10px] font-semibold text-crust">Delete</Text>
        </Pressable>
      </View>
      <GestureDetector gesture={pan}>
        <Animated.View style={rowStyle} className="bg-surface">
          {children}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

/** Where the dropdown card floats — absolute window coords, computed by each trigger. */
interface MenuPosition {
  top: number;
  left: number;
  width: number;
}

/**
 * The floating dropdown shared by both triggers (the dashboard's full switcher and
 * the header's compact badge): a search field that autocompletes the notebook list,
 * over a full-screen scrim that dismisses on an outside tap. Anchored at `position`
 * (window coords) inside a transparent Modal so it floats over scrolling content and
 * gets native keyboard handling. Positioning is left to the caller so the same menu
 * can hang left-aligned under a wide control or right-aligned under a small badge.
 *
 * When `onDelete` is given, subject notebooks swipe aside to reveal a delete action;
 * confirming it hands the slug up and closes the menu (the list the caller passed is
 * stale the moment a notebook is gone). The Sandbox and the "all" roll-up never
 * swipe — neither is a thing on the server that could be deleted.
 */
function NotebookDropdown({
  visible,
  onClose,
  position,
  options,
  selected,
  onSelect,
  onDelete,
  colors,
}: {
  visible: boolean;
  onClose: () => void;
  position: MenuPosition;
  options: NotebookOption[];
  selected: NotebookOption;
  onSelect: (key: string) => void;
  onDelete?: (key: string) => void;
  colors: ThemeColors;
}) {
  const [query, setQuery] = useState('');
  // The one row currently swiped open, if any, and the notebook awaiting a delete
  // confirmation. Both are owned here so a second swipe closes the first row, and
  // so the confirm dialog can name the notebook it's about to destroy.
  const [swipedKey, setSwipedKey] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<NotebookOption | null>(null);

  // Start each opening from a clean search and no row left hanging open, so neither
  // a stale query nor a half-swiped row carries over from last time.
  useEffect(() => {
    if (visible) {
      setQuery('');
      setSwipedKey(null);
      setPendingDelete(null);
    }
  }, [visible]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(o => o.label.toLowerCase().includes(q));
  }, [options, query]);

  // Swiping a row open closes whichever one was open before; swiping it shut clears
  // the selection outright, so at most one delete action is ever armed.
  const handleRowOpenChange = useCallback((key: string, isOpen: boolean) => {
    setSwipedKey(isOpen ? key : null);
  }, []);

  const confirmDelete = useCallback(() => {
    if (pendingDelete) onDelete?.(pendingDelete.key);
    setPendingDelete(null);
    setSwipedKey(null);
    onClose();
  }, [onClose, onDelete, pendingDelete]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      {/* A Modal is its own view hierarchy, so the app's root gesture handler doesn't
          reach into it — the rows' swipe needs one in here. */}
      <GestureHandlerRootView style={styles.root}>
        {/* Full-screen scrim: a tap anywhere outside the card dismisses the menu. */}
        <Pressable className="flex-1" style={styles.scrim} onPress={onClose}>
          <View
            style={[
              styles.dropdownAnchor,
              { top: position.top, left: position.left, width: position.width },
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
                    const deletable = !!onDelete && o.kind === 'server';
                    const row = (
                      <Pressable
                        onPress={() => {
                          // A tap on a swiped-open row puts it back rather than
                          // swapping notebooks — the delete action is still armed.
                          if (swipedKey === o.key) {
                            setSwipedKey(null);
                            return;
                          }
                          onSelect(o.key);
                          onClose();
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
                    if (!deletable) return <View key={o.key}>{row}</View>;
                    return (
                      <SwipeableRow
                        key={o.key}
                        rowKey={o.key}
                        open={swipedKey === o.key}
                        onOpenChange={handleRowOpenChange}
                        onDelete={() => setPendingDelete(o)}>
                        {row}
                      </SwipeableRow>
                    );
                  })
                )}
              </ScrollView>
            </Pressable>
          </View>
        </Pressable>

        <ConfirmDialog
          visible={!!pendingDelete}
          title="Delete notebook?"
          message={`“${pendingDelete?.label ?? ''}” and all of its pages, notes and cards will be permanently deleted from the companion server. This can’t be undone.`}
          confirmLabel="Delete"
          destructive
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      </GestureHandlerRootView>
    </Modal>
  );
}

/**
 * The notebook picker pinned to the top of the dashboard: a tap-to-open control
 * showing the current notebook, and a dropdown with a search field that
 * autocompletes the notebook list as the user types. The dropdown is anchored
 * under the trigger (measured in window coords) so it floats cleanly over the
 * scrolling content and gets native keyboard handling.
 */
export function NotebookSwitcher({
  options,
  selected,
  onSelect,
  onDelete,
  colors,
}: {
  options: NotebookOption[];
  selected: NotebookOption;
  onSelect: (key: string) => void;
  /** Given, subject rows swipe to reveal a confirmed delete. Omitted, they don't. */
  onDelete?: (key: string) => void;
  colors: ThemeColors;
}) {
  const triggerRef = useRef<View>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<MenuPosition>({ top: 0, left: 0, width: 0 });

  const openMenu = useCallback(() => {
    triggerRef.current?.measureInWindow((x, y, width, height) => {
      // Left-aligned, matching the trigger's own width.
      setPosition({ top: y + height + 6, left: x, width });
      setOpen(true);
    });
  }, []);
  const close = useCallback(() => setOpen(false), []);

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

      <NotebookDropdown
        visible={open}
        onClose={close}
        position={position}
        options={options}
        selected={selected}
        onSelect={onSelect}
        onDelete={onDelete}
        colors={colors}
      />
    </>
  );
}

// The badge's dropdown is a fixed, comfortable width rather than the tiny pill's,
// clamped to the screen with this much breathing room on either edge.
const BADGE_MENU_WIDTH = 264;
const SCREEN_MARGIN = 12;

/**
 * A compact pill that names the current notebook and opens the same searchable
 * dropdown to swap it — the header's counterpart to the dashboard's full
 * NotebookSwitcher. Sized to sit inline in the page-title row (where the note
 * count used to be); its dropdown is right-aligned under the pill so a badge near
 * the screen's right edge never spills off it.
 */
export function NotebookBadge({
  options,
  selected,
  onSelect,
  onOpen,
  onDelete,
  colors,
}: {
  options: NotebookOption[];
  selected: NotebookOption;
  onSelect: (key: string) => void;
  /** Called as the menu opens, so the owner can refresh the notebook list first. */
  onOpen?: () => void;
  /** Given, subject rows swipe to reveal a confirmed delete. Omitted, they don't. */
  onDelete?: (key: string) => void;
  colors: ThemeColors;
}) {
  const triggerRef = useRef<View>(null);
  const { width: screenWidth } = useWindowDimensions();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<MenuPosition>({ top: 0, left: 0, width: BADGE_MENU_WIDTH });

  const openMenu = useCallback(() => {
    onOpen?.();
    triggerRef.current?.measureInWindow((x, y, width, height) => {
      const menuWidth = Math.min(BADGE_MENU_WIDTH, screenWidth - SCREEN_MARGIN * 2);
      // Right-align the menu's right edge to the pill's, then clamp inside the screen.
      const rightAligned = x + width - menuWidth;
      const left = Math.max(
        SCREEN_MARGIN,
        Math.min(rightAligned, screenWidth - menuWidth - SCREEN_MARGIN),
      );
      setPosition({ top: y + height + 6, left, width: menuWidth });
      setOpen(true);
    });
  }, [onOpen, screenWidth]);
  const close = useCallback(() => setOpen(false), []);

  const TriggerIcon = nbIcon(selected.kind);

  return (
    <>
      <Pressable
        ref={triggerRef}
        onPress={openMenu}
        accessibilityRole="button"
        accessibilityLabel={`Notebook: ${selected.label}. Tap to switch notebooks.`}
        hitSlop={6}
        className="max-w-[168px] flex-row items-center gap-1.5 rounded-full border border-surface1 bg-surface py-1 pl-2.5 pr-2 active:opacity-80">
        <TriggerIcon size={12} color={colors.accent} strokeWidth={2.25} />
        <Text numberOfLines={1} className="shrink text-xs font-semibold text-text">
          {selected.label}
        </Text>
        <ChevronDown size={13} color={colors.faint} strokeWidth={2.25} />
      </Pressable>

      <NotebookDropdown
        visible={open}
        onClose={close}
        position={position}
        options={options}
        selected={selected}
        onSelect={onSelect}
        onDelete={onDelete}
        colors={colors}
      />
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scrim: { backgroundColor: 'rgba(0,0,0,0.45)' },
  dropdownAnchor: { position: 'absolute' },
  dropdownList: { maxHeight: 320 },
  dropdownListContent: { paddingVertical: 4 },
  deleteAction: { width: DELETE_WIDTH },
});
