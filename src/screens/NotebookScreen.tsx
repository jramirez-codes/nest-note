import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  type LayoutChangeEvent,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { Trash2 } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/colors';
import { mocha } from '../theme/catppuccin';
import DashboardPage from '../components/DashboardPage';
import NoteHeader from '../components/NoteHeader';
import NotePage from '../components/NotePage';
import PageIndicator from '../components/PageIndicator';
import PaperPager from '../components/PaperPager';
import type { PaperPagerHandle } from '../components/PaperPager';
import ServerStatusDot from '../components/ServerStatusDot';
import { useCardDrag } from '../components/cardDrag';
import { useNotes } from '../hooks/useNotes';
import type { Note } from '../types/note';
import { fireAndForget } from '../utils/async';

// Priority → pip color for the floating drag clone (kept tiny to avoid importing
// the dashboard's full palette map).
const PIP_CLASS: Record<string, string> = {
  urgent: 'bg-red',
  high: 'bg-peach',
  normal: 'bg-blue',
  low: 'bg-overlay0',
};

/**
 * A page in the pager is either an existing note or the trailing dashboard.
 * Modeling it as a discriminated union keeps `renderItem` exhaustive.
 */
type Page = { kind: 'note'; note: Note } | { kind: 'dashboard' };

const DASHBOARD_PAGE_KEY = '__dashboard__';

/**
 * The notebook: a horizontally paged pad the user flips through, one note per
 * page, with a permanent blank sheet at the end for adding notes.
 */
export default function NotebookScreen() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const colors = useTheme();
  const { notes, isLoading, createNote, updateNoteContent, updateNoteTitle, deleteNote } =
    useNotes();

  const pagerRef = useRef<PaperPagerHandle>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  // The page we were on before the current one — a tap on the progress bubble
  // returns here, so e.g. Dashboard → tap bubble jumps back to the note you left.
  const prevIndexRef = useRef(0);
  const handleIndexChange = useCallback((next: number) => {
    setCurrentIndex(prev => {
      if (next !== prev) prevIndexRef.current = prev;
      return next;
    });
  }, []);
  // Set when the user adds a note, so the effect below flips to the new page
  // once it has been committed to the list.
  const pendingFlipToNewNote = useRef(false);

  // Drag-to-delete: shared values written by the dashboard's card gesture, read by
  // the header (the delete target) and the floating clone rendered here at the top
  // level so it can travel over the header (the pager clips its own children).
  const drag = useCardDrag();
  const rootRef = useRef<View>(null);
  const headerRef = useRef<View>(null);
  const { rootX, rootY, headerBottomY, headerHeight } = drag.shared;
  // The header bar's top edge in this view's local (root-relative) coordinate
  // space — the exact space an absolutely-positioned child uses. Read straight
  // from the header wrapper's onLayout so the banner never has to reconstruct it
  // from window measurements and insets.
  const headerTop = useSharedValue(0);
  const measureRoot = useCallback(() => {
    rootRef.current?.measureInWindow((x, y) => {
      rootX.value = x;
      rootY.value = y;
    });
  }, [rootX, rootY]);
  // measureInWindow gives the gesture the header's bottom edge in window space,
  // which it compares against the finger's absolute position to detect a drop.
  const measureHeader = useCallback(() => {
    headerRef.current?.measureInWindow((_x, y, _w, h) => {
      headerBottomY.value = y + h;
    });
  }, [headerBottomY]);
  // onLayout on the header wrapper gives its position and size relative to the
  // root — the banner's own coordinate space — so it overlays the bar exactly.
  const handleHeaderLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const { y, height } = e.nativeEvent.layout;
      headerTop.value = y;
      headerHeight.value = height;
    },
    [headerTop, headerHeight],
  );

  const cloneStyle = useAnimatedStyle(() => ({
    opacity: drag.shared.active.value,
    transform: [
      { translateX: drag.shared.dragX.value - drag.shared.rootX.value - 24 },
      { translateY: drag.shared.dragY.value - drag.shared.rootY.value - 24 },
    ],
  }));

  // Smooth the 0/1 drag flags so the top chrome cross-fades into the delete banner
  // rather than snapping, giving a gradual background→red transition.
  const { active, overDelete } = drag.shared;
  const smoothActive = useDerivedValue(() => withTiming(active.value, { duration: 160 }));
  const smoothOver = useDerivedValue(() => withTiming(overDelete.value, { duration: 120 }));

  // The normal top chrome (title row + header) fades out while a card is dragged.
  const chromeFadeStyle = useAnimatedStyle(() => ({ opacity: 1 - smoothActive.value }));
  // The red delete banner reaches the screen's physical top edge (up through the
  // status-bar / notch area, hence the negative top) and its bottom lands exactly
  // on the header bar's bottom. The height therefore spans the inset plus the
  // header's measured top and height, so the bottom stays glued to the header.
  const bannerStyle = useAnimatedStyle(() => ({
    top: -insets.top,
    height: insets.top + headerTop.value + headerHeight.value,
    opacity: smoothActive.value,
  }));
  // The trash + label pop a little as the finger lands on the header.
  const bannerLabelStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + smoothOver.value * 0.08 }],
  }));

  const pages = useMemo<Page[]>(
    () => [
      ...notes.map(note => ({ kind: 'note' as const, note })),
      { kind: 'dashboard' as const },
    ],
    [notes],
  );

  const handleCreate = useCallback(() => {
    pendingFlipToNewNote.current = true;
    fireAndForget(createNote(), 'create note');
  }, [createNote]);

  // Flip to the trailing dashboard page (the last page).
  const goToDashboard = useCallback(() => {
    pagerRef.current?.flipTo(notes.length);
  }, [notes.length]);

  // Jump straight to a note page as the user scrubs the progress bubble.
  const handleScrub = useCallback((index: number) => {
    pagerRef.current?.flipTo(index);
  }, []);

  // Tap on the progress bubble: flip back to the previously-viewed page, clamped
  // in case notes were deleted since. Acts as a toggle between the last two pages.
  const goToPreviousPage = useCallback(() => {
    const target = Math.min(prevIndexRef.current, pages.length - 1);
    pagerRef.current?.flipTo(Math.max(0, target));
  }, [pages.length]);

  // After a create commits, flip to the freshly added note. Notes are sorted
  // newest-first, so the new note is page 0.
  useEffect(() => {
    if (pendingFlipToNewNote.current && notes.length > 0) {
      pendingFlipToNewNote.current = false;
      pagerRef.current?.flipTo(0);
    }
  }, [notes.length]);

  const keyForIndex = useCallback(
    (index: number) => {
      const page = pages[index];
      return !page || page.kind === 'dashboard' ? DASHBOARD_PAGE_KEY : page.note.id;
    },
    [pages],
  );

  const renderPage = useCallback(
    (index: number, isActive: boolean) => {
      const page = pages[index];
      if (!page || page.kind === 'dashboard') {
        return (
          <DashboardPage
            width={width}
            isActive={isActive}
            dragShared={drag.shared}
            onLift={drag.lift}
            onRelease={drag.release}
          />
        );
      }
      return (
        <NotePage
          note={page.note}
          width={width}
          isActive={isActive}
          onChangeContent={updateNoteContent}
          onSetTitle={updateNoteTitle}
          onIngested={deleteNote}
        />
      );
    },
    [pages, width, updateNoteContent, updateNoteTitle, deleteNote, drag.shared, drag.lift, drag.release],
  );

  const currentPage = pages[currentIndex];
  const currentNote =
    currentPage && currentPage.kind === 'note' ? currentPage.note : null;

  // The pad header shows the current page's title. Untitled pages (no `/clean`
  // yet) fall back to their positional name, "Smart Note #<page number>".
  const headerTitle = currentNote
    ? currentNote.title.trim() || `Smart Note #${currentIndex + 1}`
    : 'Dashboard';

  return (
    <View
      ref={rootRef}
      onLayout={measureRoot}
      className="flex-1 bg-background"
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}>
      {/* Title row — part of the top chrome that fades out during a delete drag. */}
      <Animated.View style={chromeFadeStyle}>
        <View className="flex-row items-center justify-between px-6 pb-2 pt-1">
          <View className="flex-1 flex-row items-center pr-3">
            {/* Connection bubble: green when the companion server is reachable,
                red when not. items-center on the row keeps it centered on the
                title's cap height; it holds its width on the left while the title
                (shrink) ellipsizes to fit. */}
            <View className="mr-2">
              <ServerStatusDot />
            </View>
            <Text
              numberOfLines={1}
              ellipsizeMode="tail"
              className="shrink text-xl font-bold text-text">
              {headerTitle}
            </Text>
          </View>
          <Text className="text-xs text-faint">
            {notes.length} {notes.length === 1 ? 'note' : 'notes'}
          </Text>
        </View>
      </Animated.View>

      {isLoading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      ) : (
        <>
          {/* Header, also faded out during a drag; measured for the delete target. */}
          <Animated.View style={chromeFadeStyle} onLayout={handleHeaderLayout}>
            <View ref={headerRef} onLayout={measureHeader} collapsable={false}>
              <NoteHeader
                note={currentNote}
                pageNumber={currentIndex + 1}
                totalPages={notes.length}
                onDelete={deleteNote}
                onCreateNote={handleCreate}
              />
            </View>
          </Animated.View>
          <PaperPager
            ref={pagerRef}
            count={pages.length}
            width={width}
            keyForIndex={keyForIndex}
            renderPage={renderPage}
            onIndexChange={handleIndexChange}
          />
        </>
      )}

      {/* Floated over the content (not stacked below it) so the note fills the
          full height of the screen and the pad scrolls beneath the indicator.
          bottom-0 already clears the safe area — the parent's paddingBottom
          offsets absolute children in Yoga. box-none lets touches fall through
          to the note except on the bubbles. */}
      <View pointerEvents="box-none" className="absolute inset-x-0 bottom-0">
        {/* Fade the note out as it scrolls up toward the bubbles: transparent at
            the top → solid background where it meets the strip below, so text
            dissolves rather than butting against a hard edge. none so it never
            eats scroll gestures. */}
        <View
          pointerEvents="none"
          className="h-20"
          style={{
            experimental_backgroundImage: [
              {
                type: 'linear-gradient',
                direction: 'to bottom',
                colorStops: [
                  { color: 'transparent' },
                  { color: colors.background },
                ],
              },
            ],
          }}
        />
        {/* The bubbles sit on a solid background strip; pb lifts them up off the
            bottom edge (solid background fills below them). The gradient only
            lives above the strip. */}
        <View pointerEvents="box-none" className="bg-background pb-6">
          <PageIndicator
            currentIndex={currentIndex}
            prevIndex={prevIndexRef.current}
            noteCount={notes.length}
            onPressDashboard={goToDashboard}
            onPressProgress={goToPreviousPage}
            scrubWidth={width}
            onScrub={handleScrub}
          />
        </View>
      </View>

      {/* The red delete banner. Reaches the screen's top edge (through the
          status-bar / notch area) down to the header bar's bottom, fully covering
          the NoteHeader as the top chrome fades out — so the background→red
          transition is smooth. Touches fall through; the drop is detected by the
          card gesture, not this view. */}
      <Animated.View pointerEvents="none" style={[styles.deleteBanner, bannerStyle]}>
        <Animated.View style={[styles.deleteLabel, bannerLabelStyle]}>
          <Trash2 size={16} color={mocha.crust} strokeWidth={2.5} />
          <Text className="ml-2 text-xs font-bold uppercase tracking-wider text-crust">
            Release to delete
          </Text>
        </Animated.View>
      </Animated.View>

      {/* The floating clone of the card being dragged. Rendered last (top of the
          stack) so it travels over the header and footer; touches fall through. */}
      {drag.card && (
        <Animated.View pointerEvents="none" style={[styles.clone, cloneStyle]}>
          <View className="flex-row items-center gap-2 rounded-2xl border border-surface1 bg-surface px-3 py-2">
            <View className={`h-2 w-2 rounded-full ${PIP_CLASS[drag.card.priority] ?? 'bg-blue'}`} />
            <Text numberOfLines={1} className="max-w-[220px] text-sm font-semibold text-text">
              {drag.card.title}
            </Text>
          </View>
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // The drag clone floats above everything and is positioned by an animated
  // transform from window coordinates.
  clone: {
    position: 'absolute',
    top: 0,
    left: 0,
    zIndex: 50,
    elevation: 8,
  },
  // The red delete banner. `top` and `height` come from the animated style; it
  // reaches the screen's top edge but is bottom-aligned (with padding matching the
  // header's) so the label sits in the header band rather than up in the notch.
  deleteBanner: {
    position: 'absolute',
    left: 0,
    right: 0,
    backgroundColor: mocha.red,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 12,
    zIndex: 45,
    elevation: 7,
  },
  deleteLabel: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});
