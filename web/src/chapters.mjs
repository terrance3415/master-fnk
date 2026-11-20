/** Shot-change chapter marks from frame-to-frame differences. */

export function detectChapters(diffs, times, threshold = 0.18) {
  const chapters = [{ time: 0, title: "Scene 1" }];
  let last = 0;
  for (let i = 0; i < diffs.length; i++) {
    const time = times[i + 1] ?? times[i] ?? 0;
    if (diffs[i] >= threshold && time - last >= 0.4) {
      chapters.push({ time, title: `Scene ${chapters.length + 1}` });
      last = time;
    }
  }
  return chapters;
}

export function renameChapter(chapters, index, title) {
  return chapters.map((chapter, i) => (i === index ? { ...chapter, title: String(title || chapter.title).slice(0, 60) } : chapter));
}
