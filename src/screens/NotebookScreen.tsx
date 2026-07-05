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
import VirtualNotePage from '../components/VirtualNotePage';
import { useCardDrag } from '../components/cardDrag';
import { DEFAULT_NOTEBOOK_ID } from '../storage/db';
import { useNotes } from '../hooks/useNotes';
import { useNotebookPages } from '../hooks/useNotebookPages';
import type { NotePage as NotebookPageStub } from '../server/aiController';
import type { Note } from '../types/note';
import { fireAndForget } from '../utils/async';

// The Sandbox notebook is the local pad itself (editable notes + the aggregate dashboard);
// any other value is a subject slug whose pages are pulled from the server and virtualized.
const SANDBOX_KEY = 'sandbox';

// Priority → pip color for the floating drag clone (kept tiny to avoid importing
// the dashboard's full palette map).
const PIP_CLASS: Record<string, string> = {
  urgent: 'bg-red',
  high: 'bg-peach',
  normal: 'bg-blue',
  low: 'bg-overlay0',
};

/**
 * A page in the pager is a local editable note (Sandbox), a virtual read-only page pulled
 * from a swapped-to subject notebook, or the trailing dashboard. Modeling it as a
 * discriminated union keeps `renderPage` exhaustive.
 */
type Page =
  | { kind: 'note'; note: Note }
  | { kind: 'virtual'; stub: NotebookPageStub }
  | { kind: 'dashboard' };

const DASHBOARD_PAGE_KEY = '__dashboard__';

// Normalize a page name for matching: a wikilink's inner `#N (Title)` against a page's
// `#N (Title).md` file name — trim, drop the `.md`, lowercase.
const norm = (s: string) => s.trim().replace(/\.md$/i, '').toLowerCase();

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

  // The notebook whose pages fill the pad: 'sandbox' (the local notes) or a subject slug
  // (its pages pulled from the server). The switcher on the dashboard sets this.
  const [selectedNb, setSelectedNb] = useState(SANDBOX_KEY);
  const subjectSlug = selectedNb === SANDBOX_KEY ? null : selectedNb;
  // Lazily-loaded pages for the selected subject notebook (empty in Sandbox mode). `ensure`
  // pulls a page + its neighbours; `bodies` holds whatever has been fetched so far.
  const { stubs, bodies, ensure } = useNotebookPages(subjectSlug);

  const pagerRef = useRef<PaperPagerHandle>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  // The page we were on before the current one — a tap on the progress bubble
  // returns here, so e.g. Dashboard → tap bubble jumps back to the note you left.
  // Tracked in refs (not derived inside a setState updater, which can run more
  // than once under concurrent rendering) so the previous index is deterministic.
  const currentIndexRef = useRef(0);
  const prevIndexRef = useRef(0);
  const handleIndexChange = useCallback((next: number) => {
    if (next !== currentIndexRef.current) {
      prevIndexRef.current = currentIndexRef.current;
      currentIndexRef.current = next;
    }
    setCurrentIndex(next);
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

  // In Sandbox the content pages are the local notes; in a subject they're the notebook's
  // virtual pages. The dashboard is always the trailing page, so the switcher stays reachable.
  const pages = useMemo<Page[]>(() => {
    const content: Page[] = subjectSlug
      ? stubs.map(stub => ({ kind: 'virtual' as const, stub }))
      : notes.map(note => ({ kind: 'note' as const, note }));
    return [...content, { kind: 'dashboard' as const }];
  }, [subjectSlug, stubs, notes]);

  // Number of content pages (excludes the trailing dashboard) for the chrome + scrubber.
  const contentCount = subjectSlug ? stubs.length : notes.length;

  // Swapping notebooks resets to the first page, so the reader lands on the new notebook's
  // opening page (its Appendix / table of contents) rather than a stale index. While a
  // subject's index is still loading, page 0 is the dashboard, which then becomes the
  // Appendix once the stubs arrive — no second flip needed.
  useEffect(() => {
    pagerRef.current?.flipTo(0);
  }, [selectedNb]);

  // Keep the current subject page and its immediate neighbours fetched, so a swipe lands on
  // content that's already in hand. (The first/last pages are warmed by the hook on swap.)
  useEffect(() => {
    if (!subjectSlug || stubs.length === 0) return;
    const nums: number[] = [];
    for (let i = currentIndex - 1; i <= currentIndex + 1; i++) {
      if (i >= 0 && i < stubs.length) nums.push(stubs[i].num);
    }
    if (nums.length > 0) ensure(nums);
  }, [subjectSlug, stubs, currentIndex, ensure]);

  const handleCreate = useCallback(() => {
    // A new note belongs to the local pad, so creating one returns to Sandbox.
    setSelectedNb(SANDBOX_KEY);
    pendingFlipToNewNote.current = true;
    fireAndForget(createNote(), 'create note');
  }, [createNote]);

  // Flip to the trailing dashboard page (always the last page, in either mode).
  const goToDashboard = useCallback(() => {
    pagerRef.current?.flipTo(pages.length - 1);
  }, [pages.length]);

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

  // A tapped wikilink asks to open a page by title. Bare `[[Title]]` resolves in the
  // current notebook; `[[slug::Title]]` switches notebooks first. Because a switched-to
  // subject's pages load async, the request is stashed and resolved by the effect below
  // once those pages are in hand.
  const pendingOpen = useRef<{ nb: string; title: string } | null>(null);

  // Flip to the content page a wikilink names. A wikilink's inner text is `#N (Title)`,
  // which matches a page's on-disk FILE name (`#N (Title).md`), not its display title — so
  // resolve subject pages against `file` (minus the extension). Local Sandbox notes have no
  // such file, so fall back to matching their title there. Returns whether a match was
  // found, so a pending cross-notebook open knows to stop waiting.
  const flipToPage = useCallback(
    (name: string): boolean => {
      const target = norm(name);
      if (!target) return false;
      const idx = pages.findIndex(p =>
        p.kind === 'virtual'
          ? norm(p.stub.file) === target
          : p.kind === 'note'
            ? norm(p.note.title) === target
            : false,
      );
      if (idx < 0) return false;
      pagerRef.current?.flipTo(idx);
      return true;
    },
    [pages],
  );

  const handleOpenPage = useCallback(
    (slug: string, title: string) => {
      // `slug` empty → stay in the current notebook; otherwise it names a subject notebook.
      const nb = slug || selectedNb;
      if (nb !== selectedNb) {
        // Switch notebooks; the effect below flips once the new pages have loaded.
        pendingOpen.current = { nb, title };
        setSelectedNb(nb);
        return;
      }
      flipToPage(title);
    },
    [selectedNb, flipToPage],
  );

  // Resolve a pending cross-notebook open once the switched-to notebook's pages arrive.
  // Drop it if the user has since navigated to a different notebook, so a never-found
  // title can't fire on an unrelated later swap.
  useEffect(() => {
    const pending = pendingOpen.current;
    if (!pending) return;
    if (pending.nb !== selectedNb) {
      pendingOpen.current = null;
    } else if (flipToPage(pending.title)) {
      pendingOpen.current = null;
    }
  }, [selectedNb, flipToPage]);

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
      if (!page || page.kind === 'dashboard') return DASHBOARD_PAGE_KEY;
      if (page.kind === 'virtual') return `v:${subjectSlug}:${page.stub.num}`;
      return page.note.id;
    },
    [pages, subjectSlug],
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
            selectedNb={selectedNb}
            onSelectNotebook={setSelectedNb}
          />
        );
      }
      if (page.kind === 'virtual') {
        return (
          <VirtualNotePage
            body={bodies[page.stub.num]}
            width={width}
            isActive={isActive}
            onOpenPage={handleOpenPage}
            notebookId={subjectSlug ?? SANDBOX_KEY}
            pageId={String(page.stub.num)}
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
          onOpenPage={handleOpenPage}
          notebookId={DEFAULT_NOTEBOOK_ID}
        />
      );
    },
    [
      pages,
      width,
      bodies,
      selectedNb,
      subjectSlug,
      updateNoteContent,
      updateNoteTitle,
      deleteNote,
      handleOpenPage,
      drag.shared,
      drag.lift,
      drag.release,
    ],
  );

  const currentPage = pages[currentIndex];
  const currentNote =
    currentPage && currentPage.kind === 'note' ? currentPage.note : null;
  const currentVirtual =
    currentPage && currentPage.kind === 'virtual' ? currentPage.stub : null;

  // The pad header shows the current page's title. Untitled local pages (no `/clean` yet)
  // fall back to "Smart Note #<n>"; virtual subject pages use their own page title.
  const headerTitle = currentNote
    ? currentNote.title.trim() || `Smart Note #${currentIndex + 1}`
    : currentVirtual
      ? currentVirtual.title || `Page ${currentIndex + 1}`
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
            {contentCount}{' '}
            {subjectSlug
              ? contentCount === 1
                ? 'page'
                : 'pages'
              : contentCount === 1
                ? 'note'
                : 'notes'}
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
                totalPages={contentCount}
                onDelete={deleteNote}
                onCreateNote={handleCreate}
                readOnlyTitle={currentVirtual ? currentVirtual.title : undefined}
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
            noteCount={contentCount}
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
