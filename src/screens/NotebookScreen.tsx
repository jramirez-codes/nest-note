import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  type LayoutChangeEvent,
  Pressable,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/colors';
import DashboardPage from '../components/dashboard/DashboardPage';
import type { DashboardCard } from '../server/controllers/aiController';
import DeleteDragOverlay from '../components/modals/DeleteDragOverlay';
import ArchivedPageOverlay from '../components/notepage/ArchivedPageOverlay';
import IdeaPageOverlay from '../components/notepage/IdeaPageOverlay';
import NoteHeader from '../components/notepage/NoteHeader';
import NotePage from '../components/notepage/NotePage';
import PageIndicator from '../components/notepage/PageIndicator';
import PaperPager from '../components/notepage/PaperPager';
import type { PaperPagerHandle } from '../components/notepage/PaperPager';
import ServerStatusDot from '../components/ServerStatusDot';
import VirtualNotePage from '../components/notepage/VirtualNotePage';
import { NotebookBadge, type NotebookOption } from '../components/dashboard/NotebookSwitcher';
import { useArchivedPages } from '../hooks/useArchivedPages';
import { useCardDrag } from '../hooks/useCardDrag';
import { useDictation } from '../hooks/useDictation';
import { DEFAULT_NOTEBOOK_ID } from '../storage/db';
import { useNotes } from '../hooks/useNotes';
import { useNotebookOptions } from '../hooks/useNotebookOptions';
import { useNotebookPages } from '../hooks/useNotebookPages';
import type { NotePage as NotebookPageStub } from '../server/controllers/aiController';
import type { Note } from '../types/note';
import { fireAndForget } from '../utils/async';

// The Sandbox notebook is the local pad itself (editable notes + the aggregate dashboard);
// any other value is a subject slug whose pages are pulled from the server and virtualized.
const SANDBOX_KEY = 'sandbox';

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
  const {
    notes,
    isLoading,
    createNote,
    updateNoteContent,
    updateNoteTitle,
    deleteNote,
    dropNoteFromList,
  } = useNotes();

  // The local pad's archived pages (from `/archive`) plus the one currently opened
  // as a temporary page. Lives here (not in the dashboard) so the temporary page can
  // be presented full-screen over the whole pad. Archived pages belong to the local
  // notebook, so they're keyed off the default notebook regardless of which subject
  // is being read.
  const archive = useArchivedPages(DEFAULT_NOTEBOOK_ID);

  // A card (an idea) opened from the dashboard as a full read-only page, or null.
  // Lives here (like the archived page above) so it can be presented full-screen
  // over the whole pad.
  const [openIdea, setOpenIdea] = useState<DashboardCard | null>(null);

  // `/archive` fired on a pad note: the editor bridge already persisted the archived
  // copy, so just lift the note off the pad and refresh the dashboard's Archived list.
  const handleArchived = useCallback(
    (id: string) => {
      dropNoteFromList(id);
      archive.refresh();
    },
    [dropNoteFromList, archive],
  );

  // The notebook whose pages fill the pad: 'sandbox' (the local notes) or a subject slug
  // (its pages pulled from the server). The switcher on the dashboard sets this.
  const [selectedNb, setSelectedNb] = useState(SANDBOX_KEY);
  const subjectSlug = selectedNb === SANDBOX_KEY ? null : selectedNb;
  // Lazily-loaded pages for the selected subject notebook (empty in Sandbox mode). `ensure`
  // pulls a page + its neighbours; `bodies` holds whatever has been fetched so far.
  const { stubs, bodies, ensure, loading } = useNotebookPages(subjectSlug);

  // The notebook list + current entry for the header's switcher badge. `refresh` is
  // handed to the badge so it pulls a fresh list as its dropdown opens. When the list
  // hasn't loaded (or the selection isn't in it yet, e.g. a wikilink jumped to a
  // not-yet-fetched subject), fall back to a minimal entry so the badge still names
  // the current notebook.
  const { options: nbOptions, refresh: refreshNbOptions } = useNotebookOptions();
  const selectedNbOption = useMemo<NotebookOption>(
    () =>
      nbOptions.find(o => o.key === selectedNb) ?? {
        key: selectedNb,
        label: selectedNb === SANDBOX_KEY ? 'Sandbox' : selectedNb,
        kind: selectedNb === SANDBOX_KEY ? 'local' : 'server',
        tasks: 0,
      },
    [nbOptions, selectedNb],
  );

  const pagerRef = useRef<PaperPagerHandle>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  // True while the current page has an AI card expanded into its full-page
  // overlay (e.g. an expanded /chat, /run, /code or /view card). That overlay
  // fills the WebView with its own footer composer, so the bottom bubble strip
  // (which floats on top of the WebView) is hidden while it's up — otherwise it
  // sits over the composer's text input and blocks it. Reset on every page
  // change: a freshly shown page never starts with an overlay open, and the
  // outgoing page's WebView may unmount before it gets a chance to say so.
  const [widgetExpanded, setWidgetExpanded] = useState(false);
  useEffect(() => setWidgetExpanded(false), [currentIndex]);
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
  // Set when a notebook swap is made while the user is on the dashboard, so the
  // swap effects below keep them on the dashboard of the new notebook rather than
  // dropping them on its opening page. Cleared once the new notebook has settled.
  const swapFromDashboardRef = useRef(false);
  // Whether we've seen the swapped-to subject's index actually begin loading. The
  // hook's `loading` flag lags a render (it flips inside the hook's own effect), so
  // a subject reads `loading === false` for one render right after the swap — we must
  // wait until we've observed the load start before treating a `false` as "settled".
  const swapLoadSeenRef = useRef(false);

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

  // Footer speech-to-text. The mic dictates into the on-screen note, so it's
  // disabled with nowhere to write: on the trailing dashboard, or on a subject
  // notebook (whose pages are read-only server pulls). Auto-stop if the user
  // navigates onto one of those while the mic is live.
  // The footer's Delete / New line buttons replace the two nav bubbles while the mic
  // is live, editing the note being dictated into without stopping the recognizer.
  const {
    dictating,
    toggle: toggleDictation,
    stop: stopDictation,
    backspace: dictationBackspace,
    newline: dictationNewline,
  } = useDictation();
  const onDashboard = currentIndex >= contentCount;
  const dictationDisabled = onDashboard || !!subjectSlug;
  useEffect(() => {
    if (dictationDisabled && dictating) stopDictation();
  }, [dictationDisabled, dictating, stopDictation]);

  // Swapping notebooks while reading a page drops the reader on the new notebook's opening
  // page (its Appendix / table of contents) rather than a stale index. While a subject's
  // index is still loading, page 0 is the dashboard, which then becomes the Appendix once
  // the stubs arrive — no second flip needed. A swap made *from* the dashboard is the
  // exception: it keeps the reader on the dashboard (handled by the settle effect below),
  // so skip the reset here in that case.
  useEffect(() => {
    if (swapFromDashboardRef.current) return;
    pagerRef.current?.flipTo(0);
  }, [selectedNb]);

  // Finish a swap made from the dashboard: keep the reader pinned to the trailing dashboard
  // page of the new notebook until its pages have settled. A subject's index loads async, so
  // the dashboard sits alone at page 0 momentarily, then moves to the end as the stubs
  // arrive — re-flip to the last page each time the count changes, and release the pin once
  // the index has loaded (or at once, in the synchronous Sandbox).
  useEffect(() => {
    if (!swapFromDashboardRef.current) return;
    pagerRef.current?.flipTo(pages.length - 1);
    // Sandbox settles synchronously; a subject settles once its index has loaded —
    // loading goes false → true → false, and the flag lags a render, so only count a
    // `false` as done after we've actually seen the load begin (see swapLoadSeenRef).
    if (loading) swapLoadSeenRef.current = true;
    if (!subjectSlug || (swapLoadSeenRef.current && !loading)) {
      swapFromDashboardRef.current = false;
    }
  }, [subjectSlug, loading, pages.length]);

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

  // Swap the notebook filling the pad. If the user is on the dashboard (its trailing page)
  // when they pick a new notebook, note that so the swap effects keep them on the dashboard
  // of the new one; a swap made while reading a page turns to that notebook's opening page.
  const selectNotebook = useCallback(
    (key: string) => {
      if (key === selectedNb) return;
      swapFromDashboardRef.current = pages[currentIndexRef.current]?.kind === 'dashboard';
      swapLoadSeenRef.current = false;
      setSelectedNb(key);
    },
    [selectedNb, pages],
  );

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
            archivedPages={archive.archived}
            onOpenArchived={archive.openArchived}
            onOpenIdea={setOpenIdea}
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
            onWidgetExpandChange={setWidgetExpanded}
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
          onArchived={handleArchived}
          onOpenPage={handleOpenPage}
          onWidgetExpandChange={setWidgetExpanded}
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
      handleArchived,
      handleOpenPage,
      drag.shared,
      drag.lift,
      drag.release,
      archive.archived,
      archive.openArchived,
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

  // Sandbox note titles are renamed in place by tapping the header title. Tracked by
  // note id (not a plain boolean) so a swipe away from the page being renamed is
  // detected below and commits the draft instead of silently dropping it. The draft
  // is mirrored into a ref so commitTitleEdit's identity stays stable across
  // keystrokes — otherwise it'd change every keystroke and re-fire the effect below.
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const titleDraftRef = useRef('');
  titleDraftRef.current = titleDraft;
  const commitTitleEdit = useCallback(() => {
    setEditingTitleId(current => {
      if (current) updateNoteTitle(current, titleDraftRef.current.trim());
      return null;
    });
  }, [updateNoteTitle]);
  useEffect(() => {
    if (editingTitleId && editingTitleId !== currentNote?.id) {
      commitTitleEdit();
    }
  }, [currentNote, editingTitleId, commitTitleEdit]);

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
            {currentNote && editingTitleId === currentNote.id ? (
              <TextInput
                autoFocus
                value={titleDraft}
                onChangeText={setTitleDraft}
                onSubmitEditing={commitTitleEdit}
                onBlur={commitTitleEdit}
                placeholder={`Smart Note #${currentIndex + 1}`}
                placeholderTextColor={colors.faint}
                returnKeyType="done"
                selectTextOnFocus
                className="shrink p-0 text-xl font-bold text-text"
              />
            ) : (
              <Pressable
                disabled={!currentNote}
                onPress={() => {
                  if (!currentNote) return;
                  setTitleDraft(currentNote.title);
                  setEditingTitleId(currentNote.id);
                }}
                hitSlop={8}
                accessibilityRole={currentNote ? 'button' : undefined}
                accessibilityLabel={currentNote ? 'Edit note title' : undefined}
                className="shrink">
                <Text
                  numberOfLines={1}
                  ellipsizeMode="tail"
                  className="text-xl font-bold text-text">
                  {headerTitle}
                </Text>
              </Pressable>
            )}
          </View>
          <NotebookBadge
            options={nbOptions}
            selected={selectedNbOption}
            onSelect={selectNotebook}
            onOpen={refreshNbOptions}
            colors={colors}
          />
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
          to the note except on the bubbles.

          Hidden entirely while a card is expanded into its full-page overlay:
          that overlay fills the WebView with its own footer composer, and this
          strip floats on top of the WebView, so left up it would sit over the
          composer's text input and block it. */}
      {!widgetExpanded && (
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
              dictating={dictating}
              dictationDisabled={dictationDisabled}
              onToggleDictation={toggleDictation}
              onBackspace={dictationBackspace}
              onNewline={dictationNewline}
            />
          </View>
        </View>
      )}

      {/* The drag-to-delete banner + floating card clone (presentational; fed the
          animated styles computed above). */}
      <DeleteDragOverlay
        bannerStyle={bannerStyle}
        bannerLabelStyle={bannerLabelStyle}
        cloneStyle={cloneStyle}
        card={drag.card}
      />

      {/* An archived page opened from the dashboard, shown full-screen over the pad.
          Its edits save straight to the archive as they're made, so closing it (Back
          or the header) just returns to the dashboard with changes persisted. */}
      {archive.open && (
        <ArchivedPageOverlay
          note={archive.open}
          width={width}
          notebookId={DEFAULT_NOTEBOOK_ID}
          onClose={archive.closeArchived}
          onChangeContent={archive.updateOpenContent}
          onSetTitle={archive.updateOpenTitle}
          onRemove={archive.deleteOpen}
          onOpenPage={(slug, title) => {
            archive.closeArchived();
            handleOpenPage(slug, title);
          }}
        />
      )}

      {/* A card (an idea) opened from the dashboard, shown full-screen and read-only
          over the pad — Claude owns the content, so it's viewed, not edited here. */}
      {openIdea && (
        <IdeaPageOverlay card={openIdea} width={width} onClose={() => setOpenIdea(null)} />
      )}
    </View>
  );
}
