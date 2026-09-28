/** Project only visible, explicitly selected rows; a thread and its latest message may overlap. */
export function selectedVisibleMessages<T extends { id: string }>(
  threads: ReadonlyArray<{ sectionLatestMessage: T }>,
  messages: readonly T[],
  selectedIds: ReadonlySet<string>
): T[] {
  if (selectedIds.size === 0) return [];

  const result: T[] = [];
  const seen = new Set<string>();
  const append = (message: T) => {
    if (!selectedIds.has(message.id) || seen.has(message.id)) return;
    seen.add(message.id);
    result.push(message);
  };
  for (const thread of threads) append(thread.sectionLatestMessage);
  for (const message of messages) append(message);
  return result;
}
