import { useCallback, useEffect, useState } from 'react';
import {
  deletePage,
  listArchivedPages,
  updatePage,
  updatePageTitle,
} from '../storage';
import type { Note } from '../types/note';
import { fireAndForget } from '../utils/async';

export interface UseArchivedPagesResult {
  /** The notebook's archived pages, most recently archived first. */
  archived: Note[];
  /** Reload the archived list from storage. */
  refresh: () => void;
  /** The archived page currently open as a temporary page, or null. */
  open: Note | null;
  /** Open an archived page as a temporary, editable page. */
  openArchived: (note: Note) => void;
  /** Close the temporary page. Edits are already saved; this reloads the list. */
  closeArchived: () => void;
  /** Persist an edit to the open archived page (content). */
  updateOpenContent: (id: string, content: string) => void;
  /** Persist a title edit to the open archived page. */
  updateOpenTitle: (id: string, title: string) => void;
  /** Permanently delete the open archived page and close it. */
  deleteOpen: () => void;
}

/**
 * Owns the dashboard's Archived section: the list of a notebook's archived
 * pages, plus the single archived page opened as a temporary editable page.
 *
 * An archived page is a normal `pages` row with `archived_at` set (see
 * `storage/pages`) — it's off the pad and reachable only here. Opening one
 * mounts the same editor the pad uses; edits save straight back to storage (so
 * "leaving saves changes" needs nothing extra), and closing reloads the list so
 * its title/preview reflect the edits.
 */
export function useArchivedPages(notebookId: string): UseArchivedPagesResult {
  const [archived, setArchived] = useState<Note[]>([]);
  const [open, setOpen] = useState<Note | null>(null);

  const refresh = useCallback(() => {
    listArchivedPages(notebookId)
      .then(setArchived)
      .catch(() => {});
  }, [notebookId]);

  useEffect(() => {
    let active = true;
    listArchivedPages(notebookId)
      .then(loaded => {
        if (active) setArchived(loaded);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [notebookId]);

  const openArchived = useCallback((note: Note) => setOpen(note), []);

  const closeArchived = useCallback(() => {
    setOpen(null);
    // The title/preview shown in the list may have changed while it was open.
    refresh();
  }, [refresh]);

  const updateOpenContent = useCallback((id: string, content: string) => {
    setOpen(prev => {
      if (!prev || prev.id !== id) return prev;
      const updated: Note = { ...prev, content, updatedAt: Date.now() };
      // updatePage leaves archived_at untouched, so the page stays archived.
      fireAndForget(updatePage(updated), 'save archived page');
      return updated;
    });
  }, []);

  const updateOpenTitle = useCallback((id: string, title: string) => {
    setOpen(prev => {
      if (!prev || prev.id !== id) return prev;
      fireAndForget(updatePageTitle(id, title), 'save archived title');
      return { ...prev, title };
    });
  }, []);

  const deleteOpen = useCallback(() => {
    setOpen(prev => {
      if (prev) {
        // Delete first, then reload — so the list never briefly re-lists the
        // page that was just removed.
        deletePage(prev.id).then(refresh).catch(refresh);
      }
      return null;
    });
  }, [refresh]);

  return {
    archived,
    refresh,
    open,
    openArchived,
    closeArchived,
    updateOpenContent,
    updateOpenTitle,
    deleteOpen,
  };
}
