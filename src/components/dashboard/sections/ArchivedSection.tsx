/**
 * The Archived section: pages lifted off the pad by /archive, shown as one cohesive
 * card (search header, fixed-height row list, pager footer — see ArchivedList).
 * Owns its own page + search-query state; the caller just hands down the full
 * archive and the open callback. Local-pad only, so it's mounted for the Sandbox
 * notebook alone — swapping away unmounts it, which naturally clears its state.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { Archive } from 'lucide-react-native';
import type { ThemeColors } from '../../../theme/colors';
import type { Note } from '../../../types/note';
import { ARCHIVE_PAGE_SIZE } from '../cardModel';
import { ArchivedList, SectionHeader } from '../DashboardCards';

function ArchivedSection({
  archivedPages,
  onOpenArchived,
  colors,
}: {
  /** The local pad's archived pages, unfiltered (the section filters + paginates). */
  archivedPages: Note[];
  onOpenArchived: (note: Note) => void;
  colors: ThemeColors;
}) {
  const [archivePage, setArchivePage] = useState(0);
  const [archiveQuery, setArchiveQuery] = useState('');

  // Filter by title/body, client-side. The count on the header stays the full
  // archive size (not the filtered set) so a query that matches nothing still shows
  // the section — the empty state lives inside the fixed-height body.
  const archiveQ = archiveQuery.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      archiveQ
        ? archivedPages.filter(
            p =>
              p.title.toLowerCase().includes(archiveQ) ||
              p.content.toLowerCase().includes(archiveQ),
          )
        : archivedPages,
    [archivedPages, archiveQ],
  );

  const pageCount = Math.max(1, Math.ceil(filtered.length / ARCHIVE_PAGE_SIZE));
  // Clamp rather than resync via effect (matches the Tasks pager): avoids a stale-page
  // flash when deleting the last page on the last archive page shrinks the list.
  const safePage = Math.min(archivePage, pageCount - 1);
  const paged = filtered.slice(
    safePage * ARCHIVE_PAGE_SIZE,
    safePage * ARCHIVE_PAGE_SIZE + ARCHIVE_PAGE_SIZE,
  );

  // Any change to the query jumps back to the first page of results.
  useEffect(() => setArchivePage(0), [archiveQuery]);

  return (
    <View className="mb-6">
      <SectionHeader
        icon={Archive}
        title="Archived"
        count={archivedPages.length}
        colors={colors}
      />
      {/* One cohesive card: the search field is its header, the filtered/paginated
          rows its body, and the pager its footer. */}
      <ArchivedList
        pages={paged}
        onOpen={onOpenArchived}
        colors={colors}
        page={safePage}
        pageCount={pageCount}
        pageSize={ARCHIVE_PAGE_SIZE}
        onChangePage={setArchivePage}
        query={archiveQuery}
        onQueryChange={setArchiveQuery}
      />
    </View>
  );
}

export default React.memo(ArchivedSection);
